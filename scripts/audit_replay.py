#!/usr/bin/env python3
"""Prove a battle can be saved mid-fight and resumed without drifting.

Why this exists
---------------
`CLAUDE.md` lists three things it buys by keeping `src/lib/game/` pure. Two of
them were already guarded - the 144-matchup sweep and `balance_report.py` cover
"balance can be proven", and `battle.test.ts` replays a fight from a seed. The
third read:

    "A battle can be serialised to JSON mid-fight and resumed."

and was, in practice, guarded by one unit test that cut a single fight after one
turn, played one more turn, and asserted the attempt count had reached two. That
test cannot see the failure it is nominally about. A save that drops a field,
rounds a float, reorders a key or quietly turns a value into `null` still leaves
two attempts in the log; the battle simply continues as a *different* battle. And
"a slightly different battle" is precisely what nobody would notice - the child
resumes, the numbers look plausible, and the fight he saved is gone.

So this script does not check that a resumed battle keeps working. It checks that
a resumed battle *is the same battle*, byte for byte, at every point it could
possibly have been interrupted.

What is checked
---------------
P1 replay-determinism
    The same setup and the same recorded action list produce a byte-identical
    state after every single action, every time. Re-running the bot reproduces
    the action list too, so the recording itself is not smuggling in entropy.

P2 serialise-resume-equivalence
    For every battle, `JSON.parse(JSON.stringify(state))` is taken at *every*
    action index - not one cut, every cut, including before the first action and
    after the last - resumed, and driven to the end with the remaining actions.
    Every intermediate state and the final state must be byte-identical to the
    battle that was never interrupted. The snapshot itself must also survive its
    own round trip unchanged.

P3 round-trip-totality
    Every state reachable at every step is walked, and any value JSON cannot
    carry faithfully is a violation: `undefined`, `NaN`, `Infinity`, `-0`,
    functions, symbols, bigints, `Date`, `Map`, `Set`, class instances, or an
    object with its own `toJSON`. These are the failure that P2 would only catch
    by luck - each one survives `JSON.stringify` by mutating into something else
    (or vanishing), so a state carrying one drifts on the first save whether or
    not this particular fight happened to touch it.

How it runs the engine
----------------------
Nothing here reimplements a rule. The harness imports `createBattle`,
`battleReducer`, `availableMoves` and `isOver` from `src/lib/game/` and drives
them exactly as the app does. The engine is pure TypeScript with no React, DOM or
Node dependencies, so it is bundled with the repo's own esbuild and executed
under plain node. This mirrors `scripts/balance_report.py` and
`scripts/simulate_difficulty.py`.

Determinism
-----------
Battles are seeded from literal strings, the clock handed to the reducer is a
counter advanced by the engine's own seeded mulberry32, and the matchup list
comes from `CREATURES` in roster order. There is no wall-clock read and no
unseeded randomness in this script or in the harness it generates, so two runs on
the same commit print byte-identical output. Verify with:

    python3 scripts/audit_replay.py > /tmp/a
    python3 scripts/audit_replay.py > /tmp/b
    cmp /tmp/a /tmp/b

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
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ESBUILD = REPO_ROOT / "node_modules" / ".bin" / "esbuild"

# Fixed seed suffixes. The engine is deterministic, so a seed pins one exact
# fight; several fixed seeds pin several, and all of them reproduce.
SEEDS = ["r0", "r1"]

# Level 3 / tier 4 is the documented balance scenario; level 1 / tier 1 is a
# child's first battle, where fights are short and a cut lands near the ends.
SCENARIOS = [
    {"name": "level 3, tier 4", "level": 3, "tier": 4},
    {"name": "level 1, tier 1", "level": 1, "tier": 1},
]

# Three bots, because the reachable state space differs sharply between them.
#   smart  - always correct: reaches full charge, specials, mends, long logs.
#   mixed  - seeded right/wrong and seeded move choice, plus the occasional
#            `timeout` action, which is the only way `problemShownAt` is read
#            back on a turn nobody answered.
#   mash   - always wrong: glance damage, zero charge, usually a defeat, which
#            is the one branch that never reaches the catch phase at all.
STYLES = ["smart", "mixed", "mash"]

# Cut points scale with the square of battle length, so the full 144-matchup
# sweep runs at one seed set and the stage sweep (which covers stage 2 and 3
# creatures, never seen in a starter matchup) runs at one scenario.
STAGE_SWEEP_SCENARIO = "level 3, tier 4"
STAGE_SWEEP_SEED = "r0"

# Printed in full, with a digest of the final state, so a balance change that
# alters these fights shows up as a changed number rather than a silent pass.
SPOTLIGHT = [
    {"scenario": "level 3, tier 4", "style": "smart"},
    {"scenario": "level 3, tier 4", "style": "mixed"},
    {"scenario": "level 1, tier 1", "style": "mash"},
]

HARNESS = r"""
import { CREATURES } from '@engine/creatures';
import { availableMoves, battleReducer, createBattle, isOver } from '@engine/battle';
import { createRng } from '@engine/rng';

