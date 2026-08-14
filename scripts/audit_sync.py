#!/usr/bin/env python3
"""Property-test the cross-device sync rule against the real engine.

Why this exists
---------------
`CLAUDE.md` makes two promises that meet at exactly one function:

    "Signing in is an *upgrade*. It mirrors the same profile to Postgres so it
     follows the player to another device. Conflicts resolve last-write-wins on
     `updatedAt`."

    "A child losing his album to a schema change is not an acceptable failure."

The second is equally true of losing it to a *sync*, and last-write-wins is a
rule with a sharp edge. `updatedAt` is written from a device clock, and the
loser of the comparison is discarded whole. So the question this script answers
is not "does reconcile compile" but "what can a seven-year-old lose".

The answer, when this script was first written, was: everything. The original
rule was one line - return whichever side parsed to the later `updatedAt` - and
the two scenarios below both destroyed real progress. Both are printed in the
report:

  * "touched, not played". Toggling the language on the laptop bumps
    `updatedAt` (`src/app/settings/page.tsx`) without earning anything. That
    laptop then beat an afternoon of offline play on the tablet, and the
    tablet's catches, badges and XP were gone at the next sync. No wrong clock
    is needed for this one - just a settings toggle.

  * a wrong clock. A device an hour or a day fast wins *every* comparison
    forever, so every session played on the other device is deleted on contact,
    repeatedly. `sync loops` below run eight rounds of alternating play and show
    the cumulative loss.

`reconcile` is now a merge: the things a child earned (the album, badges, the
lifetime counters, the best combo and best streak) are unioned or maxed, and
last-write-wins decides only the mutable state where one answer has to be
picked - name, starter, maths tier, the rolling attempt window, per-skill
stats, the current streak and the settings. See the WHY comment on `reconcile`
in `src/lib/game/progress.ts`.

How it runs the engine
----------------------
Nothing here reimplements a rule. The harness imports `reconcile`,
`normaliseProfile`, `createProfile` and `applyBattleResult` from
`src/lib/game/`, and `saveLocal`/`loadLocal`/`fetchSession`/`pushRemoteProfile`
from `src/lib/storage/`, and drives them as the app does: divergent profiles are
produced by *playing battles* through `applyBattleResult`, not by hand-editing
fields. The engine is pure TypeScript with no React, DOM or Node dependency, so
it is bundled with the repo's own esbuild and executed under plain node. This
mirrors `scripts/simulate_difficulty.py` and `scripts/balance_report.py`.

Nothing under `mobile/` is bundled: the root CI job does not install
`mobile/node_modules`, and reaching across that boundary has broken CI twice.
The iOS client shares this rule through `mobile/src/engine.ts`, so testing the
engine copy tests both clients.

Properties checked
------------------
P1 nothing-earned-is-lost      the merge is exactly the union of both albums,
                               both badge sets, and the maximum of every
                               lifetime counter and record. Nothing dropped and
                               nothing invented.
P2 order-does-not-matter       reconcile(a,b) equals reconcile(b,a) field for
                               field, and reconcile(x,x) is x itself.
P3 a-wrong-clock-loses-nothing sync loops with a device hours or days out of
                               step, in both directions, plus unreadable and
                               absent timestamps: the union of everything ever
                               earned survives every round.
P4 merge-output-is-storable    the merged profile survives `normaliseProfile`
                               and a JSON round-trip unchanged, so what is
                               written to localStorage, to Postgres and back is
                               what the merge decided.
P5 local-play-is-never-gated   the device save never waits on the network:
                               storage works with `fetch` undefined and with
                               `fetch` rejecting, and the client writes locally
                               before it talks to the server.

Determinism
-----------
Every profile is built from the engine's own seeded mulberry32 with literal
seeds, and every timestamp is computed from a literal epoch offset. There is no
wall-clock read and no unseeded randomness, so two runs on the same commit print
byte-identical output. Verify with:

    python3 scripts/audit_sync.py > /tmp/a
    python3 scripts/audit_sync.py > /tmp/b
    cmp /tmp/a /tmp/b

The one wall-clock value in reach is `normaliseProfile`'s fallback for an
unreadable date, so no repaired timestamp is ever printed - only the *names* of
the fields that changed.

Exit status
-----------
0  every property holds.
1  at least one property was violated; each violation is printed with the name
   of the property it broke.
2  the harness could not be built or run.

Note on shelling out: every subprocess is invoked with an explicit argv list and
its return code is checked directly. Nothing is piped through `head`/`tail`,
because a pipeline reports the exit status of its *last* command and that has
already hidden a real failure in this repo once.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ESBUILD = REPO_ROOT / "node_modules" / ".bin" / "esbuild"
PROGRESS_TS = REPO_ROOT / "src" / "lib" / "game" / "progress.ts"
CLIENT_TS = REPO_ROOT / "src" / "lib" / "storage" / "client.ts"
PROVIDER_TSX = REPO_ROOT / "src" / "components" / "GameProvider.tsx"

# Divergence corpus: how many independent seeds, and how far each side plays.
SEEDS = 8
SYNC_ROUNDS = 8

# Violations printed per property before the rest are counted. One broken merge
# breaks every case, and a wall of identical lines hides the second failure.
VIOLATIONS_SHOWN = 10

# The engine functions that must stay pure for both clients to answer a merge
# the same way. Checked by reading the source, not by running it: an impurity
# that only fires on one branch would not show up in a sample of calls.
PURE_FUNCS = [
    "reconcile",
    "mergeEarned",
    "unionIds",
    "furtherAlong",
    "earlierOf",
]
IMPURITIES = ["Date.now", "Math.random", "new Date(", "localStorage", "fetch(", "process."]

HARNESS = r"""
import { CREATURES } from '@/lib/game/creatures';
import {
  applyBattleResult,
  createProfile,
  normaliseProfile,
  reconcile,
} from '@/lib/game/progress';
import { createRng } from '@/lib/game/rng';
import {
  STORAGE_KEY,
  clearLocal,
  fetchRemoteProfile,
  fetchSession,
  loadLocal,
  pushRemoteProfile,
  saveLocal,
} from '@/lib/storage/client';

