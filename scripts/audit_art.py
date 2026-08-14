#!/usr/bin/env python3
"""Audit the procedural creature art at the roster level, and fail on a violation.

Why this exists
---------------
There are no image files in this repository. Every one of the 36 creatures is
compiled from its `ArtSpec` by `src/lib/game/art.ts` into a `Drawing` - primitive
shapes and gradients - which each client renders (web via inline SVG, iOS via
react-native-svg).

That design has one nasty failure mode: **nothing looks like art**. A missing
branch in `art.ts` returns an empty array, a dangling gradient reference paints
black or nothing, a shape with `fill: 'none'` and no stroke occupies space in the
tree and draws air. None of it throws, and a unit test that counts "more than
ten shapes" sails straight past it. It has bitten twice already:

  * a feature whose branch drew nothing, which is why `art.test.ts` now asserts
    each feature produces *more* shapes than not using it; and
  * the album silhouette leak - `toSilhouette`/`greyOut` were meant to hide
    un-caught creatures, but crowns, ears and tails paint straight from the
    palette and only the body gradient was greyed, so the album spoiled every
    creature the child had not caught yet. **That test passed while it was
    broken.**

Per-feature unit tests cannot see either class of problem across the whole
roster: they check one feature on one sample creature. This script checks
properties *of the roster as a whole* - that no two creatures render the same,
that no shape is invisible, that no silhouette carries a colour, that every
`ArtSpec` value a creature actually declares changes what is drawn.

Properties
----------
P1  distinct        Every creature's canonicalised Drawing hashes differently,
                    and so does every creature's bare geometry with palette and
                    scale removed. Two creatures rendering identically is
                    invisible in code review and obvious to a child.
P2  drawable        No empty or degenerate output: a non-trivial leaf count, all
                    numbers finite, no zero-area or off-canvas geometry, nothing
                    painted with neither a fill nor a stroke, opacities in range.
P3  gradients       Every `grad:` reference resolves to a gradient the same
                    Drawing defines, every defined gradient is referenced, and no
                    two creatures share a gradient id (they share one SVG
                    document during a battle).
P4  silhouette      A silhouetted creature carries no palette colour anywhere -
                    fills, strokes *and* gradient stops - and no saturated colour
                    at all, so a derived shade cannot leak either. This is the
                    bug that shipped.
P5  evolution       Within each of the 12 lines the three stages are visibly
                    related but not identical, and later stages loom larger.
P6  honoured        For every `ArtSpec` value the roster actually uses, removing
                    it changes the Drawing of every creature that declares it,
                    and no two values of the same feature draw the same thing. A
                    value that changes nothing is a missing branch in `art.ts`;
                    a value that draws what its neighbour draws is a `case` that
                    fell through, and both render as "this creature is fine".

How it runs the engine
----------------------
`src/lib/game/` is pure TypeScript with no React, DOM or Node dependencies, so
it is bundled with the repo's own esbuild and executed under plain node. No test
runner, no network, and nothing under `mobile/` is touched - the root CI job does
not install `mobile/node_modules`.

Determinism
-----------
No wall clock, no randomness, no set iteration leaking into output: every list is
sorted before printing and every number is rounded before hashing. Two runs on
the same commit print byte-identical output.

Exit status
-----------
0  every property holds.
1  at least one property is violated. Each violation is named by its property.
2  the harness could not be built or run.

Note on shelling out: every subprocess is invoked with an explicit argv list and
its return code is checked directly. Nothing is piped through `head`/`tail`,
because a pipeline reports the exit status of its *last* command and that has
already hidden a real failure in this repo once.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ESBUILD = REPO_ROOT / "node_modules" / ".bin" / "esbuild"

# --- thresholds, all deliberate -------------------------------------------
#
# MIN_LEAVES: a body, its shading, two eyes, a mouth and two cheeks is already
# nine leaves before a single feature, so anything under twelve means a creature
# lost most of itself. A silhouette legitimately drops aura, texture and pattern,
# and the sparsest legitimate one - a coiled serpent - is a shadow, an underlay,
# a body, a highlight, one pair of sleepy eyes, a mouth and two cheeks.
MIN_LEAVES = 12
MIN_SILHOUETTE_LEAVES = 8

# The silhouette ramp `toSilhouette` maps every colour onto, by luminance.
# Mirrored here on purpose: the property being audited is that *every* colour in
# a silhouette went through that function, so the auditor has to know what its
# output looks like. If the ramp in art.ts moves, this moves with it.
SILHOUETTE_RAMP_LO = (0x1E, 0x29, 0x3B)
SILHOUETTE_RAMP_HI = (0x64, 0x74, 0x8B)

# Colours a silhouette is allowed to carry that are not ramp output: the fixed
# silhouette body gradient and the ground shadow, neither of which is derived
# from a palette.
SILHOUETTE_CONSTANTS = {"#334155", "#1e293b", "#0f172a", "#000000"}

# Reported, not enforced: the widest channel spread the ramp itself can produce
# is 39/255 = 0.153, so a silhouette that stays on the ramp stays below this.
MAX_SILHOUETTE_CHROMA = 0.18

# Coordinates live in a `0 0 100 100` viewBox. Features overhang it (a crown
# starts at y=2, wings reach x=98), but a shape whose every coordinate sits this
# far outside is off-canvas and therefore invisible.
CANVAS_MARGIN = 60

GRADIENT_REF = "grad:"

HARNESS = r"""
import { drawCreature } from '@engine/art';
import { CREATURES } from '@engine/creatures';

