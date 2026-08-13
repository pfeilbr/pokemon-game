#!/usr/bin/env python3
"""Report what the album costs to draw, and fail if any creature blows its budget.

The album is the heaviest screen on this client: every cell is an SVG built from
the shared ``drawCreature``, and ``art.ts`` emits gradients, a rim shadow, an
outline, texture, ears, wings and an aura. With 36 creatures on one scrolling
screen, "how many nodes is that actually" stopped being a question anyone could
answer by reading the code.

So it is measured rather than guessed. The numbers come from the real engine —
this script bundles a throwaway TypeScript harness against
``src/lib/game/art.ts`` and runs it — not from a Python re-implementation of the
geometry, which would drift from the engine the first time someone added a
crown.

Usage::

    python3 mobile/scripts/album_cost.py            # table + totals
    python3 mobile/scripts/album_cost.py --json     # machine-readable
    python3 mobile/scripts/album_cost.py --budget N # override the per-creature cap

Exit status is 0 when every creature is inside ``PER_CREATURE_BUDGET`` and the
album is inside the album budget, 1 when something is over, and 2 when the
measurement itself could not be taken. A failure to measure is never reported as
a pass.

Determinism: ``drawCreature`` is pure and seedless, the roster order is fixed,
and nothing here reads the clock, the environment or a random source. Two runs
on the same tree print byte-identical output.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

MOBILE = Path(__file__).resolve().parent.parent
REPO = MOBILE.parent
ART = REPO / "src" / "lib" / "game" / "art.ts"
CREATURES = REPO / "src" / "lib" / "game" / "creatures.ts"

# Rolldown is already in mobile/node_modules as Vitest's bundler, so the harness
# needs no new dependency and no network. It is used only to resolve the
# engine's extensionless TypeScript imports, which bare `node` will not do.
ROLLDOWN = MOBILE / "node_modules" / ".bin" / "rolldown"

# Budget, per creature, for one album cell.
#
# Measured worst case today is 86 nodes (`thornmoss`: a stage-3 with wings, an
# aura and texture) against a roster mean of 46. 120 leaves the heaviest
# creature room to grow by another ~40%, so adding a crown or a tail does not
# trip it, while an art feature that doubles a creature does.
#
# The cap is per creature and not only on the total, deliberately. One runaway
# creature is the failure worth naming: spread across 36 cells the total would
# absorb it, and the thing a profiler shows you is a slow screen, not which
# creature made it slow.
PER_CREATURE_BUDGET = 120

# The album shows every creature at once, so its budget is simply the
# per-creature cap across the roster. Anything under this is a screen a phone
# draws without complaint.
ALBUM_BUDGET_PER_CREATURE = PER_CREATURE_BUDGET

# Counts SVG nodes the way `mobile/src/ui/CreatureArt.tsx` builds them: the root
# <Svg> and its <Defs>, one node per gradient and per gradient stop, then every
# shape — groups included, since a <G> is a node too and the roster nests most
# of its geometry inside them. Counting `drawing.shapes.length` alone would
# report 2 for a creature that draws 86.
HARNESS = """
import { CREATURES } from %(creatures)s;
import { type Shape, drawCreature } from %(art)s;

const walk = (shapes: readonly Shape[]): number =>
  shapes.reduce(
    (total, shape) => total + 1 + (shape.kind === 'group' ? walk(shape.children) : 0),
    0,
  );

function measure(creature: (typeof CREATURES)[number], silhouette: boolean) {
  const drawing = drawCreature(creature, { silhouette });
  const shapes = walk(drawing.shapes);
  const gradients = drawing.gradients.length;
  const stops = drawing.gradients.reduce((total, g) => total + g.stops.length, 0);
  return { shapes, gradients, stops, nodes: 2 + gradients + stops + shapes };
}

const rows = CREATURES.map((creature) => {
  const caught = measure(creature, false);
  const silhouette = measure(creature, true);
  return {
    id: creature.id,
    element: creature.element,
    stage: creature.stage,
    shapes: caught.shapes,
    gradients: caught.gradients,
    stops: caught.stops,
    caught: caught.nodes,
    silhouette: silhouette.nodes,
    worst: Math.max(caught.nodes, silhouette.nodes),
  };
});