const config = JSON.parse(process.argv[2]);

const ALL_IDS = CREATURES.map((c) => c.id);
const STARTER = CREATURES.find((c) => c.stage === 1).id;

const HOUR = 3600_000;
const DAY = 24 * HOUR;
// A literal epoch, not a clock read. `new Date(ms).toISOString()` is a pure
// function of `ms`; the wall clock is never consulted anywhere in this harness.
const BASE_MS = Date.parse('2026-03-01T09:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Building divergent saves by *playing*, not by hand-editing fields.
// ---------------------------------------------------------------------------

/** Runs `battles` battles through the real engine on a device whose clock reads `startMs`. */
function play(profile, { seed, battles, startMs, stepMs = 20 * 60_000 }) {
  const rng = createRng(seed);
  let p = profile;
  for (let i = 0; i < battles; i++) {
    const now = iso(startMs + i * stepMs);
    const total = 4 + rng.int(0, 4);
    const correct = rng.int(0, total);
    const attempts = Array.from({ length: total }, (_, k) => ({
      skill: 'add1',
      tier: p.tier,
      correct: k < correct,
      elapsedMs: 3000 + rng.int(0, 4000),
    }));
    const summary = {
      won: correct * 2 >= total,
      caught: rng.next() < 0.6,
      creatureId: ALL_IDS[rng.int(0, ALL_IDS.length - 1)],
      turns: total,
      correct,
      total,
      bestCombo: correct,
      hpRemaining: 10,
      hpRatio: 0.5,
    };
    p = applyBattleResult(p, summary, attempts, { today: now.slice(0, 10), now }).profile;
  }
  return p;
}

// ---------------------------------------------------------------------------
// Facts: the things a child earned. Sorted, so the report is stable.
// ---------------------------------------------------------------------------

function facts(p) {
  if (!p) return null;
  return {
    caught: [...new Set(p.caught)].sort(),
    badges: [...new Set(p.badges)].sort(),
    xp: p.xp,
    battlesWon: p.battlesWon,
    battlesLost: p.battlesLost,
    problemsCorrect: p.problemsCorrect,
    problemsTotal: p.problemsTotal,
    bestCombo: p.bestCombo,
    streakBest: p.streak.best,
  };
}

/** Names of the fields where two profiles differ. Values are never emitted. */
function diffFields(a, b) {
  if (a === null || b === null) return a === b ? [] : ['<null>'];
  const out = [];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const key of keys) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) out.push(key);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The pair corpus.
// ---------------------------------------------------------------------------

// How far the laptop's clock is out, in both directions. 0 is a correct clock:
// the "touched, not played" case needs no skew at all.
const SKEWS = [
  { name: 'clock correct', ms: 0 },
  { name: 'clock +2h', ms: 2 * HOUR },
  { name: 'clock -2h', ms: -2 * HOUR },
  { name: 'clock +26h', ms: 26 * HOUR },
  { name: 'clock -26h', ms: -26 * HOUR },
  { name: 'clock +3d', ms: 3 * DAY },
  { name: 'clock -3d', ms: -3 * DAY },
];

const cases = [];