/**
 * The neutral value of each optional feature. Setting a feature to its neutral
 * value is how this harness asks "does declaring this value change anything?".
 */
const NEUTRAL = {
  crown: 'none',
  tail: 'none',
  pattern: 'none',
  texture: 'smooth',
  ears: 'none',
  wings: 'none',
  aura: 'none',
};

const withArt = (creature, art) => ({ ...creature, art: { ...creature.art, ...art } });

const sortedUsed = (key) => [...new Set(CREATURES.map((c) => c.art[key]))].sort();

// `shape` and `eyes` have no neutral value, so the probe is every *other* value
// the roster uses: declaring 'serpent' must not draw what 'blob' draws.
const shapes = sortedUsed('shape');
const eyeStyles = sortedUsed('eyes');

const creatures = CREATURES.map((creature) => ({
  id: creature.id,
  name: creature.name.en,
  lineId: creature.lineId,
  element: creature.element,
  stage: creature.stage,
  art: creature.art,
  drawing: drawCreature(creature),
  silhouette: drawCreature(creature, { silhouette: true }),
}));

const variants = [];
const probe = (creature, feature, replacement) => {
  variants.push({
    creature: creature.id,
    feature,
    value: creature.art[feature],
    replacement,
    drawing: drawCreature(withArt(creature, { [feature]: replacement })),
  });
};

for (const creature of CREATURES) {
  for (const [feature, neutral] of Object.entries(NEUTRAL)) {
    if (creature.art[feature] !== neutral) probe(creature, feature, neutral);
  }
  for (const alt of shapes) if (alt !== creature.art.shape) probe(creature, 'shape', alt);
  for (const alt of eyeStyles) if (alt !== creature.art.eyes) probe(creature, 'eyes', alt);
  // Scale is a number rather than an enum; a fixed nudge keeps this a literal.
  probe(creature, 'scale', creature.art.scale + 0.1);
}

// One neutral base creature wearing exactly one declared value at a time. This
// is what separates "crown: 'antler'" drawing nothing from it drawing the horn -
// both leave the roster looking healthy, and neither shows up in a shape count.
const FEATURES = ['shape', 'eyes', 'crown', 'tail', 'pattern', 'texture', 'ears', 'wings', 'aura'];
const base = { ...CREATURES[0], art: { ...CREATURES[0].art, ...NEUTRAL } };