process.stdout.write(JSON.stringify({ rows }));
"""


def fail_to_measure(message: str) -> "NoReturn":  # type: ignore[valid-type]
    print(f"album_cost: could not measure: {message}", file=sys.stderr)
    raise SystemExit(2)


def measure() -> list[dict]:
    """Bundle and run the harness against the real engine, returning its rows."""
    for path in (ART, CREATURES):
        if not path.is_file():
            fail_to_measure(f"{path} is missing")
    if not ROLLDOWN.is_file():
        fail_to_measure(f"{ROLLDOWN} is missing — run `npm install` in {MOBILE}")
    node = shutil.which("node")
    if node is None:
        fail_to_measure("`node` is not on PATH")

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        source = work / "harness.ts"
        bundle = work / "harness.cjs"
        source.write_text(
            HARNESS
            % {
                "art": json.dumps(str(ART)),
                "creatures": json.dumps(str(CREATURES)),
            },
            encoding="utf-8",
        )

        # Each step is checked on its own. Chaining these through a pipe is how
        # a non-zero exit gets swallowed by whatever runs last, which is a bug
        # this repository has already paid for once.
        built = subprocess.run(
            [str(ROLLDOWN), str(source), "-f", "cjs", "-p", "node", "-o", str(bundle)],
            capture_output=True,
            text=True,
            cwd=MOBILE,
        )
        if built.returncode != 0:
            fail_to_measure(f"rolldown exited {built.returncode}\n{built.stderr.strip()}")

        run = subprocess.run(
            [node, str(bundle)], capture_output=True, text=True, cwd=MOBILE
        )
        if run.returncode != 0:
            fail_to_measure(f"harness exited {run.returncode}\n{run.stderr.strip()}")

        try:
            rows = json.loads(run.stdout)["rows"]
        except (ValueError, KeyError) as error:
            fail_to_measure(f"harness printed something that is not the expected JSON: {error}")

    if not rows:
        fail_to_measure("the roster came back empty")
    return rows


def report(rows: list[dict], budget: int) -> int:
    album = budget * len(rows)
    total = sum(row["caught"] for row in rows)
    total_silhouette = sum(row["silhouette"] for row in rows)
    over = [row for row in rows if row["worst"] > budget]

    width = max(len(row["id"]) for row in rows)
    print(f"{'creature'.ljust(width)}  element  stage  shapes  grads  stops  caught  silhouette")
    print("-" * (width + 58))
    # Roster order, not sorted by cost: the order is fixed by the engine, so the
    # table diffs cleanly between runs and between commits.
    for row in rows:
        flag = "  OVER" if row["worst"] > budget else ""
        print(
            f"{row['id'].ljust(width)}  {row['element']:<7}  {row['stage']:>5}  "
            f"{row['shapes']:>6}  {row['gradients']:>5}  {row['stops']:>5}  "
            f"{row['caught']:>6}  {row['silhouette']:>10}{flag}"
        )

    heaviest = max(rows, key=lambda row: (row["worst"], row["id"]))
    print()
    print(f"creatures            {len(rows)}")
    print(f"album, all caught    {total} SVG nodes")
    print(f"album, none caught   {total_silhouette} SVG nodes")
    print(f"mean per creature    {total // len(rows)} SVG nodes")
    print(f"heaviest creature    {heaviest['id']} at {heaviest['worst']} SVG nodes")
    print(f"per-creature budget  {budget}")
    print(f"album budget         {album}")

    if over:
        print()
        for row in over:
            print(
                f"OVER BUDGET: {row['id']} draws {row['worst']} SVG nodes, "
                f"budget is {budget}",
                file=sys.stderr,
            )
        return 1

    if total > album:
        print()
        print(
            f"OVER BUDGET: the album draws {total} SVG nodes, budget is {album}",
            file=sys.stderr,
        )
        return 1

    print()
    print(f"OK: every creature is inside {budget}, and the album is inside {album}.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--budget",
        type=int,
        default=PER_CREATURE_BUDGET,
        help=f"per-creature SVG node cap (default {PER_CREATURE_BUDGET})",
    )
    parser.add_argument("--json", action="store_true", help="print the raw measurements")
    args = parser.parse_args()

    if args.budget < 1:
        print("album_cost: --budget must be at least 1", file=sys.stderr)
        return 2

    rows = measure()

    if args.json:
        total = sum(row["caught"] for row in rows)
        print(
            json.dumps(
                {
                    "creatures": len(rows),
                    "perCreatureBudget": args.budget,
                    "albumBudget": args.budget * len(rows),
                    "totalCaught": total,
                    "totalSilhouette": sum(row["silhouette"] for row in rows),
                    "over": [row["id"] for row in rows if row["worst"] > args.budget],
                    "rows": rows,
                },
                indent=1,
                sort_keys=True,
            )
        )
        return 1 if any(row["worst"] > args.budget for row in rows) or total > args.budget * len(rows) else 0

    return report(rows, args.budget)


if __name__ == "__main__":
    raise SystemExit(main())