function addCase(entry) {
  const { id, scenario, normalisedInputs, a, b } = entry;
  const merged = reconcile(a, b);
  const swapped = reconcile(b, a);
  const idemLocal = reconcile(a, a);
  const idemRemote = reconcile(b, b);

  const normalised = merged === null ? null : normaliseProfile(merged);
  const roundTripped = merged === null ? null : JSON.parse(JSON.stringify(merged));

  cases.push({
    id,
    scenario,
    normalisedInputs,
    a: facts(a),
    b: facts(b),
    merged: facts(merged),
    swapped: facts(swapped),
    checks: {
      commuteDiff: diffFields(merged, swapped),
      idempotentIdentity: idemLocal === a && idemRemote === b,
      idempotentDiff: [...new Set([...diffFields(idemLocal, a), ...diffFields(idemRemote, b)])].sort(),
      normaliseDiff: diffFields(normalised, merged),
      jsonDiff: diffFields(roundTripped, merged),
      // A merge that returns one of its inputs unchanged is the fast path; the
      // client compares by reference to decide whether the server needs the
      // result pushed back, so this is behaviour, not an optimisation.
      returnedAnInput: merged === a || merged === b,
    },
  });
}

for (let s = 0; s < config.seeds; s++) {
  const ancestor = play(
    createProfile({ trainerName: 'Leo', starterId: STARTER, now: iso(BASE_MS) }),
    { seed: `anc:${s}`, battles: s % 3, startMs: BASE_MS },
  );

  // The tablet: played offline all afternoon, clock correct.
  const tablet = play(ancestor, {
    seed: `tablet:${s}`,
    battles: 1 + (s % 5),
    startMs: BASE_MS + 2 * DAY,
  });

  for (const skew of SKEWS) {
    const laptopStart = BASE_MS + 2 * DAY + skew.ms;

    // (1) Both devices played. The classic fork.
    addCase({
      id: `fork/${s}/${skew.name}`,
      scenario: `both devices played, laptop ${skew.name}`,
      normalisedInputs: true,
      a: tablet,
      b: play(ancestor, { seed: `laptop:${s}`, battles: 1 + ((s + 2) % 4), startMs: laptopStart }),
    });

    // (2) Touched, not played: a settings toggle bumps `updatedAt` and earns
    // nothing. This needs no wrong clock to destroy the tablet's afternoon.
    addCase({
      id: `touched/${s}/${skew.name}`,
      scenario: `laptop only toggled a setting, ${skew.name}`,
      normalisedInputs: true,
      a: tablet,
      b: {
        ...ancestor,
        settings: { ...ancestor.settings, language: 'zh' },
        updatedAt: iso(laptopStart + 6 * HOUR),
      },
    });

    // (3) The laptop is simply stale - opened, never touched.
    addCase({
      id: `idle/${s}/${skew.name}`,
      scenario: `laptop untouched since the fork, ${skew.name}`,
      normalisedInputs: true,
      a: tablet,
      b: { ...ancestor, updatedAt: iso(Date.parse(ancestor.updatedAt) + skew.ms) },
    });
  }

  // (4) Broken timestamps. `normaliseProfile` repairs these at every real
  // boundary, so reconcile should never see one - which is exactly why it is
  // worth checking that it does not lose an album if it ever does.
  const broken = [
    { name: 'unreadable date', updatedAt: 'not-a-date' },
    { name: 'empty date', updatedAt: '' },
    { name: 'year 2099', updatedAt: '2099-01-01T00:00:00.000Z' },
    { name: 'epoch zero', updatedAt: '1970-01-01T00:00:00.000Z' },
  ];
  for (const b of broken) {
    addCase({
      id: `broken/${s}/${b.name}`,
      scenario: `laptop played, then wrote ${b.name}`,
      normalisedInputs: false,
      a: tablet,
      b: {
        ...play(ancestor, { seed: `broken:${s}`, battles: 2, startMs: BASE_MS + 2 * DAY }),
        updatedAt: b.updatedAt,
      },
    });
  }

  // (5) One side missing entirely: a brand-new device, and a brand-new account.
  addCase({
    id: `absent/${s}/no remote`,
    scenario: 'signed in on a device with nothing on the server yet',
    normalisedInputs: true,
    a: tablet,
    b: null,
  });
  addCase({
    id: `absent/${s}/no local`,
    scenario: 'signed in on a fresh device with a server save waiting',
    normalisedInputs: true,
    a: null,
    b: tablet,
  });
}

// ---------------------------------------------------------------------------
// Sync loops: the same two devices, round after round.
//
// A single reconcile call can look harmless while the *loop* bleeds: a device
// whose clock is fast wins every comparison forever, so the other device's
// work is deleted on contact, every time, and no single call ever looks wrong.
// ---------------------------------------------------------------------------

