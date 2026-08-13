#!/usr/bin/env python3
"""Print the starter-matchup balance matrix, and fail if any matchup is unwinnable.

Why this exists
---------------
The roster doubled from 6 evolution lines to 12, so the starter matchup space
went from 36 ordered pairs to 144. `battle.test.ts` asserts the *properties*
(every matchup is winnable, a wrong-answer run never wins). This prints the
numbers behind those properties, so a balance change can be read rather than
inferred from a green tick.

How it runs the engine
----------------------
The engine is pure TypeScript with no React, DOM or Node dependencies, so it is
bundled with the repo's own esbuild and executed under plain node. No test
runner is involved and no network is touched.

Determinism
-----------
Every battle is seeded from a fixed string, every answer is submitted at a fixed
elapsed time, and the seed list below is a literal. There is no wall-clock read
and no randomness anywhere in this script or in the harness it generates, so two
runs on the same commit print byte-identical output.

Exit status
-----------
0  every matchup is winnable by the smart-play bot on every seed, and no
   wrong-answer run wins.
1  at least one matchup failed. The offending pairs are listed.
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

# Fixed seed suffixes. The engine is deterministic, so one seed gives a 0/1 win
# rate; several fixed seeds give a rate that still reproduces exactly.
SEEDS = ["s0", "s1", "s2", "s3", "s4"]

# Level 3 / tier 4 is the documented balance scenario; level 1 / tier 1 is a
# child's very first battle, where the margins are thinnest.
SCENARIOS = [
    {"name": "level 3, tier 4", "level": 3, "tier": 4},
    {"name": "level 1, tier 1", "level": 1, "tier": 1},
]

HARNESS = r"""
import { CREATURES } from '@engine/creatures';
import {
  availableMoves,
  battleReducer,
  beginCatch,
  createBattle,
  isOver,
} from '@engine/battle';

/** Mirrors `playTurn` in battle.test.ts: fixed clock, no wall time. */
function playTurn(state, moveId, correct, elapsedMs) {
  let next = battleReducer(state, { type: 'chooseMove', moveId, now: 0 });
  if (next.phase !== 'solving') return next;
  const answer = correct ? next.problem.answer : next.problem.answer + 1;
  next = battleReducer(next, { type: 'answer', value: answer, now: elapsedMs });
  if (next.phase === 'resolving') next = battleReducer(next, { type: 'continue' });
  return next;
}

/** Mirrors `playSmart`: saves the special for full charge, else leans on strong. */
function playSmart(state) {
  let s = state;
  for (let i = 0; i < 100 && !isOver(s); i++) {
    if (s.phase === 'catching') {
      s = beginCatch(s, 0);
      s = battleReducer(s, { type: 'answer', value: s.problem.answer, now: 1000 });
      break;
    }
    const moves = availableMoves(s);
    const special = moves.find((m) => m.kind === 'special' && m.affordable);
    const move = special ?? moves.find((m) => m.kind === 'strong');
    s = playTurn(s, move.id, true, 800);
  }
  return s;
}

/** Mirrors `playOut(..., false)`: answers everything wrong. */
function playMash(state) {
  let s = state;
  for (let i = 0; i < 100 && !isOver(s); i++) {
    if (s.phase === 'catching') {
      s = beginCatch(s, 0);
      s = battleReducer(s, { type: 'answer', value: s.problem.answer + 1, now: 1000 });
      break;
    }
    const moves = availableMoves(s);
    const move = moves.find((m) => m.kind === 'strong' && m.affordable) ?? moves[0];
    s = playTurn(s, move.id, false, 2000);
  }
  return s;
}

const config = JSON.parse(process.argv[2]);
const starters = CREATURES.filter((c) => c.stage === 1);

const results = [];
for (const scenario of config.scenarios) {
  for (const player of starters) {
    for (const foe of starters) {
      const runs = [];
      for (const seed of config.seeds) {
        const setup = {
          seed: `${seed}:${player.id}-vs-${foe.id}`,
          playerCreatureId: player.id,
          foeCreatureId: foe.id,
          playerLevel: scenario.level,
          foeLevel: scenario.level,
          tier: scenario.tier,
        };
        const smart = playSmart(createBattle(setup));
        const mash = playMash(createBattle(setup));
        runs.push({
          seed,
          won: smart.outcome === 'win',
          hpRatio: smart.player.maxHp > 0 ? smart.player.hp / smart.player.maxHp : 0,
          turns: smart.turn,
          mashWon: mash.outcome === 'win',
        });
      }
      results.push({
        scenario: scenario.name,
        player: player.id,
        playerLine: player.lineId,
        playerElement: player.element,
        foe: foe.id,
        foeLine: foe.lineId,
        foeElement: foe.element,
        runs,
      });
    }
  }
}