const config = JSON.parse(process.argv[2]);

// ---------------------------------------------------------------------------
// P3: walk a state and report anything JSON cannot carry faithfully.
//
// Each of these survives `JSON.stringify` by turning into something else rather
// than by failing loudly, which is exactly why a save that contains one drifts
// silently: `undefined` and functions vanish from an object (and become `null`
// in an array), NaN and Infinity become `null`, `-0` becomes `0`, a Date becomes
// a string, a Map or Set becomes `{}`.
// ---------------------------------------------------------------------------
function scanValue(value, path, out, depth) {
  if (out.length >= 8) return;
  if (depth > 32) {
    out.push({ path, why: 'nested deeper than 32 levels' });
    return;
  }
  if (value === null) return;

  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'undefined') {
    out.push({ path, why: 'undefined (JSON drops the key entirely)' });
    return;
  }
  if (type === 'function') {
    out.push({ path, why: 'a function (JSON drops the key entirely)' });
    return;
  }
  if (type === 'symbol') {
    out.push({ path, why: 'a symbol (JSON drops the key entirely)' });
    return;
  }
  if (type === 'bigint') {
    out.push({ path, why: 'a bigint (JSON.stringify throws on it)' });
    return;
  }
  if (type === 'number') {
    if (Number.isNaN(value)) out.push({ path, why: 'NaN (becomes null)' });
    else if (!Number.isFinite(value)) out.push({ path, why: 'Infinity (becomes null)' });
    else if (Object.is(value, -0)) out.push({ path, why: '-0 (becomes 0)' });
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) scanValue(value[i], `${path}[${i}]`, out, depth + 1);
    return;
  }
  if (value instanceof Date) {
    out.push({ path, why: 'a Date (becomes a string, and never parses back)' });
    return;
  }
  if (value instanceof Map) {
    out.push({ path, why: 'a Map (becomes {})' });
    return;
  }
  if (value instanceof Set) {
    out.push({ path, why: 'a Set (becomes {})' });
    return;
  }
  if (type === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const name = value.constructor && value.constructor.name ? value.constructor.name : '?';
      out.push({ path, why: `an instance of ${name} (only its own enumerable fields survive)` });
      return;
    }
    if (typeof value.toJSON === 'function') {
      out.push({ path, why: 'an object with its own toJSON (saves as something else)' });
      return;
    }
    for (const key of Object.keys(value)) {
      const child = path === '' ? key : `${path}.${key}`;
      scanValue(value[key], child, out, depth + 1);
    }
    return;
  }
  out.push({ path, why: `an unexpected ${type}` });
}

function countNodes(value, depth) {
  if (value === null || typeof value !== 'object' || depth > 32) return 1;
  let n = 1;
  if (Array.isArray(value)) {
    for (const v of value) n += countNodes(v, depth + 1);
    return n;
  }
  for (const key of Object.keys(value)) n += countNodes(value[key], depth + 1);
  return n;
}