function syncLoop({ seed, skewMs, rounds }) {
  const ancestor = createProfile({
    trainerName: 'Leo',
    starterId: STARTER,
    now: iso(BASE_MS),
  });

  let server = ancestor;
  let tablet = ancestor;
  let laptop = ancestor;

  // Everything either device has ever earned. Nothing here may ever vanish.
  const everCaught = new Set(ancestor.caught);
  const everBadges = new Set(ancestor.badges);
  const bests = { bestCombo: 0, streakBest: 0 };
  const totals = { xp: 0, battlesWon: 0, battlesLost: 0, problemsCorrect: 0, problemsTotal: 0 };

  const history = [];

  // Recorded the moment a device finishes playing, *before* it syncs. Reading
  // these after the merge would be circular: a merge that deleted the round's
  // work would also delete the evidence that the work happened.
  const record = (p) => {
    for (const id of p.caught) everCaught.add(id);
    for (const id of p.badges) everBadges.add(id);
    bests.bestCombo = Math.max(bests.bestCombo, p.bestCombo);
    bests.streakBest = Math.max(bests.streakBest, p.streak.best);
    for (const k of Object.keys(totals)) totals[k] = Math.max(totals[k], p[k]);
  };

  for (let r = 0; r < rounds; r++) {
    // The tablet plays offline, then syncs. Its clock is right.
    tablet = play(tablet, {
      seed: `${seed}:tablet:${r}`,
      battles: 2,
      startMs: BASE_MS + (r * 2 + 1) * DAY,
    });
    record(tablet);

    let winner = reconcile(tablet, server);
    // The server runs normaliseProfile on every PUT, so the loop does too.
    server = normaliseProfile(winner);
    tablet = winner;

    // The laptop plays, with a clock that is `skewMs` out.
    laptop = play(laptop, {
      seed: `${seed}:laptop:${r}`,
      battles: 2,
      startMs: BASE_MS + (r * 2 + 1) * DAY + skewMs + 6 * HOUR,
    });
    record(laptop);

    winner = reconcile(laptop, server);
    server = normaliseProfile(winner);
    laptop = winner;

    history.push({ round: r + 1, tablet: facts(tablet), laptop: facts(laptop), server: facts(server) });
  }

  // Settling: each device opens the app once more and syncs, twice round, which
  // is all it takes for a merge to converge. Asserting on a device mid-loop
  // would assert the wrong thing - the tablet has legitimately not seen the
  // laptop's last session yet, because it has not been opened since. What must
  // be true is that opening it gets everything back.
  for (let i = 0; i < 2; i++) {
    tablet = reconcile(tablet, server);
    server = normaliseProfile(tablet);
    laptop = reconcile(laptop, server);
    server = normaliseProfile(laptop);
  }

  return {
    seed,
    skewMs,
    rounds,
    ever: {
      caught: [...everCaught].sort(),
      badges: [...everBadges].sort(),
      ...bests,
      ...totals,
    },
    history,
    final: { tablet: facts(tablet), laptop: facts(laptop), server: facts(server) },
  };
}

const loops = [];
for (const skew of [
  { name: 'laptop 3d behind', ms: -3 * DAY },
  { name: 'laptop 2h behind', ms: -2 * HOUR },
  { name: 'both clocks right', ms: 0 },
  { name: 'laptop 2h ahead', ms: 2 * HOUR },
  { name: 'laptop 3d ahead', ms: 3 * DAY },
  { name: 'laptop 30d ahead', ms: 30 * DAY },
]) {
  for (const seed of ['loopA', 'loopB']) {
    loops.push({ name: `${skew.name} / ${seed}`, ...syncLoop({ seed, skewMs: skew.ms, rounds: config.rounds }) });
  }
}

// ---------------------------------------------------------------------------
// P5: the device save is never blocked on the network.
//
// Driven against the real `src/lib/storage/client.ts`, with a localStorage
// shim and with `fetch` first absent and then rejecting. If any of these
// throws, a child with a flat network loses the game rather than the account.
// ---------------------------------------------------------------------------

