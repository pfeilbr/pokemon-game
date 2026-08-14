#!/usr/bin/env python3
"""Simulate synthetic players through the real adaptive-difficulty engine.

Why this exists
---------------
`CLAUDE.md` makes a load-bearing promise about the maths ramp:

    "Difficulty adapts on a rolling 8-attempt window and moves one tier at a
    time. Promotion needs accuracy, and answering within par earns it in eight
    questions instead of sixteen, so a lucky streak of easy questions cannot
    fling a child into fractions and a slow one is never capped."

Both halves of that sentence were once false, and this script is how the second
half was found.

The vaulting half came first. The rolling window was carried across a promotion,
so every promotion's evidence was already stale and a perfect player vaulted from
adding-to-20 to two-step expressions in sixteen questions. It was fixed in
`progress.ts` (the window is cleared on a tier change) and guarded by a handful
of hand-written unit tests. A handful of cases is thin protection for the one
property most likely to decide whether a seven-year-old keeps playing, so this
script sweeps the whole space instead: a grid of synthetic players from
perfect-and-fast down to mostly-wrong-and-slow, several hundred questions each,
driven through the *real* engine.

That sweep is what exposed the capping half. Promotion used to need accuracy AND
an average inside par, and the grid showed the consequence in two cells nobody
had thought to look at: the 100% row at "over par" and "dawdling" read `1 @--`.
Four hundred questions, not one of them wrong, still on adding to 20 - because
par at tier 1 is 5.1 seconds and a child hunting for digits on an on-screen
keypad takes seven, and the adapter could not tell slow hands from weak maths.
Speed is now a shortcut rather than a gate, and P5 and P6 below pin down both
directions of that: an accurate player is never capped by his pace, and a quick
one still reaches the top sooner.

How it runs the engine
----------------------
Nothing here reimplements a rule. The harness below imports `nextTier`,
`applyBattleResult`, `generateProblem` and `parTimeForTier` from
`src/lib/game/` and drives them exactly as the app does - attempts accumulate
during a battle, and `applyBattleResult` folds them in at the end. The engine is
pure TypeScript with no React, DOM or Node dependencies, so it is bundled with
the repo's own esbuild and executed under plain node. This mirrors
`scripts/balance_report.py`.

Every threshold is read from the engine, never restated here: `MIN_TIER`,
`MAX_TIER`, `ADAPT_WINDOW` and `parTimeForTier` are imported, and the accuracy
and speed thresholds (which are module-private on purpose) are *discovered* by
probing `nextTier` rather than duplicated as literals. A rebalance therefore
moves this report instead of breaking it.

Determinism
-----------
Correctness and answer speed come from the engine's own seeded mulberry32 with
literal seeds; the clock passed into the engine is a literal ISO string. There
is no wall-clock read and no unseeded randomness anywhere, so two runs on the
same commit print byte-identical output. Verify with:

    python3 scripts/simulate_difficulty.py > /tmp/a
    python3 scripts/simulate_difficulty.py > /tmp/b
    cmp /tmp/a /tmp/b

Exit status
-----------
0  every documented property of the ramp holds.
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

# --- simulation grid -------------------------------------------------------
# Accuracy is the player's true per-question hit rate. Speed is a multiple of
# the tier's par time, so "fast" stays fast as the tiers get more generous.
ACCURACIES = [1.00, 0.95, 0.85, 0.75, 0.65, 0.55, 0.40]
SPEEDS = [
    {"name": "fast", "factor": 0.5},
    {"name": "brisk", "factor": 0.8},
    {"name": "at par", "factor": 1.0},
    {"name": "over par", "factor": 1.4},
    {"name": "dawdling", "factor": 2.2},
]

# Questions per battle. The adapter only runs when a battle ends, so the batch
# size changes how much evidence each decision sees. 4 and 6 are below the
# window and 10 is above it, which is exactly where the original stale-window
# bug did and did not show up.
BATCH_SIZES = [4, 6, 10]

QUESTIONS_PER_PLAYER = 400
FIXED_NOW = "2026-01-01T09:00:00.000Z"

# Profiles printed in full (tier-by-tier ladder) rather than just summarised.
SPOTLIGHT = [(1.00, "fast"), (1.00, "dawdling"), (0.85, "at par"), (0.65, "brisk")]
SPOTLIGHT_BATCH = 6

HARNESS = r"""
import { CREATURES } from '@engine/creatures';
import {
  ADAPT_WINDOW,
  MAX_TIER,
  MIN_TIER,
  clampTier,
  generateProblem,
  nextTier,
  parTimeForTier,
} from '@engine/math';
import { applyBattleResult, createProfile } from '@engine/progress';
import { createRng } from '@engine/rng';