/** FNV-1a over the serialised state. Only used to print a stable fingerprint. */
function digest(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// The bots. Each records the exact action objects it issued, so a replay does
// not have to re-derive them - it replays literals, which is what a saved
// battle's remaining input actually is.
// ---------------------------------------------------------------------------
function record(setup, style) {
  const rng = createRng(
    `replay:${style}:${setup.seed}:${setup.playerCreatureId}:${setup.foeCreatureId}`,
  );
  let state = createBattle(setup);
  const actions = [];
  const trace = [state];
  let clock = 0;

  for (let guard = 0; guard < 400 && !isOver(state); guard++) {
    // The clock only ever moves forward, as a real one does, but by a seeded
    // amount so slow turns, fast turns and crits all occur.
    clock += 120 + rng.int(0, 2600);
    let action;

    if (state.phase === 'catching') {
      if (state.problemShownAt === null) {
        action = { type: 'beginCatch', now: clock };
      } else {
        const right = style === 'mash' ? false : style === 'smart' ? true : rng.next() < 0.7;
        action = {
          type: 'answer',
          value: right ? state.problem.answer : state.problem.answer + 1,
          now: clock,
        };
      }
    } else if (state.phase === 'resolving') {
      action = { type: 'continue' };
    } else if (state.phase === 'choosing') {
      const affordable = availableMoves(state).filter((m) => m.affordable);
      let move;
      if (style === 'smart') {
        move =
          affordable.find((m) => m.kind === 'special') ??
          affordable.find((m) => m.kind === 'strong') ??
          affordable[0];
      } else if (style === 'mash') {
        move = affordable.find((m) => m.kind === 'strong') ?? affordable[0];
      } else {
        move = affordable[rng.int(0, affordable.length - 1)];
      }
      action = { type: 'chooseMove', moveId: move.id, now: clock };
    } else {
      const right = style === 'mash' ? false : style === 'smart' ? true : rng.next() < 0.65;
      const walkAway = style === 'mixed' && rng.next() < 0.08;
      action = walkAway
        ? { type: 'timeout', now: clock }
        : {
            type: 'answer',
            value: right ? state.problem.answer : state.problem.answer + 1,
            now: clock,
          };
    }

    state = battleReducer(state, action);
    actions.push(action);
    trace.push(state);
  }

  return { actions, trace };
}

function checkBattle(setup, style) {
  const issues = [];
  const first = record(setup, style);
  const refs = first.trace.map((s) => JSON.stringify(s));
  const n = first.actions.length;
  const stats = { actions: n, cuts: n + 1, resumed: 0, nodes: 0 };

  const where = (i) =>
    `turn ${first.trace[i].turn}, phase '${first.trace[i].phase}', action index ${i}`;

  // --- P3 -----------------------------------------------------------------
  for (let i = 0; i < first.trace.length; i++) {
    stats.nodes += countNodes(first.trace[i], 0);
    const bad = [];
    scanValue(first.trace[i], '', bad, 0);
    for (const b of bad) {
      issues.push({
        property: 'round-trip-totality',
        detail: `state.${b.path || '<root>'} at ${where(i)} is ${b.why}`,
      });
    }
  }

  // --- P1 -----------------------------------------------------------------
  const again = record(setup, style);
  if (JSON.stringify(again.actions) !== JSON.stringify(first.actions)) {
    issues.push({
      property: 'replay-determinism',
      detail: 'the bot issued a different action list on a second run of the same setup',
    });
  }
  for (let rep = 0; rep < 2; rep++) {
    let state = createBattle(setup);
    if (JSON.stringify(state) !== refs[0]) {
      issues.push({
        property: 'replay-determinism',
        detail: `createBattle produced a different opening state on repeat ${rep + 1}`,
      });
      continue;
    }
    for (let i = 0; i < n; i++) {
      state = battleReducer(state, first.actions[i]);
      if (JSON.stringify(state) !== refs[i + 1]) {
        issues.push({
          property: 'replay-determinism',
          detail:
            `repeat ${rep + 1} diverged replaying '${first.actions[i].type}' at ${where(i)}`,
        });
        break;
      }
    }
  }

  // --- P2: cut at every action index, not just one ------------------------
  for (let cut = 0; cut <= n; cut++) {
    const saved = refs[cut];
    let state = JSON.parse(saved);
    if (JSON.stringify(state) !== saved) {
      issues.push({
        property: 'serialise-resume-equivalence',
        detail: `the snapshot at ${where(cut)} does not survive its own JSON round trip`,
      });
      continue;
    }
    for (let i = cut; i < n; i++) {
      // The action is round-tripped too: a resumed battle's next input arrives
      // over the wire as JSON, not as the object that was in memory.
      state = battleReducer(state, JSON.parse(JSON.stringify(first.actions[i])));
      stats.resumed += 1;
      if (JSON.stringify(state) !== refs[i + 1]) {
        issues.push({
          property: 'serialise-resume-equivalence',
          detail:
            `saved at ${where(cut)} and resumed, the battle diverged ` +
            `${i - cut + 1} action(s) later on '${first.actions[i].type}' (${where(i)})`,
        });
        break;
      }
    }
  }

  const final = first.trace[first.trace.length - 1];
  return {
    issues,
    stats,
    outcome: final.outcome,
    turns: final.turn,
    caught: final.caught,
    logEntries: final.log.length,
    attempts: final.attempts.length,
    digest: digest(refs[refs.length - 1]),
  };
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------
const starters = CREATURES.filter((c) => c.stage === 1);
const scenarioByName = new Map(config.scenarios.map((s) => [s.name, s]));

const battles = [];
for (const scenario of config.scenarios) {
  for (const seed of config.seeds) {
    for (const player of starters) {
      for (const foe of starters) {
        for (const style of config.styles) {
          battles.push({
            group: 'starter matchups',
            scenario: scenario.name,
            style,
            seed,
            setup: {
              seed: `${seed}:${player.id}-vs-${foe.id}`,
              playerCreatureId: player.id,
              foeCreatureId: foe.id,
              playerLevel: scenario.level,
              foeLevel: scenario.level,
              tier: scenario.tier,
            },
          });
        }
      }
    }
  }
}

// Every creature in the roster, including stage 2 and 3, which a starter-only
// matrix never touches. Paired against the next creature in roster order so the
// element wheel is exercised rather than every fight being a mirror.
const stageScenario = scenarioByName.get(config.stageSweep.scenario);
for (let i = 0; i < CREATURES.length; i++) {
  const player = CREATURES[i];
  const foe = CREATURES[(i + 7) % CREATURES.length];
  for (const style of config.styles) {
    battles.push({
      group: 'whole roster',
      scenario: stageScenario.name,
      style,
      seed: config.stageSweep.seed,
      setup: {
        seed: `${config.stageSweep.seed}:${player.id}-vs-${foe.id}`,
        playerCreatureId: player.id,
        foeCreatureId: foe.id,
        playerLevel: Math.max(stageScenario.level, player.stage * 2),
        foeLevel: Math.max(stageScenario.level, foe.stage * 2),
        tier: stageScenario.tier,
      },
    });
  }
}

const groups = new Map();
const issues = [];
const spotlight = [];

for (const battle of battles) {
  const result = checkBattle(battle.setup, battle.style);

  const key = `${battle.group}|${battle.scenario}|${battle.style}`;
  const bucket = groups.get(key) ?? {
    group: battle.group,
    scenario: battle.scenario,
    style: battle.style,
    battles: 0,
    actions: 0,
    cuts: 0,
    resumed: 0,
    nodes: 0,
    longest: 0,
    shortest: Infinity,
    wins: 0,
    losses: 0,
    unfinished: 0,
  };
  bucket.battles += 1;
  bucket.actions += result.stats.actions;
  bucket.cuts += result.stats.cuts;
  bucket.resumed += result.stats.resumed;
  bucket.nodes += result.stats.nodes;
  bucket.longest = Math.max(bucket.longest, result.stats.actions);
  bucket.shortest = Math.min(bucket.shortest, result.stats.actions);
  if (result.outcome === 'win') bucket.wins += 1;
  else if (result.outcome === 'loss') bucket.losses += 1;
  else bucket.unfinished += 1;
  groups.set(key, bucket);

  for (const issue of result.issues) {
    if (issues.length < 40) {
      issues.push({
        property: issue.property,
        detail:
          `${battle.scenario} / ${battle.style} / ${battle.setup.playerCreatureId} vs ` +
          `${battle.setup.foeCreatureId} (seed ${battle.seed}): ${issue.detail}`,
      });
    }
  }

  const wanted = config.spotlight.find(
    (s) => s.scenario === battle.scenario && s.style === battle.style,
  );
  if (
    wanted &&
    battle.group === 'starter matchups' &&
    battle.seed === config.seeds[0] &&
    spotlight.filter((s) => s.scenario === battle.scenario && s.style === battle.style).length < 3
  ) {
    spotlight.push({
      scenario: battle.scenario,
      style: battle.style,
      player: battle.setup.playerCreatureId,
      foe: battle.setup.foeCreatureId,
      actions: result.stats.actions,
      cuts: result.stats.cuts,
      resumed: result.stats.resumed,
      turns: result.turns,
      attempts: result.attempts,
      logEntries: result.logEntries,
      outcome: result.outcome,
      caught: result.caught,
      digest: result.digest,
    });
  }
}

process.stdout.write(
  JSON.stringify({
    roster: { creatures: CREATURES.length, starters: starters.length },
    groups: [...groups.values()],
    spotlight,
    issues,
  }),
);
"""


def die(message: str, code: int = 2) -> None:
    print(f"audit_replay: {message}", file=sys.stderr)
    raise SystemExit(code)


def run_engine() -> dict:
    """Bundle the pure engine with esbuild and execute it under node."""
    if not ESBUILD.exists():
        die(f"esbuild not found at {ESBUILD}. Run `npm install` first.")

    workdir = Path(tempfile.mkdtemp(prefix="mathmon-replay-"))
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
                f"--alias:@engine={REPO_ROOT / 'src' / 'lib' / 'game'}",
                f"--outfile={bundle}",
            ],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
        )
        if build.returncode != 0:
            die(f"esbuild failed (exit {build.returncode}):\n{build.stderr.strip()}")

        payload = json.dumps(
            {
                "seeds": SEEDS,
                "scenarios": SCENARIOS,
                "styles": STYLES,
                "spotlight": SPOTLIGHT,
                "stageSweep": {
                    "scenario": STAGE_SWEEP_SCENARIO,
                    "seed": STAGE_SWEEP_SEED,
                },
            },
            sort_keys=True,
        )
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


def group_key(bucket: dict) -> tuple:
    return (bucket["group"], bucket["scenario"], bucket["style"])


def main() -> int:
    data = run_engine()
    groups = sorted(data["groups"], key=group_key)
    if not groups:
        die("harness reported no battles at all")

    totals = {
        "battles": sum(g["battles"] for g in groups),
        "actions": sum(g["actions"] for g in groups),
        "cuts": sum(g["cuts"] for g in groups),
        "resumed": sum(g["resumed"] for g in groups),
        "nodes": sum(g["nodes"] for g in groups),
    }

    print("Mathmon save/resume replay audit")
    print("================================")
    print(f"roster: {data['roster']['creatures']} creatures, "
          f"{data['roster']['starters']} starters")
    print(f"scenarios: {', '.join(s['name'] for s in SCENARIOS)}")
    print(f"bots: {', '.join(STYLES)}   seeds: {', '.join(SEEDS)}")
    print()
    print(f"battles driven to the end:      {totals['battles']:>9}")
    print(f"reducer actions recorded:       {totals['actions']:>9}")
    print(f"save points cut and resumed:    {totals['cuts']:>9}")
    print(f"actions replayed after a cut:   {totals['resumed']:>9}")
    print(f"state values scanned for JSON:  {totals['nodes']:>9}")
    print()
    print("  Every battle is cut at every action index, including before the first")
    print("  action and after the last, and each cut is driven to completion.")

    label_width = max(
        len("group / scenario"),
        max(len(f"{g['group']} / {g['scenario']}") for g in groups),
    )
    print()
    print("Coverage")
    print(f"  {'-' * 78}")
    print("  " + f"{'group / scenario':<{label_width}}  {'bot':<7}{'fights':>7}"
          f"{'actions':>9}{'cuts':>8}{'len':>9}{'w/l/-':>12}")
    for bucket in groups:
        label = f"{bucket['group']} / {bucket['scenario']}"
        span = f"{bucket['shortest']}-{bucket['longest']}"
        wl = f"{bucket['wins']}/{bucket['losses']}/{bucket['unfinished']}"
        print(
            f"  {label:<{label_width}}  {bucket['style']:<7}{bucket['battles']:>7}"
            f"{bucket['actions']:>9}{bucket['cuts']:>8}{span:>9}{wl:>12}"
        )
    print()
    print("  'len' is the shortest-longest action count across the group;")
    print("  'w/l/-' counts wins, losses and fights that hit the 400-action guard.")

    spotlight = sorted(
        data["spotlight"],
        key=lambda s: (s["scenario"], s["style"], s["player"], s["foe"]),
    )
    if spotlight:
        scen_width = max(len("scenario"), max(len(s["scenario"]) for s in spotlight))
        matchup_width = max(
            len("matchup"),
            max(len(f"{s['player']} vs {s['foe']}") for s in spotlight),
        )
        print()
        print("Spotlight fights (a changed digest means the fight itself changed)")
        print(f"  {'-' * 78}")
        print("  " + f"{'scenario':<{scen_width}}  {'matchup':<{matchup_width}}  "
              f"{'bot':<7}{'acts':>5}{'cuts':>6}{'turns':>7}{'log':>5}"
              f"{'result':>12}{'digest':>11}")
        for s in spotlight:
            matchup = f"{s['player']} vs {s['foe']}"
            result = s["outcome"] or "unfinished"
            if s["outcome"] == "win":
                result = "win+caught" if s["caught"] else "win"
            print(
                f"  {s['scenario']:<{scen_width}}  {matchup:<{matchup_width}}  "
                f"{s['style']:<7}{s['actions']:>5}{s['cuts']:>6}{s['turns']:>7}"
                f"{s['logEntries']:>5}{result:>12}{s['digest']:>11}"
            )

    violations = sorted(
        (f"{i['property']}: {i['detail']}" for i in data["issues"]),
    )

    print()
    if violations:
        print("FAIL")
        for line in violations:
            print(f"  {line}")
        print()
        print("  A battle saved mid-fight does not resume as the same battle.")
        print("  CLAUDE.md claims it does; fix the engine rather than this check.")
        return 1

    print("OK: every battle replays byte-identically from its seed, resumes")
    print("    byte-identically from a JSON snapshot taken at any action index,")
    print("    and holds no value that JSON cannot carry unchanged.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