async function offlineChecks() {
  const cell = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (k) => (cell.has(k) ? cell.get(k) : null),
      setItem: (k, v) => cell.set(k, String(v)),
      removeItem: (k) => cell.delete(k),
    },
  };

  const profile = play(
    createProfile({ trainerName: 'Leo', starterId: STARTER, now: iso(BASE_MS) }),
    { seed: 'offline', battles: 3, startMs: BASE_MS },
  );

  const result = { storageKey: STORAGE_KEY, steps: [] };

  const step = async (name, fn) => {
    try {
      result.steps.push({ name, ok: true, detail: await fn() });
    } catch (err) {
      result.steps.push({ name, ok: false, detail: `threw ${err && err.name}` });
    }
  };

  // (a) No fetch binding at all - the module must not need one to save.
  const realFetch = globalThis.fetch;
  delete globalThis.fetch;
  await step('saveLocal with no fetch binding', () => {
    saveLocal(profile);
    return cell.has(STORAGE_KEY) ? 'written' : 'MISSING';
  });
  await step('loadLocal with no fetch binding', () => {
    const back = loadLocal();
    return back && back.xp === profile.xp && back.caught.length === profile.caught.length
      ? 'round-tripped'
      : 'LOST';
  });
  await step('fetchSession with no fetch binding', async () => {
    const s = await fetchSession();
    return s.signedIn === false && s.accountsAvailable === false ? 'offline session' : 'UNEXPECTED';
  });
  await step('pushRemoteProfile with no fetch binding', async () =>
    (await pushRemoteProfile(profile)) === false ? 'reported failure' : 'UNEXPECTED',
  );

  // (b) A network that is present but broken.
  globalThis.fetch = () => Promise.reject(new Error('network down'));
  await step('saveLocal while the network is down', () => {
    saveLocal({ ...profile, xp: profile.xp + 1 });
    return JSON.parse(cell.get(STORAGE_KEY)).xp === profile.xp + 1 ? 'written' : 'LOST';
  });
  await step('fetchRemoteProfile while the network is down', async () =>
    (await fetchRemoteProfile()) === null ? 'null, not a throw' : 'UNEXPECTED',
  );
  await step('reconcile against a null remote', () =>
    reconcile(profile, null) === profile ? 'kept the device save' : 'DISCARDED',
  );
  await step('clearLocal while the network is down', () => {
    clearLocal();
    return loadLocal() === null ? 'cleared' : 'UNEXPECTED';
  });

  // (c) Storage itself unavailable (Safari private mode throws on access).
  globalThis.window = {
    get localStorage() {
      throw new Error('blocked');
    },
  };
  await step('loadLocal when localStorage throws', () =>
    loadLocal() === null ? 'null, not a throw' : 'UNEXPECTED',
  );
  await step('saveLocal when localStorage throws', () => {
    saveLocal(profile);
    return 'no throw';
  });

  if (realFetch) globalThis.fetch = realFetch;
  delete globalThis.window;
  return result;
}