const config = JSON.parse(process.argv[2]);
const STARTER = CREATURES.find((c) => c.stage === 1).id;

/** A window of `size` attempts, `k` of them correct, all at one speed. */
function windowOf(k, size, tier, speedFactor) {
  const elapsedMs = Math.round(parTimeForTier(tier) * 1000 * speedFactor);
  return Array.from({ length: size }, (_, i) => ({
    skill: 'add1',
    tier,
    correct: i < k,
    elapsedMs,
  }));
}

// ---------------------------------------------------------------------------
// Discover the private thresholds by probing the engine.
// LEVEL_UP_ACCURACY / LEVEL_DOWN_ACCURACY are deliberately not exported, so the
// report asks the engine what they are instead of restating them.
// ---------------------------------------------------------------------------
const probeTier = Math.round((MIN_TIER + MAX_TIER) / 2);
let minPromoteK = null;
let maxDemoteK = null;
for (let k = 0; k <= ADAPT_WINDOW; k++) {
  const moved = nextTier(probeTier, windowOf(k, ADAPT_WINDOW, probeTier, 0.4));
  if (moved > probeTier && minPromoteK === null) minPromoteK = k;
  if (moved < probeTier) maxDemoteK = k;
}

// Slowest answer speed (as a multiple of par) at which a perfect window still
// promotes. Stepped in hundredths so the answer is exact and reproducible.
let slowestPromotingSpeed = 0;
for (let step = 0; step <= 300; step++) {
  const factor = step / 100;
  const perfect = windowOf(ADAPT_WINDOW, ADAPT_WINDOW, probeTier, factor);
  if (nextTier(probeTier, perfect) > probeTier) slowestPromotingSpeed = factor;
}

// How much evidence a hopelessly slow but perfect player needs before the
// accuracy-only route up opens. Discovered, not restated: PATIENCE_WINDOW is
// exported, but probing keeps this report honest if the rule stops matching the
// constant. `null` would mean no amount of correct answers ever promotes him,
// which is the pinned-at-tier-1 bug this route exists to prevent.
let patientWindow = null;
for (let size = 1; size <= ADAPT_WINDOW * 4 && patientWindow === null; size++) {
  if (nextTier(probeTier, windowOf(size, size, probeTier, 3.0)) > probeTier) patientWindow = size;
}