const probes = [];
for (const feature of FEATURES) {
  for (const value of sortedUsed(feature)) {
    probes.push({
      feature,
      value,
      drawing: drawCreature(withArt(base, { [feature]: value })),
    });
  }
}

process.stdout.write(JSON.stringify({ creatures, variants, probes }));
"""


def die(message: str, code: int = 2) -> None:
    print(f"audit_art: {message}", file=sys.stderr)
    raise SystemExit(code)


def run_engine() -> dict:
    """Bundle the pure engine with esbuild and execute it under node."""
    if not ESBUILD.exists():
        die(f"esbuild not found at {ESBUILD}. Run `npm install` first.")

    workdir = Path(tempfile.mkdtemp(prefix="mathmon-art-"))
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

        run = subprocess.run(
            ["node", str(bundle)],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
        )
        if run.returncode != 0:
            die(f"art harness failed (exit {run.returncode}):\n{run.stderr.strip()}")

        try:
            return json.loads(run.stdout)
        except json.JSONDecodeError as exc:
            die(f"harness produced non-JSON output: {exc}")
            raise
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Drawing helpers
# ---------------------------------------------------------------------------


def flatten(shapes: list) -> list:
    """Every leaf shape, groups expanded. Mirrors `flattenShapes` in art.ts."""
    out = []
    for shape in shapes:
        if shape.get("kind") == "group":
            out.extend(flatten(shape.get("children", [])))
        else:
            out.append(shape)
    return out


def group_transforms(shapes: list) -> list:
    """Every `transform` string on a group, so the scale can be read or removed."""
    out = []
    for shape in shapes:
        if shape.get("kind") == "group":
            if shape.get("transform"):
                out.append(shape["transform"])
            out.extend(group_transforms(shape.get("children", [])))
    return out


def _round(value: float) -> float:
    """Rounds and kills negative zero, so hashing is stable across platforms."""
    rounded = round(float(value), 4)
    return 0.0 if rounded == 0 else rounded


def canonicalise(drawing: dict, *, drop_colour: bool = False, drop_scale: bool = False) -> str:
    """A stable string for a Drawing.

    Gradient ids embed the creature id (`mm-cindik-body`), so they are renumbered
    by definition order and every reference rewritten. Without that every
    creature would hash differently for a reason a child cannot see, and P1 would
    be vacuous.
    """
    ids = {g["id"]: f"g{i}" for i, g in enumerate(drawing.get("gradients", []))}

    def paint(value):
        if not isinstance(value, str):
            return value
        if value.startswith(GRADIENT_REF):
            target = value[len(GRADIENT_REF) :]
            return GRADIENT_REF + ids.get(target, f"unresolved:{target}")
        if value == "none":
            return value
        return "colour" if drop_colour else value.lower()

    def walk(node):
        if isinstance(node, dict):
            out = {}
            for key in sorted(node):
                value = node[key]
                if key in ("fill", "stroke"):
                    out[key] = paint(value)
                elif key == "color":
                    out[key] = "colour" if drop_colour else str(value).lower()
                elif key == "id":
                    out[key] = ids.get(value, value)
                elif key == "transform" and drop_scale and isinstance(value, str):
                    out[key] = re.sub(r"scale\([^)]*\)", "scale(*)", value)
                elif isinstance(value, (int, float)) and not isinstance(value, bool):
                    out[key] = _round(value)
                else:
                    out[key] = walk(value)
            return out
        if isinstance(node, list):
            return [walk(item) for item in node]
        return node

    return json.dumps(walk(drawing), sort_keys=True, separators=(",", ":"))


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


NUMBER = re.compile(r"-?\d+(?:\.\d+)?")


def path_numbers(d: str) -> list:
    return [float(n) for n in NUMBER.findall(d)]


def expand_hex(colour: str) -> str | None:
    """`#abc` -> `#aabbcc`; None for anything that is not a plain hex colour."""
    if not isinstance(colour, str) or not colour.startswith("#"):
        return None
    body = colour[1:]
    if len(body) == 3:
        body = "".join(c * 2 for c in body)
    if len(body) != 6 or re.fullmatch(r"[0-9a-fA-F]{6}", body) is None:
        return None
    return "#" + body.lower()


def chroma(colour: str) -> float:
    """Widest channel spread, 0 (grey) to 1. Cheap, and enough to spot a palette."""
    body = expand_hex(colour)
    if body is None:
        return 0.0
    channels = [int(body[i : i + 2], 16) for i in (1, 3, 5)]
    return (max(channels) - min(channels)) / 255


def on_silhouette_ramp(colour: str) -> bool:
    """True if `toSilhouette` could have produced this colour.

    The ramp is a straight line from lo to hi parameterised by luminance, so a
    colour is on it when one `t` reproduces all three channels. A palette colour
    that happens to land on the ramp - stone-crag's slate accent does - is not a
    leak: every silhouette in the album is painted from these same greys, so the
    colour identifies nothing. A colour *off* the ramp is a leak by definition,
    because the only way to get one is to skip `toSilhouette`.
    """
    body = expand_hex(colour)
    if body is None:
        return False
    channels = [int(body[i : i + 2], 16) for i in (1, 3, 5)]

    span = SILHOUETTE_RAMP_HI[0] - SILHOUETTE_RAMP_LO[0]
    t = (channels[0] - SILHOUETTE_RAMP_LO[0]) / span
    if not 0 <= t <= 1:
        return False
    # One unit of slack: the mix rounds each channel independently.
    return all(
        abs(channels[i] - (SILHOUETTE_RAMP_LO[i] + (SILHOUETTE_RAMP_HI[i] - SILHOUETTE_RAMP_LO[i]) * t))
        <= 1
        for i in (1, 2)
    )


def paints(shape: dict) -> list:
    """The colour-bearing values on a leaf shape."""
    return [v for v in (shape.get("fill"), shape.get("stroke")) if isinstance(v, str)]


def drawing_colours(drawing: dict) -> list:
    """Every colour in a Drawing: fills, strokes *and* gradient stops.

    Checking only the gradients is exactly how the album silhouette leak passed
    its test while every un-caught creature showed its own colours through its
    crown.
    """
    out = []
    for gradient in drawing.get("gradients", []):
        for stop in gradient.get("stops", []):
            if isinstance(stop.get("color"), str):
                out.append(("gradient stop", f"{gradient['id']}@{stop.get('offset')}", stop["color"]))
    for index, shape in enumerate(flatten(drawing.get("shapes", []))):
        for key in ("fill", "stroke"):
            value = shape.get(key)
            if isinstance(value, str):
                out.append((key, f"{shape.get('kind')}#{index}", value))
    return out


# ---------------------------------------------------------------------------
# Properties
# ---------------------------------------------------------------------------


def check_distinct(creatures: list, violations: list) -> dict:
    """P1: no two creatures render the same drawing, or the same bare geometry."""
    full: dict = {}
    form: dict = {}
    hashes = {}

    for creature in creatures:
        full_hash = digest(canonicalise(creature["drawing"]))
        form_hash = digest(
            canonicalise(creature["drawing"], drop_colour=True, drop_scale=True)
        )
        hashes[creature["id"]] = {"full": full_hash, "form": form_hash}
        full.setdefault(full_hash, []).append(creature["id"])
        form.setdefault(form_hash, []).append(creature["id"])

    for key, group in sorted(full.items()):
        if len(group) > 1:
            violations.append(
                ("P1 distinct", f"{', '.join(sorted(group))} render an identical drawing ({key})")
            )
    for key, group in sorted(form.items()):
        if len(group) > 1:
            violations.append(
                (
                    "P1 distinct",
                    f"{', '.join(sorted(group))} share identical geometry once palette and "
                    f"scale are removed ({key}) - they are the same creature in two colours",
                )
            )
    return hashes


def check_drawable(creatures: list, violations: list) -> None:
    """P2: nothing renders empty, zero-area, off-canvas or paintless."""
    for creature in creatures:
        for mode, minimum in (("drawing", MIN_LEAVES), ("silhouette", MIN_SILHOUETTE_LEAVES)):
            drawing = creature[mode]
            leaves = flatten(drawing.get("shapes", []))
            label = f"{creature['id']} ({mode})"

            if len(leaves) < minimum:
                violations.append(
                    ("P2 drawable", f"{label} draws only {len(leaves)} shapes, expected >= {minimum}")
                )

            if drawing.get("viewBox") != "0 0 100 100":
                violations.append(
                    ("P2 drawable", f"{label} has viewBox {drawing.get('viewBox')!r}")
                )

            for index, shape in enumerate(leaves):
                where = f"{label} shape #{index} ({shape.get('kind')})"

                numbers = [
                    (k, v)
                    for k, v in sorted(shape.items())
                    if isinstance(v, (int, float)) and not isinstance(v, bool)
                ]
                for key, value in numbers:
                    if value != value or value in (float("inf"), float("-inf")):
                        violations.append(("P2 drawable", f"{where}: {key} is {value}"))

                for key in ("opacity", "fillOpacity"):
                    value = shape.get(key)
                    if isinstance(value, (int, float)):
                        if not 0 <= value <= 1:
                            violations.append(
                                ("P2 drawable", f"{where}: {key}={value} is outside 0..1")
                            )
                        # A zero-opacity shape is a shape that draws nothing. The
                        # silhouette uses it deliberately to drop the highlight
                        # and the cheeks, so it is only a fault in colour mode.
                        elif value == 0 and mode == "drawing":
                            violations.append(
                                ("P2 drawable", f"{where}: {key}=0, so it renders nothing")
                            )

                fill = shape.get("fill")
                stroke = shape.get("stroke")
                painted = (fill not in (None, "none")) or (stroke not in (None, "none"))
                if not painted:
                    violations.append(
                        (
                            "P2 drawable",
                            f"{where}: neither fill nor stroke, so it occupies the tree "
                            f"and draws nothing",
                        )
                    )
                if stroke not in (None, "none") and shape.get("strokeWidth", 0) <= 0:
                    violations.append(
                        ("P2 drawable", f"{where}: stroke {stroke} with strokeWidth "
                                        f"{shape.get('strokeWidth', 0)}")
                    )

                coords: list = []
                kind = shape.get("kind")
                if kind == "ellipse":
                    for key in ("rx", "ry"):
                        if not shape.get(key, 0) > 0:
                            violations.append(
                                ("P2 drawable", f"{where}: {key}={shape.get(key)} is zero-area")
                            )
                    coords = [shape.get("cx", 0), shape.get("cy", 0)]
                elif kind == "circle":
                    if not shape.get("r", 0) > 0:
                        violations.append(
                            ("P2 drawable", f"{where}: r={shape.get('r')} is zero-area")
                        )
                    coords = [shape.get("cx", 0), shape.get("cy", 0)]
                elif kind == "rect":
                    for key in ("width", "height"):
                        if not shape.get(key, 0) > 0:
                            violations.append(
                                ("P2 drawable", f"{where}: {key}={shape.get(key)} is zero-area")
                            )
                    coords = [shape.get("x", 0), shape.get("y", 0)]
                elif kind == "path":
                    d = shape.get("d", "")
                    if not isinstance(d, str) or not d.strip():
                        violations.append(("P2 drawable", f"{where}: empty path"))
                        continue
                    if re.search(r"NaN|undefined|null|Infinity", d):
                        violations.append(("P2 drawable", f"{where}: path contains {d!r}"))
                        continue
                    if re.search(r"[A-LN-Yac-ln-y]", d) is None:
                        # Only moveto and closepath: a path that goes nowhere.
                        violations.append(("P2 drawable", f"{where}: path draws no segment: {d!r}"))
                    coords = path_numbers(d)
                else:
                    violations.append(("P2 drawable", f"{where}: unknown shape kind"))

                if coords and all(
                    c < -CANVAS_MARGIN or c > 100 + CANVAS_MARGIN for c in coords
                ):
                    violations.append(
                        ("P2 drawable", f"{where}: every coordinate is off-canvas ({coords[:4]})")
                    )


def check_gradients(creatures: list, violations: list) -> None:
    """P3: references resolve, definitions are used, ids are globally unique."""
    owners: dict = {}

    for creature in creatures:
        for mode in ("drawing", "silhouette"):
            drawing = creature[mode]
            defined = [g["id"] for g in drawing.get("gradients", [])]
            label = f"{creature['id']} ({mode})"

            for gradient in drawing.get("gradients", []):
                if not gradient.get("stops"):
                    violations.append(
                        ("P3 gradients", f"{label}: gradient {gradient['id']} has no stops")
                    )
                for stop in gradient.get("stops", []):
                    if expand_hex(stop.get("color")) is None:
                        violations.append(
                            (
                                "P3 gradients",
                                f"{label}: gradient {gradient['id']} stop "
                                f"{stop.get('offset')} is {stop.get('color')!r}",
                            )
                        )

            referenced = set()
            for shape in flatten(drawing.get("shapes", [])):
                for value in paints(shape):
                    if value.startswith(GRADIENT_REF):
                        target = value[len(GRADIENT_REF) :]
                        referenced.add(target)
                        if target not in defined:
                            violations.append(
                                (
                                    "P3 gradients",
                                    f"{label}: references gradient {target!r} which the drawing "
                                    f"never defines - it renders as nothing or black",
                                )
                            )

            for gradient_id in sorted(set(defined) - referenced):
                violations.append(
                    (
                        "P3 gradients",
                        f"{label}: defines gradient {gradient_id} that nothing references",
                    )
                )

            # Both fighters share one SVG document during a battle, so a
            # duplicated id makes one creature wear the other's colours.
            if mode == "drawing":
                for gradient_id in defined:
                    if gradient_id in owners and owners[gradient_id] != creature["id"]:
                        violations.append(
                            (
                                "P3 gradients",
                                f"gradient id {gradient_id} is used by both "
                                f"{owners[gradient_id]} and {creature['id']}",
                            )
                        )
                    owners.setdefault(gradient_id, creature["id"])


def check_silhouette(creatures: list, violations: list) -> dict:
    """P4: a silhouette carries no palette colour and no saturated colour at all.

    Written against the shipped bug: `toSilhouette` greyed the body gradient but
    the crown, ears, tail and wings paint straight from the palette, so an
    un-caught album slot still told the child exactly which creature was missing.

    So the check is a whitelist, not a blacklist: every fill, every stroke *and*
    every gradient stop must be a colour `toSilhouette` could have produced, or
    one of the fixed silhouette constants. Blacklisting the palette instead is
    both too weak (it misses `shade(accent, 0.35)`, which is still recognisably
    the creature's colour) and too strong (stone-crag's accent is itself a slate
    grey that sits on the ramp, and flagging it would be a false alarm).
    """
    worst = {"chroma": 0.0, "colour": "-", "creature": "-"}

    for creature in sorted(creatures, key=lambda c: c["id"]):
        palette = {
            expand_hex(creature["art"][key]): key
            for key in ("primary", "secondary", "accent")
        }

        for role, where, raw in drawing_colours(creature["silhouette"]):
            if raw == "none" or raw.startswith(GRADIENT_REF):
                continue
            colour = expand_hex(raw)
            if colour is None:
                violations.append(
                    (
                        "P4 silhouette",
                        f"{creature['id']}: {role} {where} is {raw!r}, not a hex colour",
                    )
                )
                continue

            if chroma(colour) > worst["chroma"]:
                worst = {
                    "chroma": chroma(colour),
                    "colour": colour,
                    "creature": creature["id"],
                }

            if colour in SILHOUETTE_CONSTANTS or on_silhouette_ramp(colour):
                continue

            if colour in palette:
                reason = f"its own {palette[colour]} palette colour"
            elif chroma(colour) > MAX_SILHOUETTE_CHROMA:
                reason = f"a saturated colour (chroma {chroma(colour):.2f})"
            else:
                reason = "off the silhouette ramp, so it never went through toSilhouette"
            violations.append(
                (
                    "P4 silhouette",
                    f"{creature['id']} shows {colour} through {role} of {where} - {reason}. "
                    f"An un-caught album slot must not tell the child what is missing",
                )
            )

    return worst


def check_evolution(creatures: list, hashes: dict, violations: list) -> list:
    """P5: within a line the stages are related but not identical, and grow."""
    lines: dict = {}
    for creature in creatures:
        lines.setdefault(creature["lineId"], []).append(creature)

    rows = []
    for line_id in sorted(lines):
        stages = sorted(lines[line_id], key=lambda c: c["stage"])
        if [c["stage"] for c in stages] != [1, 2, 3]:
            violations.append(
                ("P5 evolution", f"{line_id} does not have exactly stages 1, 2, 3")
            )
            continue

        for a, b in ((0, 1), (1, 2), (0, 2)):
            first, second = stages[a], stages[b]
            if hashes[first["id"]]["full"] == hashes[second["id"]]["full"]:
                violations.append(
                    (
                        "P5 evolution",
                        f"{line_id}: {first['id']} (stage {first['stage']}) and "
                        f"{second['id']} (stage {second['stage']}) render identically",
                    )
                )
            if hashes[first["id"]]["form"] == hashes[second["id"]]["form"]:
                violations.append(
                    (
                        "P5 evolution",
                        f"{line_id}: {first['id']} and {second['id']} differ only in size - "
                        f"evolving is meant to look like a promotion",
                    )
                )

        for earlier, later in zip(stages, stages[1:]):
            if not later["art"]["scale"] > earlier["art"]["scale"]:
                violations.append(
                    (
                        "P5 evolution",
                        f"{line_id}: {later['id']} (scale {later['art']['scale']}) does not "
                        f"loom larger than {earlier['id']} (scale {earlier['art']['scale']})",
                    )
                )

        counts = [len(flatten(c["drawing"]["shapes"])) for c in stages]
        features = [
            sum(
                1
                for key, neutral in (
                    ("crown", "none"),
                    ("tail", "none"),
                    ("pattern", "none"),
                    ("texture", "smooth"),
                    ("ears", "none"),
                    ("wings", "none"),
                    ("aura", "none"),
                )
                if c["art"][key] != neutral
            )
            for c in stages
        ]
        rows.append(
            {
                "line": line_id,
                "ids": [c["id"] for c in stages],
                "counts": counts,
                "features": features,
                "scales": [c["art"]["scale"] for c in stages],
            }
        )

    return rows


def check_honoured(
    creatures: list, variants: list, probes: list, hashes: dict, violations: list
) -> dict:
    """P6: every ArtSpec value the roster uses changes the drawing.

    `art.test.ts` proves each *feature* draws more shapes than not using it, on
    one sample creature. Two things slip past that, and both are checked here:

      * a value that draws nothing *in context* - a branch that works on a blob
        and returns an empty array for a serpent, say, which a single-sample
        count test never sees. Hence the per-creature probes.
      * a value that draws what a *different* value draws, because a `case` fell
        through or was copied and not edited. The shape count is identical, so a
        count test is blind to it, and a reviewer reads two plausible names.
        Hence the pairwise probes on a neutral base.
    """
    by_creature = {c["id"]: c for c in creatures}
    covered: dict = {}

    by_feature: dict = {}
    for probe in probes:
        by_feature.setdefault(probe["feature"], []).append(probe)

    for feature in sorted(by_feature):
        seen: dict = {}
        for probe in by_feature[feature]:
            key = digest(canonicalise(probe["drawing"]))
            if key in seen:
                violations.append(
                    (
                        "P6 honoured",
                        f"{feature}={probe['value']!r} draws exactly what "
                        f"{feature}={seen[key]!r} draws - a `case` in art.ts fell through, "
                        f"so one of the two names is a lie",
                    )
                )
            seen.setdefault(key, probe["value"])

    for variant in variants:
        creature = by_creature[variant["creature"]]
        before = hashes[creature["id"]]["full"]
        after = digest(canonicalise(variant["drawing"]))
        feature = variant["feature"]
        value = variant["value"]

        covered.setdefault(feature, set()).add(str(value))

        if before == after:
            violations.append(
                (
                    "P6 honoured",
                    f"{creature['id']}: {feature}={value!r} draws exactly the same as "
                    f"{feature}={variant['replacement']!r} - the branch in art.ts is missing "
                    f"or draws nothing",
                )
            )

    return covered


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------


def print_roster(creatures: list, hashes: dict) -> None:
    width = max(len(c["id"]) for c in creatures)
    print()
    print("  creature".ljust(width + 4), "st  shapes  silh  colours  drawing  geometry")
    print(f"  {'-' * (width + 44)}")
    for creature in creatures:
        leaves = len(flatten(creature["drawing"]["shapes"]))
        silhouette = len(flatten(creature["silhouette"]["shapes"]))
        colours = len({c for _, _, c in drawing_colours(creature["drawing"])})
        print(
            f"  {creature['id']:<{width}}  {creature['stage']}   "
            f"{leaves:>5}  {silhouette:>4}  {colours:>7}  "
            f"{hashes[creature['id']]['full'][:8]}  {hashes[creature['id']]['form'][:8]}"
        )


def print_lines(rows: list) -> None:
    width = max(len(r["line"]) for r in rows)
    print()
    print("  evolution lines   (shapes / declared features, stage 1 -> 2 -> 3)")
    print(f"  {'-' * (width + 44)}")
    for row in rows:
        counts = " -> ".join(str(c) for c in row["counts"])
        features = " -> ".join(str(f) for f in row["features"])
        trend = "" if row["counts"] == sorted(row["counts"]) else "   (not monotonic)"
        print(f"  {row['line']:<{width}}  shapes {counts:<16} features {features}{trend}")


def print_coverage(covered: dict) -> None:
    print()
    print("  ArtSpec values exercised (every one changes the drawing that declares it)")
    for feature in sorted(covered):
        if feature == "scale":
            continue
        values = ", ".join(sorted(covered[feature]))
        print(f"    {feature:<9} {values}")


def main() -> int:
    data = run_engine()
    creatures = data["creatures"]
    variants = data["variants"]
    probes = data["probes"]

    if not creatures:
        die("harness returned an empty roster")

    violations: list = []

    hashes = check_distinct(creatures, violations)
    check_drawable(creatures, violations)
    check_gradients(creatures, violations)
    worst = check_silhouette(creatures, violations)
    lines = check_evolution(creatures, hashes, violations)
    covered = check_honoured(creatures, variants, probes, hashes, violations)

    print("Mathmon art audit")
    print("=================")
    print(
        f"creatures: {len(creatures)}   lines: {len(lines)}   "
        f"spec variants probed: {len(variants) + len(probes)}"
    )
    print("no image files: every creature below is compiled from its ArtSpec by art.ts")

    print_roster(creatures, hashes)
    print_lines(lines)
    print_coverage(covered)

    print()
    print(
        f"  most saturated colour surviving a silhouette: {worst['colour']} "
        f"(chroma {worst['chroma']:.3f}, on {worst['creature']}, limit {MAX_SILHOUETTE_CHROMA})"
    )

    print()
    if violations:
        print("FAIL")
        for prop, message in sorted(violations):
            print(f"  {prop}: {message}")
        print()
        print(f"  {len(violations)} violation(s) across "
              f"{len(sorted({p for p, _ in violations}))} propert(ies)")
        return 1

    print("OK: P1 distinct, P2 drawable, P3 gradients, P4 silhouette, "
          "P5 evolution, P6 honoured.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