process.stdout.write(
  JSON.stringify({
    counts: { creatures: CREATURES.length },
    cases,
    loops,
    offline: await offlineChecks(),
  }),
);
"""


def die(message: str, code: int = 2) -> None:
    print(f"audit_sync: {message}", file=sys.stderr)
    raise SystemExit(code)


def run_engine() -> dict:
    """Bundle the pure engine plus the storage client and execute it under node."""
    if not ESBUILD.exists():
        die(f"esbuild not found at {ESBUILD}. Run `npm install` first.")

    workdir = Path(tempfile.mkdtemp(prefix="mathmon-sync-"))
    try:
        entry = workdir / "harness.mjs"
        entry.write_text(HARNESS, encoding="utf-8")
        bundle = workdir / "bundle.mjs"

        build = subprocess.run(
            [
                str(ESBUILD),
                str(entry),
                "--bundle",
                "--platform=node",
                "--format=esm",
                "--log-level=warning",
                f"--alias:@={REPO_ROOT / 'src'}",
                f"--outfile={bundle}",
            ],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
        )
        if build.returncode != 0:
            die(f"esbuild failed (exit {build.returncode}):\n{build.stderr.strip()}")

        payload = json.dumps({"seeds": SEEDS, "rounds": SYNC_ROUNDS}, sort_keys=True)
        run = subprocess.run(
            ["node", str(bundle), payload],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
        )
        if run.returncode != 0:
            die(f"engine harness failed (exit {run.returncode}):\n{run.stderr.strip()}")

        try:
            return json.loads(run.stdout)
        except json.JSONDecodeError as exc:
            die(f"harness produced non-JSON output: {exc}")
            raise
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Source-level checks. Some properties are about code paths rather than values.
# ---------------------------------------------------------------------------


def read(path: Path) -> str:
    if not path.exists():
        die(f"expected to find {path.relative_to(REPO_ROOT)}")
    return path.read_text(encoding="utf-8")


def function_body(source: str, name: str) -> str | None:
    """The braces-matched body of `function name(...)`, or None if absent."""
    match = re.search(rf"function {re.escape(name)}\s*(<[^>]*>)?\s*\(", source)
    if not match:
        return None
    start = source.index("{", match.end())
    depth = 0
    for i in range(start, len(source)):
        if source[i] == "{":
            depth += 1
        elif source[i] == "}":
            depth -= 1
            if depth == 0:
                return source[match.start() : i + 1]
    return None


def purity_violations() -> list[str]:
    """`reconcile` and its helpers must stay pure: both clients share them."""
    source = read(PROGRESS_TS)
    out: list[str] = []
    for name in PURE_FUNCS:
        body = function_body(source, name)
        if body is None:
            # A helper this script names may legitimately be renamed; only
            # `reconcile` itself is part of the contract.
            if name == "reconcile":
                out.append(
                    "merge-stays-pure: reconcile() is missing from "
                    "src/lib/game/progress.ts"
                )
            continue
        for bad in IMPURITIES:
            if bad in body:
                out.append(
                    f"merge-stays-pure: {name}() in src/lib/game/progress.ts uses "
                    f"`{bad}`; both clients share this rule, so it has to be a pure "
                    "function of its two arguments"
                )
    return out


def ordering_violations() -> list[str]:
    """The device save must be written before the network is ever consulted."""
    out: list[str] = []

    client = read(CLIENT_TS)
    for name in ("saveLocal", "loadLocal", "clearLocal"):
        body = function_body(client, name)
        if body is None:
            out.append(f"local-play-is-never-gated: {name}() is missing from src/lib/storage/client.ts")
            continue
        for bad in ("await", "fetch("):
            if bad in body:
                out.append(
                    f"local-play-is-never-gated: {name}() in src/lib/storage/client.ts "
                    f"contains `{bad}`; the device save must never wait on the network"
                )

    provider = read(PROVIDER_TSX)

    # First load: the device save is read and the app is playable before the
    # session request is even sent.
    load_local = provider.find("loadLocal()")
    settled = provider.find("setLoading(false)")
    first_await = provider.find("await fetchSession()")
    if -1 in (load_local, settled, first_await):
        out.append(
            "local-play-is-never-gated: could not find the first-load sequence in "
            "src/components/GameProvider.tsx (loadLocal / setLoading / fetchSession)"
        )
    elif not (load_local < settled < first_await):
        out.append(
            "local-play-is-never-gated: GameProvider awaits the server before the "
            "device save has loaded and `loading` has settled; a signed-in child "
            "with no network would stare at a spinner"
        )

    # Every persist writes locally first, and an unsigned player never reaches
    # the network at all.
    persist = provider[provider.find("const persist") : provider.find("const update")]
    if "saveLocal(next)" not in persist or "pushRemoteProfile" not in persist:
        out.append(
            "local-play-is-never-gated: could not find persist() in "
            "src/components/GameProvider.tsx"
        )
    elif persist.index("saveLocal(next)") > persist.index("pushRemoteProfile"):
        out.append(
            "local-play-is-never-gated: GameProvider.persist() pushes to the server "
            "before writing the device save"
        )
    elif "if (!signedIn)" not in persist:
        out.append(
            "local-play-is-never-gated: GameProvider.persist() has no signed-out "
            "early return; a player with no account would still be queued for sync"
        )

    return out


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

COUNTERS = [
    "xp",
    "battlesWon",
    "battlesLost",
    "problemsCorrect",
    "problemsTotal",
    "bestCombo",
    "streakBest",
]


def earned_union(a: dict | None, b: dict | None) -> dict:
    """Everything either side earned. `None` is a device with no save at all."""
    sides = [s for s in (a, b) if s is not None]
    return {
        "caught": sorted({c for s in sides for c in s["caught"]}),
        "badges": sorted({c for s in sides for c in s["badges"]}),
        **{k: max([s[k] for s in sides], default=0) for k in COUNTERS},
    }


def losses(expected: dict, got: dict | None) -> list[str]:
    """What the merge dropped, named field by field."""
    if got is None:
        missing = [k for k in ("caught", "badges") if expected[k]]
        missing += [k for k in COUNTERS if expected[k] > 0]
        return [f"{k} (whole profile discarded)" for k in sorted(missing)] or []
    out = []
    for key in ("caught", "badges"):
        gone = sorted(set(expected[key]) - set(got[key]))
        if gone:
            out.append(f"{key}: lost {len(gone)} ({', '.join(gone[:6])})")
    for key in COUNTERS:
        if got[key] < expected[key]:
            out.append(f"{key}: {got[key]} < {expected[key]}")
    return out


def inventions(expected: dict, got: dict | None) -> list[str]:
    """What the merge conjured up that neither side had."""
    if got is None:
        return []
    out = []
    for key in ("caught", "badges"):
        extra = sorted(set(got[key]) - set(expected[key]))
        if extra:
            out.append(f"{key}: invented {len(extra)} ({', '.join(extra[:6])})")
    for key in COUNTERS:
        if got[key] > expected[key]:
            out.append(f"{key}: {got[key]} > {expected[key]}")
    return out


def main() -> int:
    data = run_engine()
    cases = data["cases"]
    loops = data["loops"]
    offline = data["offline"]

    print("Mathmon cross-device sync audit")
    print("===============================")
    print(f"reconcile() pairs checked: {len(cases)}   sync loops: {len(loops)}"
          f" x {SYNC_ROUNDS} rounds")
    print("profiles are built by playing real battles through applyBattleResult;")
    print("no field is hand-edited except the timestamps a device clock decides.")

    violations: list[str] = []

    # ---- P1: nothing a child earned is ever lost --------------------------
    scenario_loss: dict[str, list[str]] = {}
    for case in cases:
        expected = earned_union(case["a"], case["b"])
        lost = losses(expected, case["merged"])
        made_up = inventions(expected, case["merged"])
        family = case["id"].split("/")[0]
        if lost:
            scenario_loss.setdefault(family, []).append(case["id"])
        for line in lost:
            violations.append(
                f"nothing-earned-is-lost: {case['id']} ({case['scenario']}) dropped {line}"
            )
        for line in made_up:
            violations.append(
                f"nothing-earned-is-lost: {case['id']} ({case['scenario']}) {line}"
            )

    print()
    print("P1  nothing a child earned is ever lost")
    print(f"  {'-' * 68}")
    families = sorted({c["id"].split("/")[0] for c in cases})
    print("  " + f"{'scenario':<12}{'pairs':>7}{'lossy':>7}   {'what the family is'}")
    blurbs = {
        "absent": "one side has no save at all",
        "broken": "a timestamp that will not parse",
        "fork": "both devices played offline",
        "idle": "one device stale, never touched",
        "touched": "a settings toggle, nothing earned",
    }
    for family in families:
        members = [c for c in cases if c["id"].split("/")[0] == family]
        lossy = len(scenario_loss.get(family, []))
        print(f"  {family:<12}{len(members):>7}{lossy:>7}   {blurbs.get(family, '')}")

    # ---- P2: order does not matter ---------------------------------------
    print()
    print("P2  the result does not depend on which device synced first")
    print(f"  {'-' * 68}")
    non_commuting = [c for c in cases if c["checks"]["commuteDiff"]]
    non_idempotent = [c for c in cases if not c["checks"]["idempotentIdentity"]]
    print(f"  reconcile(a,b) != reconcile(b,a):  {len(non_commuting)} of {len(cases)}")
    print(f"  reconcile(x,x) is not x:           {len(non_idempotent)} of {len(cases)}")
    for case in non_commuting:
        violations.append(
            f"order-does-not-matter: {case['id']} ({case['scenario']}) disagrees on "
            f"{', '.join(case['checks']['commuteDiff'])} depending on which side is "
            "called local"
        )
    for case in non_idempotent:
        detail = ", ".join(case["checks"]["idempotentDiff"]) or "a fresh object"
        violations.append(
            f"order-does-not-matter: {case['id']} ({case['scenario']}) is not "
            f"idempotent - reconcile(x,x) returned {detail}"
        )

    # ---- P3: a wrong clock loses nothing ----------------------------------
    print()
    print("P3  a wrong clock cannot destroy progress")
    print(f"  {'-' * 68}")
    print("  " + f"{'loop':<28}{'album':>8}{'kept':>7}{'xp':>10}{'kept':>8}")
    for loop in sorted(loops, key=lambda l: l["name"]):
        ever = loop["ever"]
        final = loop["final"]["server"]
        kept_album = len(set(final["caught"]) & set(ever["caught"]))
        print(
            f"  {loop['name']:<28}{len(ever['caught']):>8}{kept_album:>7}"
            f"{ever['xp']:>10}{final['xp']:>8}"
        )
        lost = losses(ever, final)
        for line in lost:
            violations.append(
                f"a-wrong-clock-loses-nothing: sync loop '{loop['name']}' ended with "
                f"{line} after {loop['rounds']} rounds"
            )
        # And it must converge: once both devices have been opened again and
        # synced, each of them holds everything either of them ever earned.
        for side in ("tablet", "laptop"):
            drift = losses(ever, loop["final"][side])
            for line in drift:
                violations.append(
                    f"a-wrong-clock-loses-nothing: sync loop '{loop['name']}' left the "
                    f"{side} with {line} even after settling"
                )

    # ---- P4: the merged profile is storable -------------------------------
    print()
    print("P4  the merged profile survives storage unchanged")
    print(f"  {'-' * 68}")
    json_broken = [c for c in cases if c["checks"]["jsonDiff"]]
    norm_broken = [c for c in cases if c["normalisedInputs"] and c["checks"]["normaliseDiff"]]
    # An input that was never normalised may carry an unreadable date, and
    # repairing exactly that is normaliseProfile's job. Anything *else* moving
    # is still the merge's fault.
    repaired_only = [
        c
        for c in cases
        if not c["normalisedInputs"]
        and set(c["checks"]["normaliseDiff"]) - {"updatedAt", "createdAt"}
    ]
    print(f"  JSON round-trip changed the profile:   {len(json_broken)} of {len(cases)}")
    print(f"  normaliseProfile changed the profile:  {len(norm_broken)} of "
          f"{len([c for c in cases if c['normalisedInputs']])} (normalised inputs)")
    print(f"  ... beyond repairing a broken date:    {len(repaired_only)} of "
          f"{len([c for c in cases if not c['normalisedInputs']])} (raw inputs)")
    for case in json_broken:
        violations.append(
            f"merge-output-is-storable: {case['id']} ({case['scenario']}) changed on a "
            f"JSON round-trip: {', '.join(case['checks']['jsonDiff'])}"
        )
    for case in norm_broken:
        violations.append(
            f"merge-output-is-storable: {case['id']} ({case['scenario']}) was rewritten "
            f"by normaliseProfile: {', '.join(case['checks']['normaliseDiff'])}"
        )
    for case in repaired_only:
        extra = sorted(set(case["checks"]["normaliseDiff"]) - {"updatedAt", "createdAt"})
        violations.append(
            f"merge-output-is-storable: {case['id']} ({case['scenario']}) was rewritten "
            f"by normaliseProfile beyond the broken timestamp: {', '.join(extra)}"
        )

    # ---- P5: local play is never gated ------------------------------------
    print()
    print("P5  the device save never waits on the network")
    print(f"  {'-' * 68}")
    for entry in offline["steps"]:
        mark = "ok " if entry["ok"] and not entry["detail"].isupper() else "BAD"
        print(f"  [{mark}] {entry['name']:<44} {entry['detail']}")
        if not entry["ok"] or entry["detail"].isupper():
            violations.append(
                f"local-play-is-never-gated: {entry['name']} -> {entry['detail']}"
            )
    source_level = ordering_violations()
    print(f"  [{'ok ' if not source_level else 'BAD'}] "
          f"{'call order in client.ts and GameProvider.tsx':<44} "
          f"{'local write precedes every network call' if not source_level else 'see below'}")
    violations.extend(source_level)

    # ---- the merge must stay pure ----------------------------------------
    pure = purity_violations()
    print()
    print("Purity of the shared rule")
    print(f"  {'-' * 68}")
    print(f"  functions checked: {', '.join(sorted(PURE_FUNCS))}")
    print(f"  banned constructs: {', '.join(sorted(IMPURITIES))}")
    print(f"  [{'ok ' if not pure else 'BAD'}] both clients answer a merge identically")
    violations.extend(pure)

    # ---- worked example, always printed ----------------------------------
    example = next(
        (c for c in cases if c["id"].startswith("touched/4/clock correct")), cases[0]
    )
    print()
    print("Worked example: the settings toggle that used to cost an afternoon")
    print(f"  {'-' * 68}")
    print(f"  {example['scenario']}")
    ex_union = earned_union(example["a"], example["b"])
    for label, side in (("tablet (played)", example["a"]), ("laptop (toggled)", example["b"]),
                        ("merged", example["merged"])):
        print(
            f"  {label:<18} album {len(side['caught']):>2}  badges {len(side['badges']):>2}"
            f"  xp {side['xp']:>5}  best combo {side['bestCombo']:>2}"
        )
    print(
        f"  {'union of both':<18} album {len(ex_union['caught']):>2}  "
        f"badges {len(ex_union['badges']):>2}  xp {ex_union['xp']:>5}  "
        f"best combo {ex_union['bestCombo']:>2}"
    )

    print()
    if violations:
        print("FAIL")
        # Grouped by property and capped: a broken merge produces the same
        # violation a few hundred times, and burying the *other* broken property
        # under it is how a red run gets misread as a single small problem.
        by_property: dict[str, list[str]] = {}
        for line in sorted(set(violations)):
            by_property.setdefault(line.split(":", 1)[0], []).append(line)
        for name in sorted(by_property):
            lines = by_property[name]
            for line in lines[:VIOLATIONS_SHOWN]:
                print(f"  {line}")
            if len(lines) > VIOLATIONS_SHOWN:
                print(f"  ... and {len(lines) - VIOLATIONS_SHOWN} more {name} violations")
        return 1

    print("OK: the merge keeps every creature, badge, record and counter from both")
    print("    devices, gives the same answer whichever side syncs first, survives a")
    print("    wrong clock in either direction, round-trips through storage")
    print("    unchanged, and never makes local play wait on the network.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