// ---------------------------------------------------------------------------
// Exhaustive sweep of the pure decision function.
// Every tier (including out-of-band inputs), every window size from empty to
// twice the window, every correct-count, several speeds.
// ---------------------------------------------------------------------------
const sweep = {
  calls: 0,
  maxStep: 0,
  outOfBand: [],
  biggestJumps: [],
  promotedOnPartialWindow: [],
};
for (let tier = MIN_TIER - 3; tier <= MAX_TIER + 3; tier++) {
  for (let size = 0; size <= ADAPT_WINDOW * 2; size++) {
    for (let k = 0; k <= size; k++) {
      for (const factor of [0.25, 0.6, 1.0, 1.5, 3.0]) {
        const result = nextTier(tier, windowOf(k, size, clampTier(tier), factor));
        sweep.calls += 1;
        const step = Math.abs(result - clampTier(tier));
        if (step > sweep.maxStep) sweep.maxStep = step;
        if (step > 1 && sweep.biggestJumps.length < 8) {
          sweep.biggestJumps.push({ tier, size, k, factor, result });
        }
        if ((result < MIN_TIER || result > MAX_TIER) && sweep.outOfBand.length < 8) {
          sweep.outOfBand.push({ tier, size, k, factor, result });
        }
        if (
          result > clampTier(tier) &&
          size < ADAPT_WINDOW &&
          sweep.promotedOnPartialWindow.length < 8
        ) {
          sweep.promotedOnPartialWindow.push({ tier, size, k, factor, result });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Synthetic players, driven through applyBattleResult exactly as the app does.
// ---------------------------------------------------------------------------
function simulate(player) {
  const rng = createRng(`mathmon-sim:${player.accuracy}:${player.speedName}:${player.batch}`);
  let profile = createProfile({
    trainerName: 'sim',
    starterId: STARTER,
    now: config.now,
  });

  let asked = 0;
  let attemptsSinceChange = 0;
  const firstReached = { [profile.tier]: 0 };
  const updates = [];
  let minTierSeen = profile.tier;
  let maxTierSeen = profile.tier;
  let correctTotal = 0;
  let tierQuestionSum = 0;

  while (asked < config.questions) {
    const attempts = [];
    const room = Math.min(player.batch, config.questions - asked);
    for (let q = 0; q < room; q++) {
      const tier = profile.tier;
      // The real generator picks the skill, so the attempt log matches what a
      // player at this tier would actually have been shown.
      const problem = generateProblem(`sim:${player.speedName}:${asked}`, tier);
      const correct = rng.next() < player.accuracy;
      // Seeded jitter around the target speed: a child is not a metronome.
      const jitter = 0.85 + rng.next() * 0.3;
      attempts.push({
        skill: problem.skill,
        tier,
        correct,
        elapsedMs: Math.round(parTimeForTier(tier) * 1000 * player.speedFactor * jitter),
      });
      asked += 1;
      tierQuestionSum += tier;
      if (correct) correctTotal += 1;
    }

    const correctCount = attempts.filter((a) => a.correct).length;
    const summary = {
      won: correctCount * 2 >= attempts.length,
      caught: false,
      creatureId: STARTER,
      turns: attempts.length,
      correct: correctCount,
      total: attempts.length,
      bestCombo: correctCount,
      hpRemaining: 10,
      hpRatio: 0.5,
    };

    const before = profile.tier;
    attemptsSinceChange += attempts.length;
    const outcome = applyBattleResult(profile, summary, attempts, {
      today: config.now.slice(0, 10),
      now: config.now,
    });
    profile = outcome.profile;

    if (profile.tier !== before) {
      updates.push({
        questions: asked,
        from: before,
        to: profile.tier,
        attemptsSinceChange,
      });
      attemptsSinceChange = 0;
      if (firstReached[profile.tier] === undefined) firstReached[profile.tier] = asked;
      if (profile.tier < minTierSeen) minTierSeen = profile.tier;
      if (profile.tier > maxTierSeen) maxTierSeen = profile.tier;
    }
  }

  return {
    accuracy: player.accuracy,
    speedName: player.speedName,
    speedFactor: player.speedFactor,
    batch: player.batch,
    startTier: MIN_TIER,
    finalTier: profile.tier,
    minTierSeen,
    maxTierSeen,
    // Time-weighted: the tier the player was actually *sitting at*, averaged
    // over every question asked. This is the drift, as opposed to the single
    // luckiest window a rolling adapter will always eventually hand out.
    meanTier: tierQuestionSum / asked,
    observedAccuracy: correctTotal / asked,
    questionsAsked: asked,
    firstReached,
    updates,
  };
}

const players = [];
for (const batch of config.batchSizes) {
  for (const accuracy of config.accuracies) {
    for (const speed of config.speeds) {
      players.push({
        accuracy,
        speedName: speed.name,
        speedFactor: speed.factor,
        batch,
      });
    }
  }
}

process.stdout.write(
  JSON.stringify({
    constants: { MIN_TIER, MAX_TIER, ADAPT_WINDOW },
    thresholds: {
      minPromoteK,
      maxDemoteK,
      probeTier,
      slowestPromotingSpeed,
      patientWindow,
      parAtProbeTier: parTimeForTier(probeTier),
    },
    sweep,
    players: players.map(simulate),
  }),
);
"""


def die(message: str, code: int = 2) -> None:
    print(f"simulate_difficulty: {message}", file=sys.stderr)
    raise SystemExit(code)


def run_engine() -> dict:
    """Bundle the pure engine with esbuild and execute it under node."""
    if not ESBUILD.exists():
        die(f"esbuild not found at {ESBUILD}. Run `npm install` first.")

    workdir = Path(tempfile.mkdtemp(prefix="mathmon-ramp-"))
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
                "accuracies": ACCURACIES,
                "speeds": SPEEDS,
                "batchSizes": BATCH_SIZES,
                "questions": QUESTIONS_PER_PLAYER,
                "now": FIXED_NOW,
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


def key(player: dict) -> tuple:
    return (player["batch"], -player["accuracy"], player["speedFactor"])


def label(player: dict) -> str:
    return f"{round(player['accuracy'] * 100):>3}% / {player['speedName']}"


def print_grid(players: list, batch: int, top_tier: int) -> None:
    rows = sorted([p for p in players if p["batch"] == batch], key=key)
    speeds = [s["name"] for s in SPEEDS]
    width = max(len(s) for s in speeds) + 6

    print()
    print(f"  {QUESTIONS_PER_PLAYER} questions each, {batch} questions per battle")
    print(f"  {'-' * 68}")
    print("  " + " " * 8 + "".join(f"{s:>{width}}" for s in speeds))
    for accuracy in ACCURACIES:
        cells = []
        for speed in speeds:
            match = next(
                p for p in rows if p["accuracy"] == accuracy and p["speedName"] == speed
            )
            reached = match["firstReached"].get(str(top_tier))
            top = str(reached) if reached is not None else "--"
            cell = "{0} @{1}".format(match["finalTier"], top)
            cells.append(f"{cell:>{width}}")
        print(f"  {round(accuracy * 100):>3}%    " + "".join(cells))
    print()
    print(f"  cell: 'final tier @ question at which tier {top_tier} was first reached'")
    print(f"        ('@--' = tier {top_tier} never reached in {QUESTIONS_PER_PLAYER} questions)")


def print_ladder(players: list, min_tier: int, max_tier: int) -> None:
    print()
    print(f"  Tier ladder (question number at which each tier was first reached)")
    print(f"  batch size {SPOTLIGHT_BATCH}")
    print(f"  {'-' * 68}")
    tiers = list(range(min_tier, max_tier + 1))
    print("  " + " " * 18 + "".join(f"{t:>5}" for t in tiers))
    for accuracy, speed in SPOTLIGHT:
        match = next(
            p
            for p in players
            if p["batch"] == SPOTLIGHT_BATCH
            and p["accuracy"] == accuracy
            and p["speedName"] == speed
        )
        cells = "".join(
            f"{match['firstReached'].get(str(t), '-'):>5}" for t in tiers
        )
        print(f"  {label(match):<18}" + cells)


def main() -> int:
    data = run_engine()
    constants = data["constants"]
    thresholds = data["thresholds"]
    sweep = data["sweep"]
    players = data["players"]

    min_tier = constants["MIN_TIER"]
    max_tier = constants["MAX_TIER"]
    window = constants["ADAPT_WINDOW"]
    promote_ratio = thresholds["minPromoteK"] / window
    # Anything strictly below this true accuracy tends downward: it is the
    # highest window score the engine still demotes on, plus one.
    sinking_ratio = (thresholds["maxDemoteK"] + 1) / window

    print("Mathmon adaptive-difficulty ramp report")
    print("=======================================")
    print(f"engine constants: MIN_TIER={min_tier}  MAX_TIER={max_tier}  ADAPT_WINDOW={window}")
    print(f"players simulated: {len(players)}   questions each: {QUESTIONS_PER_PLAYER}")
    print(f"batch sizes (questions per battle): {', '.join(str(b) for b in BATCH_SIZES)}")

    print()
    print("Thresholds discovered by probing the engine (not restated here)")
    print(f"  promotes at   {thresholds['minPromoteK']}/{window} correct "
          f"({promote_ratio * 100:.1f}% accuracy) or better")
    print(f"  demotes at    {thresholds['maxDemoteK']}/{window} correct "
          f"({thresholds['maxDemoteK'] / window * 100:.1f}%) or worse")
    print(f"  holds between those two scores")
    print(f"  a perfect window still promotes up to {thresholds['slowestPromotingSpeed']:.2f}x par "
          f"(par at tier {thresholds['probeTier']} = {thresholds['parAtProbeTier']:.1f}s)")
    patient = thresholds["patientWindow"]
    print(f"  past that, accuracy alone promotes on "
          f"{'%d attempts' % patient if patient else 'NOTHING - speed is a hard cap'}, "
          f"at any speed")

    print()
    print("Exhaustive sweep of nextTier()")
    print(f"  {sweep['calls']} calls: every tier {min_tier - 3}..{max_tier + 3}, "
          f"every window size 0..{window * 2}, every correct-count, 5 speeds")
    print(f"  largest single-update move: {sweep['maxStep']} tier(s)")
    print(f"  results outside [{min_tier}, {max_tier}]: {len(sweep['outOfBand'])}")
    print(f"  promotions on a partial window: {len(sweep['promotedOnPartialWindow'])}")

    for batch in BATCH_SIZES:
        print_grid(players, batch, max_tier)
    print_ladder(players, min_tier, max_tier)

    # ---- properties -------------------------------------------------------
    violations: list[str] = []

    # P1: one step at a time.
    if sweep["maxStep"] > 1:
        for j in sweep["biggestJumps"]:
            violations.append(
                f"one-step-at-a-time: nextTier({j['tier']}) moved to {j['result']} on a "
                f"window of {j['size']} ({j['k']} correct, {j['factor']}x par)"
            )
    for player in sorted(players, key=key):
        for update in player["updates"]:
            if abs(update["to"] - update["from"]) > 1:
                violations.append(
                    f"one-step-at-a-time: {label(player)} (batch {player['batch']}) jumped "
                    f"{update['from']} -> {update['to']} at question {update['questions']}"
                )

    # P2: a promotion always costs a full window of fresh evidence, so a perfect
    # player cannot vault. This is the property the original stale-window bug
    # broke, and it is the reason `recentAttempts` is cleared on a tier change.
    for entry in sweep["promotedOnPartialWindow"]:
        violations.append(
            f"no-vaulting: nextTier({entry['tier']}) promoted to {entry['result']} on only "
            f"{entry['size']} attempts (window is {window})"
        )
    for player in sorted(players, key=key):
        for update in player["updates"]:
            if update["to"] > update["from"] and update["attemptsSinceChange"] < window:
                violations.append(
                    f"no-vaulting: {label(player)} (batch {player['batch']}) promoted "
                    f"{update['from']} -> {update['to']} at question {update['questions']} on only "
                    f"{update['attemptsSinceChange']} attempts since the last tier change "
                    f"({window} required)"
                )

    floor = (max_tier - min_tier) * window
    for player in sorted(players, key=key):
        if player["accuracy"] < 1.0 or player["speedFactor"] > 1.0:
            continue
        reached = player["firstReached"].get(str(max_tier))
        if reached is not None and reached < floor:
            violations.append(
                f"no-vaulting: a perfect {player['speedName']} player (batch {player['batch']}) "
                f"reached tier {max_tier} in {reached} questions; "
                f"{max_tier - min_tier} promotions must cost at least {floor}"
            )

    # P3: a player below the sinking threshold must not climb; falling is fine.
    #
    # Stated as *drift*, not as "the tier never budges", and deliberately so.
    # The adapter samples 8 questions, so a 55%-accuracy player will roll 7/8
    # about 6% of the time and get promoted one tier - which is the documented
    # gentle behaviour working, not a bug, because the same player demotes on
    # ~52% of windows and is pulled straight back down. What must never happen
    # is a *sustained* climb, so the two things checked are:
    #   - the tier he actually sits at, averaged over every question, stays
    #     within one tier of where he started (a transient bump self-corrects);
    #   - he never reaches the top half of the band, where fractions and
    #     two-step expressions live. A struggling child must never be shown
    #     those, however lucky one window was.
    ceiling = min_tier + (max_tier - min_tier) // 2
    for player in sorted(players, key=key):
        if player["accuracy"] >= sinking_ratio:
            continue
        if player["meanTier"] > player["startTier"] + 1:
            violations.append(
                f"low-accuracy-does-not-climb: {label(player)} (batch {player['batch']}) "
                f"drifted upward - mean tier {player['meanTier']:.2f} from a start of "
                f"{player['startTier']} despite {player['observedAccuracy'] * 100:.1f}% accuracy "
                f"(below the {sinking_ratio * 100:.1f}% sinking threshold)"
            )
        if player["maxTierSeen"] > ceiling:
            violations.append(
                f"low-accuracy-does-not-climb: {label(player)} (batch {player['batch']}) "
                f"reached tier {player['maxTierSeen']} despite "
                f"{player['observedAccuracy'] * 100:.1f}% accuracy; a player below the "
                f"{sinking_ratio * 100:.1f}% sinking threshold must stay out of the top half "
                f"of the band (tier {ceiling + 1}+)"
            )

    # P4: the tier never leaves the legal band.
    for entry in sweep["outOfBand"]:
        violations.append(
            f"tier-stays-in-band: nextTier({entry['tier']}) returned {entry['result']}, "
            f"outside [{min_tier}, {max_tier}]"
        )
    for player in sorted(players, key=key):
        if player["minTierSeen"] < min_tier or player["maxTierSeen"] > max_tier:
            violations.append(
                f"tier-stays-in-band: {label(player)} (batch {player['batch']}) ranged "
                f"{player['minTierSeen']}..{player['maxTierSeen']}, "
                f"outside [{min_tier}, {max_tier}]"
            )

    # P5: speed is a bonus, not a cap.
    #
    # This is the property the ramp did not have, and the grid above is where it
    # showed: promotion required accuracy *and* an average inside par, par at
    # tier 1 is 5.1 seconds, and a seven-year-old hunting for digits on an
    # on-screen keypad takes seven. The 100% rows at "over par" and "dawdling"
    # both read `1 @--` - four hundred questions, not one wrong, still on adding
    # to 20. CLAUDE.md has always promised slowness is never punished, and a
    # permanent difficulty cap is the harshest punishment this game has.
    for player in sorted(players, key=key):
        if player["accuracy"] < 1.0:
            continue
        if player["finalTier"] < max_tier:
            violations.append(
                f"accuracy-is-never-capped: {label(player)} (batch {player['batch']}) "
                f"answered {player['observedAccuracy'] * 100:.0f}% of "
                f"{player['questionsAsked']} questions correctly and finished at tier "
                f"{player['finalTier']} of {max_tier}; pace must not cap the ramp"
            )
    if thresholds["patientWindow"] is None:
        violations.append(
            f"accuracy-is-never-capped: no window size up to {window * 4} promotes a "
            "perfect player answering at 3x par; speed is acting as a hard ceiling"
        )

    # P6: ...but it is still a bonus, so being quick must reach the top sooner.
    # Without this, "never capped" could be satisfied by ignoring the clock
    # entirely, which would throw away the reason the speed meter is on screen.
    for batch in BATCH_SIZES:
        perfect = {
            p["speedName"]: p["firstReached"].get(str(max_tier))
            for p in players
            if p["accuracy"] == 1.0 and p["batch"] == batch
        }
        quickest, slowest = SPEEDS[0]["name"], SPEEDS[-1]["name"]
        if perfect.get(quickest) is not None and perfect.get(slowest) is not None:
            if perfect[slowest] <= perfect[quickest]:
                violations.append(
                    f"speed-is-still-a-bonus: at batch {batch} a perfect {slowest} player "
                    f"reached tier {max_tier} in {perfect[slowest]} questions, no slower than "
                    f"a perfect {quickest} one at {perfect[quickest]}; answering quickly must "
                    "buy a faster climb or the speed meter means nothing"
                )

    # ---- calibration (reported, never enforced) ---------------------------
    print()
    print(f"Struggling players (below the {sinking_ratio * 100:.1f}% sinking threshold)")
    print(f"  {'-' * 68}")
    print("  " + f"{'player':<20}{'batch':>6}{'mean tier':>11}{'highest':>9}{'final':>7}")
    for player in sorted(players, key=key):
        if player["accuracy"] >= sinking_ratio:
            continue
        print(
            f"  {label(player):<20}{player['batch']:>6}{player['meanTier']:>11.2f}"
            f"{player['maxTierSeen']:>9}{player['finalTier']:>7}"
        )
    print()
    print("  A transient one-tier bump is the rolling window doing its job: 7-of-8")
    print("  happens by luck sometimes, and the next window pulls him back down.")
    print("  What is checked is the drift, not the luckiest single window.")

    print()
    print("Calibration (reported, not enforced - balance is the owner's call)")
    print(f"  {'-' * 68}")
    for accuracy, speed in SPOTLIGHT:
        for batch in BATCH_SIZES:
            match = next(
                p
                for p in players
                if p["batch"] == batch
                and p["accuracy"] == accuracy
                and p["speedName"] == speed
            )
            reached = match["firstReached"].get(str(max_tier))
            top = f"{reached} questions" if reached is not None else (
                f"never (stalled at tier {match['finalTier']})"
            )
            print(f"  {label(match):<18} batch {batch:>2}:  tier {max_tier} after {top}")

    print()
    if violations:
        print("FAIL")
        for line in violations:
            print(f"  {line}")
        return 1

    print("OK: tier moves one step at a time, never vaults, never leaves the band,")
    print(f"    no player below {sinking_ratio * 100:.1f}% accuracy drifts upward, no accurate")
    print("    player is capped by his pace, and being quick still climbs sooner.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