process.stdout.write(
  JSON.stringify({
    starters: starters.map((c) => ({ id: c.id, lineId: c.lineId, element: c.element })),
    results,
  }),
);
"""


def die(message: str, code: int = 2) -> "None":
    print(f"balance_report: {message}", file=sys.stderr)
    raise SystemExit(code)


def run_engine() -> dict:
    """Bundle the pure engine with esbuild and execute it under node."""
    if not ESBUILD.exists():
        die(f"esbuild not found at {ESBUILD}. Run `npm install` first.")

    workdir = Path(tempfile.mkdtemp(prefix="mathmon-balance-"))
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

        payload = json.dumps({"seeds": SEEDS, "scenarios": SCENARIOS}, sort_keys=True)
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


def short(line_id: str) -> str:
    """`ember-hound` -> `hound`; the element is already the row grouping."""
    return line_id.split("-", 1)[1] if "-" in line_id else line_id


def print_matrix(scenario: str, cells: dict, order: list, width: int) -> None:
    header = " " * (width + 2) + " ".join(f"{short(c):>8}" for c in order)
    print()
    print(f"  {scenario}   (attacker row into defender column)")
    print(f"  {'-' * (len(header) - 2)}")
    print(header)
    for attacker in order:
        row = [f"  {short(attacker):<{width}}"]
        for defender in order:
            cell = cells[(attacker, defender)]
            wins = cell["wins"]
            total = cell["total"]
            mark = " " if wins == total else "!"
            row.append(f"{mark}{wins * 100 // total:>3}/{round(cell['hp'] * 100):>3}")
        print(" ".join(row))


def main() -> int:
    data = run_engine()
    starters = data["starters"]
    order = [c["lineId"] for c in starters]
    width = max(len(short(c)) for c in order)

    print("Mathmon balance report")
    print("======================")
    print(f"starters: {len(starters)}   ordered matchups: {len(starters) ** 2}")
    print(f"seeds per matchup: {len(SEEDS)}   ({', '.join(SEEDS)})")
    print("cells: win% / mean ending HP%   '!' marks a matchup the bot did not always win")

    unwinnable = []
    mash_wins = []

    for scenario in SCENARIOS:
        name = scenario["name"]
        rows = [r for r in data["results"] if r["scenario"] == name]
        if len(rows) != len(starters) ** 2:
            die(
                f"expected {len(starters) ** 2} matchups for '{name}', got {len(rows)}",
            )

        cells = {}
        for row in rows:
            runs = row["runs"]
            wins = sum(1 for r in runs if r["won"])
            cells[(row["playerLine"], row["foeLine"])] = {
                "wins": wins,
                "total": len(runs),
                "hp": sum(r["hpRatio"] for r in runs) / len(runs),
            }
            if wins != len(runs):
                lost = [r["seed"] for r in runs if not r["won"]]
                unwinnable.append(f"{name}: {row['player']} vs {row['foe']} lost on {lost}")
            won_by_guessing = [r["seed"] for r in runs if r["mashWon"]]
            if won_by_guessing:
                mash_wins.append(
                    f"{name}: {row['player']} vs {row['foe']} "
                    f"won while answering everything wrong on {won_by_guessing}"
                )

        print_matrix(name, cells, order, width)

        worst = min(cells.items(), key=lambda kv: kv[1]["hp"])
        best = max(cells.items(), key=lambda kv: kv[1]["hp"])
        print()
        print(
            f"  thinnest margin: {short(worst[0][0])} into {short(worst[0][1])} "
            f"-> {round(worst[1]['hp'] * 100)}% HP"
        )
        print(
            f"  widest margin:   {short(best[0][0])} into {short(best[0][1])} "
            f"-> {round(best[1]['hp'] * 100)}% HP"
        )

    print()
    if unwinnable or mash_wins:
        print("FAIL")
        for line in unwinnable:
            print(f"  unwinnable: {line}")
        for line in mash_wins:
            print(f"  maths bypassed: {line}")
        return 1

    print("OK: every matchup is winnable by smart play, and no guessing run wins.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
