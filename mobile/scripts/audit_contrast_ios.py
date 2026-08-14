#!/usr/bin/env python3
"""
WCAG colour-contrast audit for the **iOS** client.

Why this exists
---------------
`scripts/audit_contrast.py` proved the web client's colours are readable, and
found real damage doing it: a submit key at 1.94:1, a PIN placeholder at
1.86:1, thirteen `slate-500` labels between 2.73 and 3.62. That script's own
`--unchecked` list ends with an admission:

    the iOS client
    `mobile/` has its own palette in `mobile/src/theme.ts` and its own
    renderer. Auditing it belongs here one day, but the root CI job does not
    install `mobile/node_modules`, and nothing at the root should grow a reason
    to reach across that boundary.

This is that day, from the other side of the boundary. Nothing here needs
`mobile/node_modules`, or `node`, or a bundler: it reads TypeScript as plain
text, exactly as `mobile/scripts/audit_parity.py` does, for exactly the reason
that script gives. Two CI outages in this repository came from root tooling
reaching into `mobile/`; this reaches for nothing.

The two clients share a palette (`ELEMENT_STYLE`) and a visual language, but
not a stylesheet, so "the web is green" said nothing at all about this client.
It was not green. The same three failures were live here.

What it checks
--------------
  text-contrast      every `<Text>` whose colour and background both resolve
                     statically meets 4.5:1, or 3:1 when the text is large
                     (fontSize >= 24, or >= 18.66 at fontWeight >= 700).
                     `placeholderTextColor` is judged the same way, against the
                     input's own surface. Every finding names the rule it was
                     judged by, with the size and weight it inherited.
  element-contrast   the six element palettes as chip labels. An `ElementChip`
                     writes its label in the element's own colour on a surface
                     tinted with that same colour, so the pair moves together
                     and has to be judged element by element - see "Correlated
                     branches" below.
  meter-contrast     a meter's fill against its own track, at 3:1 (WCAG 1.4.11,
                     non-text contrast). How full a bar is *is* the
                     information. HP, XP, the maths tier, the per-skill
                     accuracy bars and the speed meter are all one idiom here:
                     a childless coloured `<View>` inside a `<View>` with
                     `overflow: 'hidden'`.
  threshold          the ratios above are constants of WCAG 2.1, not of this
                     repository. They are *imported* from the web audit rather
                     than restated, and the run refuses to start if either copy
                     has been lowered.

What it does NOT restate
------------------------
Nothing here types out a colour. The arithmetic - OKLCH decode, sRGB relative
luminance, source-over compositing, the contrast ratio itself, and the
`Binding` machinery for correlated branches - is *imported* from
`scripts/audit_contrast.py`, and the JSX and `StyleSheet.create` scanners from
`scripts/audit_a11y.py`, which already reads this client's styles for tap
targets. A second copy of a WCAG formula is a copy that can disagree with the
one the other client is measured by, and "both clients are accessible" is
worthless if the two are grading on different curves. If those modules move,
this exits 2 rather than falling back to a private copy.

The colours themselves come from `mobile/src/theme.ts` (the `colors` token
object and the `tint`/`mix` helpers), `mobile/App.tsx` (the app background),
`mobile/src/ui/kit.tsx` (the `Panel` surface and its glow), and
`src/lib/game/elements.ts` (the six element palettes, shared with the web).

How this differs from the web audit
-----------------------------------
The two scripts answer the same question - "what colour is this text, and what
is behind it" - but React Native's model is not CSS, so the resolution is
different in five ways that matter:

1. **Styles are objects, not class names.** There is no Tailwind ramp and no
   OKLCH here; every colour is a hex or `rgba()` literal, reached through
   `colors.*` in `theme.ts`. So the class-token half of the web script is
   replaced by a `StyleSheet.create` parser (borrowed from `audit_a11y.py`,
   which already needs one).

2. **`style` is an ordered array and later entries win, per property.**
   `style={[styles.choice, active ? styles.choiceOn : styles.choiceOff]}`
   is a flatten, not a union: the web can collect every `bg-*` token it sees
   and take the worst, but here a later `backgroundColor` genuinely *replaces*
   the earlier one and taking the worst would report a surface that never
   renders. So entries are flattened left to right within each branch.

3. **Colour does not inherit through the tree.** On the web every element
   inherits `color` from `<body>`. Here only a `<Text>` inside another `<Text>`
   inherits; a `<Text>` inside a `<View>` inherits nothing. A `<Text>` that
   declares no colour is therefore *not* judged against a guessed default - it
   goes to NEEDS REVIEW, because the only text in this client that does it is
   an emoji, which brings its own colours.

4. **Backgrounds are opaque surfaces, not a body gradient.** There is one root
   surface (`App.tsx`'s `SafeAreaView`), so no "two roots" guess is needed for
   a screen. Shared widgets under `src/ui/` are the exception: they are dropped
   onto the bare app background, onto a `Panel`, and onto an element-glowed
   `Panel`, so all of those are candidates and the worst wins.

5. **A component's surface is a component, not a utility class.** `<Panel>` is
   a real element in the tree, so its surface is composited when the walk
   crosses it - including `glow`, whose tint alpha is read out of `kit.tsx`
   rather than restated. A `style` prop forwarded into a component's root view
   is resolved from that component's actual call sites, not assumed to be
   empty.

Correlated branches
-------------------
Taken wholesale from the web script, because the trap is identical.
`backgroundColor: tint(style.color, 0.22)` with `color: style.color` is not two
unknowns; it is one unknown ranging over six known colours, and pairing an
Ember label with a Frost tint would invent a violation that cannot happen. The
same is true of `active ? styles.choiceOn : styles.choiceOff` paired with
`active && styles.choiceTextOn`, and of `const colour = ratio > 0.5 ?
colors.good : ...` in `HealthBar`.

So every colour carries a *binding*: a set of (name, value) assignments such as
`{style=stone}` or `{active=true}`. Two colours are only ever compared when
their bindings agree on every name they share, and each finding prints the
binding it was found under.

The one place this script is deliberately stricter than the source is a shared
widget's surface: `<ElementChip>` in `kit.tsx` cannot see which `<Panel glow=`
it was dropped into, so all six glows are tried against all six chips. That
errs towards demanding more contrast than one call site strictly needs, which
is the only direction an audit may err in - and the fix that makes a chip
opaque removes the dependency entirely rather than arguing about it.

What static analysis can and cannot prove
-----------------------------------------
Same discipline as `audit_parity.py` and the web contrast audit. A pair whose
two ends are both literal is a provable violation and fails the build. A colour
that only exists at runtime is not judged; it goes in NEEDS REVIEW, which is
printed and never fails the build. Guessing there would produce false alarms,
and an audit people learn to ignore enforces nothing.

Usage
-----
    python3 mobile/scripts/audit_contrast_ios.py             # verify
    python3 mobile/scripts/audit_contrast_ios.py --pairs     # every pair resolved
    python3 mobile/scripts/audit_contrast_ios.py --unchecked # what this misses

Exit status
-----------
0  every property holds.
1  at least one property is violated; each finding names the property it broke
   and prints the computed ratio.
2  the audit itself could not run (a source file is missing or has been
   restructured past recognition, the shared arithmetic cannot be imported, or
   a WCAG threshold has been lowered). A failure to measure is never a pass.

Which CI job
------------
The iOS one. It needs no `mobile/node_modules` and would survive in the root
job, but it belongs next to the other iOS checks.

Determinism
-----------
Standard library only. No clock, no randomness, no environment lookups, no
network, no subprocess. Files are walked in sorted order and findings are
sorted, so two runs on the same tree print byte-identical output.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

MOBILE = Path(__file__).resolve().parent.parent
REPO = MOBILE.parent

sys.path.insert(0, str(REPO / "scripts"))


def broke(message: str) -> "None":
    print(f"audit_contrast_ios: could not run the audit: {message}", file=sys.stderr)
    raise SystemExit(2)


try:
    # The JSX scanner and the StyleSheet parser. `audit_a11y.py` already reads
    # this client's styles to measure tap targets, so it is the same problem
    # solved once rather than a second parser that can drift from it.
    from audit_a11y import (
        attr_raw,
        direct_children,
        find_tag_end,
        iter_entries,
        parse_props,
    )
except ImportError as error:  # pragma: no cover - only when a file is missing
    broke(f"cannot import the JSX/StyleSheet scanner from scripts/audit_a11y.py: {error}")

try:
    # The colour arithmetic and the correlated-branch machinery. Imported, not
    # copied: two clients graded by two copies of a WCAG formula is exactly the
    # drift these audits exist to prevent.
    from audit_contrast import (
        BOLD,
        FREE,
        LARGE_BOLD_PX,
        LARGE_MIN,
        LARGE_PX,
        MAX_VARIANTS,
        NON_TEXT_MIN,
        NORMAL_MIN,
        Binding,
        Finding,
        Node,
        Rgba,
        composite,
        compatible,
        contrast_ratio,
        jsx_nodes,
        merge,
        parse_hex,
        rgb_hex,
        show,
        wrap,
    )
except ImportError as error:  # pragma: no cover - only when a file is missing
    broke(f"cannot import the colour arithmetic from scripts/audit_contrast.py: {error}")

try:
    # Blanked rather than deleted, so every reported line number still points
    # at the real line. Several comments in this client quote the bug they
    # record; CLAUDE.md asks that those survive, so a scanner must not read them.
    from audit_i18n import blank_comments
except ImportError as error:  # pragma: no cover - only when a file is missing
    broke(f"cannot import blank_comments from scripts/audit_i18n.py: {error}")


RGB = tuple[int, int, int]

THEME = MOBILE / "src" / "theme.ts"
KIT = MOBILE / "src" / "ui" / "kit.tsx"
APP = MOBILE / "App.tsx"
ELEMENTS = REPO / "src" / "lib" / "game" / "elements.ts"

SCAN_ROOTS = (MOBILE / "src" / "screens", MOBILE / "src" / "ui")

# React Native's own defaults for a `<Text>` that sets neither.
DEFAULT_FONT_PX = 14.0
DEFAULT_WEIGHT = 400

# Tags that render words. `TextInput` earns its place twice over: the value the
# child types and the placeholder behind it are two different colours on one
# surface, and the web audit found its worst pair in exactly that second one.
TEXT_TAGS = {"Text", "Animated.Text", "TextInput"}

# Components defined in `src/ui/` whose surface the walk has to cross. Only
# `Panel` paints; the rest are leaves as far as any screen is concerned,
# because they are audited in the file that defines them.
PANEL_COMPONENT = "Panel"

# Values that mean "this declaration paints nothing", as opposed to "this
# declaration paints something I cannot read".
NO_PAINT = {"", "undefined", "null", "false", "none", "transparent", "inherit", "initial", "unset"}


class Unresolvable(Exception):
    """A colour that only exists at runtime. Reported, never guessed at."""


# --------------------------------------------------------------------------
# The palette, all read from source
# --------------------------------------------------------------------------

COLOR_TOKEN = re.compile(r"([A-Za-z][\w]*)\s*:\s*'(#[0-9a-fA-F]{3,8})'")
ELEMENT_ENTRY = re.compile(r"(\w+)\s*:\s*\{\s*color:\s*'(#[0-9a-fA-F]{6})'\s*,\s*deep:\s*'(#[0-9a-fA-F]{6})'")


@dataclass
class Palette:
    named: dict[str, Rgba] = field(default_factory=dict)  # 'gold' -> Rgba
    elements: dict[str, Rgba] = field(default_factory=dict)  # 'ember' -> Rgba
    element_deep: dict[str, Rgba] = field(default_factory=dict)
    app_background: RGB = (0, 0, 0)
    panel: Rgba | None = None
    glow_alpha: float | None = None


def read(path: Path) -> str:
    if not path.is_file():
        broke(f"{path.relative_to(REPO)} is missing")
    return blank_comments(path.read_text(encoding="utf-8"))


def rel(path: Path) -> str:
    return str(path.relative_to(REPO))


def stylesheets(source: str) -> dict[str, dict[str, str]]:
    """`StyleSheet.create` bodies, as {style name: {property: raw value}}.

    `audit_a11y.parse_stylesheets` takes a tap threshold it only uses to
    evaluate numbers; nothing here asks it for one, so the raw property strings
    are read directly through the same `iter_entries`/`parse_props` pair.
    """
    sheets: dict[str, dict[str, str]] = {}
    for match in re.finditer(r"StyleSheet\.create\(\s*\{", source):
        start = match.end() - 1
        depth = 0
        i = start
        while i < len(source):
            if source[i] == "{":
                depth += 1
            elif source[i] == "}":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        for name, props in iter_entries(source[start + 1 : i]):
            sheets[name] = parse_props(props, 0)
    return sheets


def load_theme(palette: Palette) -> None:
    source = read(THEME)
    block = re.search(r"export const colors\s*=\s*\{(.*?)\n\}", source, re.S)
    if not block:
        broke(f"{rel(THEME)} has no `export const colors = {{...}}` block")
    for name, value in COLOR_TOKEN.findall(block.group(1)):
        colour = parse_hex(value)
        if colour is not None:
            palette.named[name] = colour
    for required in ("bg", "panel", "text"):
        if required not in palette.named:
            broke(f"{rel(THEME)} names no `{required}` colour; the palette could not be read")

    # `tint(hex, alpha)` is how every translucent surface in this client is
    # written, so this script has to mean the same thing by it that the app
    # does. Read the shape rather than assume it: if `tint` stops appending a
    # two-digit alpha to a #rrggbb string, every tinted surface measured here
    # becomes fiction, and stopping is the only honest response.
    if not re.search(r"export function tint\([^)]*\)\s*:\s*string\s*\{", source):
        broke(f"{rel(THEME)} no longer exports `tint(hex, alpha): string`")
    if not re.search(r"return\s*`\$\{hex\}\$\{a\}`", source):
        broke(
            f"`tint` in {rel(THEME)} no longer returns `${{hex}}${{alpha}}`, so this script "
            "cannot say what a tinted surface renders as; teach it the new shape"
        )


def load_elements(palette: Palette) -> None:
    """The six element palettes, from the engine both clients share."""
    source = read(ELEMENTS)
    block = re.search(r"ELEMENT_STYLE:\s*Record<Element,\s*ElementStyle>\s*=\s*\{(.*?)\n\};", source, re.S)
    if not block:
        broke(f"{rel(ELEMENTS)} has no ELEMENT_STYLE table this script can read")
    for name, colour, deep in ELEMENT_ENTRY.findall(block.group(1)):
        parsed, parsed_deep = parse_hex(colour), parse_hex(deep)
        if parsed is None or parsed_deep is None:
            continue
        palette.elements[name] = parsed
        palette.element_deep[name] = parsed_deep
    listed = re.search(r"export const ELEMENTS = \[(.*?)\] as const;", source, re.S)
    if not listed:
        broke(f"{rel(ELEMENTS)} has no ELEMENTS list")
    missing = sorted(set(re.findall(r"'([a-z]+)'", listed.group(1))) - set(palette.elements))
    if missing:
        broke(f"ELEMENT_STYLE has no readable colour for: {', '.join(missing)}")


def load_surfaces(palette: Palette) -> None:
    """The app background and the `Panel` surface, read where they are declared."""
    app = read(APP)
    screen = stylesheets(app).get("screen")
    if not screen or "backgroundColor" not in screen:
        broke(f"{rel(APP)} declares no `screen` style with a backgroundColor; the app has no known surface")
    root = resolve_colour_text(screen["backgroundColor"], palette, {})
    if len(root) != 1 or root[0][1] is None or root[0][1].a < 1.0:
        broke(f"the app background in {rel(APP)} is not a single opaque colour this script can read")
    palette.app_background = root[0][1].rgb

    kit = read(KIT)
    panel = stylesheets(kit).get("panel")
    if not panel or "backgroundColor" not in panel:
        broke(f"{rel(KIT)} declares no `panel` style with a backgroundColor")
    surface = resolve_colour_text(panel["backgroundColor"], palette, {})
    if len(surface) != 1 or surface[0][1] is None:
        broke(f"the `panel` surface in {rel(KIT)} is not a single colour this script can read")
    palette.panel = surface[0][1]

    # The glow is what makes a Panel's surface depend on an element, which is
    # the whole reason a chip label's contrast used to depend on which card it
    # was dropped onto. Read the alpha from the component, never restate it.
    glow = re.search(r"glow\s*\?\s*\{\s*backgroundColor:\s*tint\(\s*glow\s*,\s*([0-9.]+)\s*\)", kit)
    if not glow:
        broke(
            f"`Panel` in {rel(KIT)} no longer paints `tint(glow, N)`, so the surface an "
            "element-glowed panel renders cannot be computed; teach this check the new shape"
        )
    palette.glow_alpha = float(glow.group(1))


# --------------------------------------------------------------------------
# Expanding an expression into its branches
#
# `active ? styles.choiceOn : styles.choiceOff` is two styles, not one, and
# `active && styles.choiceTextOn` on the label inside is the same `active`.
# Collapsing either into "every literal I can see" is what made the first draft
# of the web script report a slate-300 label on an amber-400 button - a pairing
# the toggle it came from cannot render.
# --------------------------------------------------------------------------

QUOTES = "'\"`"


def _scan_top_level(text: str, wanted: str) -> list[int]:
    """Indices of `wanted` characters at bracket depth 0, outside strings."""
    out: list[int] = []
    depth = 0
    i = 0
    while i < len(text):
        char = text[i]
        if char in QUOTES:
            quote = char
            i += 1
            while i < len(text):
                if text[i] == "\\":
                    i += 2
                    continue
                if text[i] == quote:
                    break
                i += 1
        elif char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
        elif depth == 0 and char in wanted:
            out.append(i)
        i += 1
    return out


def _split_ternary(text: str) -> tuple[str, str, str] | None:
    """`cond ? a : b` -> (cond, a, b), matching `?` to `:` at the top level."""
    marks = _scan_top_level(text, "?:")
    depth = 0
    question = None
    for index in marks:
        char = text[index]
        if char == "?":
            # `?.` and `??` are not conditionals.
            if index + 1 < len(text) and text[index + 1] in ".?":
                continue
            if index and text[index - 1] == "?":
                continue
            if depth == 0:
                question = index
            depth += 1
        else:
            if depth == 0:
                continue
            depth -= 1
            if depth == 0 and question is not None:
                return (text[:question], text[question + 1 : index], text[index + 1 :])
    return None


def _split_and(text: str) -> tuple[str, str] | None:
    """`cond && value` -> (cond, value), at the top level only."""
    for index in _scan_top_level(text, "&"):
        if text[index : index + 2] == "&&":
            return (text[:index], text[index + 2 :])
    return None


def condition_name(text: str) -> tuple[str, bool]:
    """A condition, and whether the branch guarded by it is the *negated* one.

    `has ? styles.badgeEarned : styles.badgeLocked` sets a badge's surface and
    `!has && { color: colors.faint }` sets its label - one unknown written two
    ways. Without folding the `!` into the truth value they become two
    independent names, and the walk pairs a locked label with an earned
    background: a 2.73:1 finding for a badge that cannot render. So the `!` is
    normalised away here and carried in the value instead.
    """
    name = " ".join(text.split()).strip()
    negated = False
    while True:
        while name.startswith("(") and name.endswith(")") and _scan_top_level(name[1:-1], ")") == []:
            name = name[1:-1].strip()
        if name.startswith("!"):
            name = name[1:].strip()
            negated = not negated
            continue
        break
    return name, negated


EQUALITY = re.compile(r"^(.+?)\s*===\s*('[^'\n]*'|\"[^\"\n]*\"|\d+)$")


def _bind(name: str, negated: bool, truthy: bool) -> Binding:
    """The branch's own truth value, plus what it proves about a discriminator.

    `variant === 'primary' && styles.buttonPrimary` and `variant === 'ghost' &&
    styles.buttonGhost` are three independent booleans as far as a truth value
    goes, so nothing stopped the walk from taking the gold background of the
    first and the transparent background of the third at once - a Button that
    cannot exist, whose dark label then measured 1.01:1 against the panel
    behind it. A true `x === 'a'` branch also binds `x` to `'a'`, which makes
    that combination incompatible. The false branch binds only itself, because
    "not primary" says nothing about which of the others it is.
    """
    value = "true" if truthy != negated else "false"
    binding = {(name, value)}
    equality = EQUALITY.match(name)
    if equality and value == "true":
        binding.add((equality.group(1).strip(), equality.group(2)))
    return frozenset(binding)


def variants(text: str) -> list[tuple[Binding, str]]:
    """(binding, concrete expression) for every branch of `text`."""
    stripped = text.strip().rstrip(",").strip()
    ternary = _split_ternary(stripped)
    if ternary:
        condition, first, second = ternary
        name, negated = condition_name(condition)
        if name:
            out: list[tuple[Binding, str]] = []
            for truthy, branch in ((True, first), (False, second)):
                bound = _bind(name, negated, truthy)
                for extra, concrete in variants(branch):
                    if compatible(bound, extra):
                        out.append((merge(bound, extra), concrete))
            return out[:MAX_VARIANTS] or [(FREE, stripped)]
    conjunction = _split_and(stripped)
    if conjunction:
        condition, value = conjunction
        name, negated = condition_name(condition)
        if name:
            out = [(_bind(name, negated, False), "undefined")]
            for extra, concrete in variants(value):
                bound = _bind(name, negated, True)
                if compatible(bound, extra):
                    out.append((merge(bound, extra), concrete))
            return out[:MAX_VARIANTS]
    return [(FREE, stripped)]


# --------------------------------------------------------------------------
# An expression -> a colour
# --------------------------------------------------------------------------

FUNC_RGB = re.compile(r"\brgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)\s*(?:[,/]\s*([0-9.%]+)\s*)?\)")
HEX_LITERAL = re.compile(r"['\"](#[0-9a-fA-F]{3,8})['\"]")
COLOR_REF = re.compile(r"(?<![\w$.])colors\.([A-Za-z_$][\w$]*)")
ELEMENT_FIELD = re.compile(r"(?<![\w$.])((?:[A-Za-z_$][\w$]*)(?:\[[^\]]*\])?(?:\.[A-Za-z_$][\w$]*)*?)\.(color|deep)\b")
CALL = re.compile(r"(?<![\w$.])(tint|mix)\(")


def _call_arguments(text: str, open_paren: int) -> tuple[list[str], int] | None:
    depth = 0
    i = open_paren
    while i < len(text):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                inner = text[open_paren + 1 : i]
                parts: list[str] = []
                last = 0
                for comma in _scan_top_level(inner, ","):
                    parts.append(inner[last:comma])
                    last = comma + 1
                parts.append(inner[last:])
                return ([p.strip() for p in parts], i + 1)
        i += 1
    return None


def _single(candidates: list[tuple[Binding, Rgba | None]], what: str) -> Rgba:
    if len(candidates) != 1 or candidates[0][1] is None:
        raise Unresolvable(f"`{what}` does not resolve to one colour")
    return candidates[0][1]


def resolve_colour_text(
    text: str, palette: Palette, consts: dict[str, list[str]], depth: int = 0
) -> list[tuple[Binding, Rgba | None]]:
    """Every colour a value expression can render as, each with its binding.

    `None` means "this branch paints nothing and still renders" - the
    distinction the web script learned the hard way, where dropping such a
    branch let a 2.26:1 label pass because the surface it really sat on had
    vanished from the candidate list.
    """
    if depth > 6:
        raise Unresolvable(f"`{text.strip()}` nests deeper than this script will follow")

    out: list[tuple[Binding, Rgba | None]] = []
    for binding, branch in variants(text):
        for extra, colour in _resolve_concrete(branch, palette, consts, depth):
            if not compatible(binding, extra):
                continue
            entry = (merge(binding, extra), colour)
            if entry not in out:
                out.append(entry)
    return out[:MAX_VARIANTS]


def _resolve_concrete(
    text: str, palette: Palette, consts: dict[str, list[str]], depth: int
) -> list[tuple[Binding, Rgba | None]]:
    body = text.strip().rstrip(",").strip()
    if body.strip("'\"") in NO_PAINT:
        return [(FREE, None)]

    # tint(colour, alpha) and mix(colour, weight, base): the two helpers in
    # theme.ts that build a surface out of another colour. Their shapes are
    # verified against theme.ts at load time, so this is reading the app's own
    # arithmetic rather than inventing a parallel one.
    call = CALL.search(body)
    if call:
        parsed = _call_arguments(body, call.end() - 1)
        if parsed is None:
            raise Unresolvable(f"`{body}` has an unterminated {call.group(1)}(")
        args, _ = parsed
        if call.group(1) == "tint" and len(args) == 2:
            try:
                alpha = float(args[1])
            except ValueError:
                raise Unresolvable(f"`{body}` tints by an alpha this script cannot read") from None
            return [
                (binding, None if colour is None else Rgba(colour.r, colour.g, colour.b, colour.a * alpha))
                for binding, colour in resolve_colour_text(args[0], palette, consts, depth + 1)
            ]
        if call.group(1) == "mix" and len(args) == 3:
            try:
                weight = float(args[1])
            except ValueError:
                raise Unresolvable(f"`{body}` mixes by a weight this script cannot read") from None
            base = _single(resolve_colour_text(args[2], palette, consts, depth + 1), args[2])
            out: list[tuple[Binding, Rgba | None]] = []
            for binding, colour in resolve_colour_text(args[0], palette, consts, depth + 1):
                if colour is None:
                    out.append((binding, None))
                    continue
                flat = composite(Rgba(colour.r, colour.g, colour.b, colour.a * weight), base.rgb)
                out.append((binding, Rgba(*flat, base.a)))
            return out
        raise Unresolvable(f"`{body}` calls {call.group(1)}() with an argument list this script cannot read")

    # An element colour: `style.color`, `ELEMENT_STYLE[foe.element].deep`, …
    field = ELEMENT_FIELD.search(body)
    if field and field.group(1) not in ("colors",):
        table = palette.elements if field.group(2) == "color" else palette.element_deep
        root = field.group(1).strip()
        return [
            (frozenset({(root, name)}), colour)
            for name, colour in sorted(table.items())
        ]

    literal = HEX_LITERAL.search(body)
    if literal:
        parsed = parse_hex(literal.group(1))
        if parsed is None:
            raise Unresolvable(f"`{body}` is not a hex colour this script can read")
        return [(FREE, parsed)]

    functional = FUNC_RGB.search(body)
    if functional:
        raw_alpha = functional.group(4)
        alpha = 1.0
        if raw_alpha is not None:
            alpha = float(raw_alpha[:-1]) / 100 if raw_alpha.endswith("%") else float(raw_alpha)
        return [
            (
                FREE,
                Rgba(
                    int(round(float(functional.group(1)))),
                    int(round(float(functional.group(2)))),
                    int(round(float(functional.group(3)))),
                    alpha,
                ),
            )
        ]

    token = COLOR_REF.search(body)
    if token:
        colour = palette.named.get(token.group(1))
        if colour is None:
            raise Unresolvable(f"`colors.{token.group(1)}` is not a token in mobile/src/theme.ts")
        return [(FREE, colour)]

    # A local `const colour = …` or `const verdict = { tone: … }`.
    for name in sorted(consts, key=len, reverse=True):
        if not re.search(r"(?<![\w$])" + re.escape(name) + r"(?![\w$])", body):
            continue
        alternatives = consts[name]
        out = []
        for alternative in alternatives:
            # One alternative is the const itself, whose own ternaries bind
            # themselves; several are alternatives of one unknown and need a
            # name of their own so two references to it cannot disagree.
            extra_binding = FREE if len(alternatives) == 1 else frozenset({(name, alternative)})
            for binding, colour in resolve_colour_text(alternative, palette, consts, depth + 1):
                if compatible(extra_binding, binding):
                    out.append((merge(extra_binding, binding), colour))
        if out:
            return out

    raise Unresolvable(f"`{body}` names no colour this script can read")


# --------------------------------------------------------------------------
# Local colour constants
# --------------------------------------------------------------------------

def colour_consts(source: str) -> dict[str, list[str]]:
    """`const colour = …` and `const verdict = { …, tone: …, … }` bindings.

    `HealthBar` picks its fill colour this way and `PickOpponent` its verdict
    tone, so without this the health bar - the most meaningful meter in the
    game - would resolve to nothing at all.

    A field reached off an object (`verdict.tone`) keeps *every* value any
    branch of that object can give it, because dropping the branches would
    quietly measure only the first one. They are alternatives of a single
    unknown, so they are handed back as a list and bound as one name.
    """
    out: dict[str, list[str]] = {}
    for match in re.finditer(r"\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*((?:[^;]|\n)*?);", source):
        name, rhs = match.group(1), match.group(2)
        if not re.search(r"colors\.|#[0-9a-fA-F]{6}|\btint\(|\bmix\(", rhs):
            continue
        out.setdefault(name, [rhs])
        for key, value in re.findall(
            r"([A-Za-z_$][\w$]*)\s*:\s*(colors\.[A-Za-z_$][\w$]*|'#[0-9a-fA-F]{3,8}')", rhs
        ):
            alternatives = out.setdefault(f"{name}.{key}", [])
            if value not in alternatives:
                alternatives.append(value)
    return {name: sorted(values) for name, values in out.items()}


# --------------------------------------------------------------------------
# Flattening a `style` prop
# --------------------------------------------------------------------------

@dataclass
class Flat:
    """One concrete resolution of a `style` prop."""

    binding: Binding
    props: dict[str, str]
    unresolved: str | None = None


ARROW = re.compile(r"^\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>")


def _entries(raw: str) -> list[str]:
    """The ordered entries of a `style` prop, array or not."""
    text = raw.strip()
    # `style={({ pressed }) => [...]}` is the Pressable idiom, and it is where
    # every filled button in this client declares its background. An earlier
    # draft looked for `=>` before the first `{`, which the destructured
    # `({ pressed })` parameter defeats - so every one of those backgrounds was
    # missed and their dark-on-gold labels were measured against the panel
    # behind the button. Anchor on the arrow itself.
    arrow = ARROW.match(text)
    if arrow:
        text = text[arrow.end() :].strip()
    if text.startswith("[") and text.endswith("]"):
        inner = text[1:-1]
        marks = _scan_top_level(inner, ",")
        parts: list[str] = []
        last = 0
        for comma in marks:
            parts.append(inner[last:comma])
            last = comma + 1
        parts.append(inner[last:])
        return [p for p in (part.strip() for part in parts) if p]
    return [text] if text else []


def flatten_style(
    attrs: str, sheets: dict[str, dict[str, str]], forwarded: list[tuple[Binding, dict[str, str]]]
) -> list[Flat]:
    """Every concrete property map a `style` prop can flatten to.

    React Native flattens an array left to right and a later entry replaces an
    earlier one *per property*. That is the difference from a CSS class list,
    where the web audit can gather every `bg-*` token it sees and take the
    worst: here the worst may be a surface that is always overpainted.
    """
    raw, kind = attr_raw(attrs, "style")
    if raw is None:
        return [Flat(FREE, {})]
    if kind != "expr":
        return [Flat(FREE, {}, unresolved=f"style={raw!r} is not an expression")]

    states: list[Flat] = [Flat(FREE, {})]
    for entry in _entries(raw):
        grown: list[Flat] = []
        for binding, branch in variants(entry):
            body = branch.strip().rstrip(",").strip()
            props: dict[str, str] | None = {}
            unknown: str | None = None
            if body in NO_PAINT:
                props = {}
            elif body.startswith("{") and body.endswith("}"):
                props = parse_props(body[1:-1], 0)
            elif re.fullmatch(r"styles\.[A-Za-z0-9_$]+", body):
                name = body.split(".", 1)[1]
                if name in sheets:
                    props = sheets[name]
                else:
                    props, unknown = {}, f"`{body}` is not a style in this file"
            elif re.fullmatch(r"[A-Za-z_$][\w$]*", body) and forwarded:
                # A forwarded `style` prop. Resolved from the component's real
                # call sites rather than assumed empty; see `forwarded_styles`.
                for extra, overlay in forwarded:
                    if not compatible(binding, extra):
                        continue
                    for state in states:
                        if compatible(state.binding, merge(binding, extra)):
                            grown.append(
                                Flat(
                                    merge(state.binding, merge(binding, extra)),
                                    {**state.props, **overlay},
                                    state.unresolved,
                                )
                            )
                continue
            else:
                props, unknown = {}, f"`{body}` is a style this script cannot read"
            for state in states:
                if not compatible(state.binding, binding):
                    continue
                grown.append(
                    Flat(
                        merge(state.binding, binding),
                        {**state.props, **props},
                        state.unresolved or unknown,
                    )
                )
        states = grown[:MAX_VARIANTS] or states
    return states


def forwarded_styles(component: str, files: list[Path]) -> list[tuple[Binding, dict[str, str]]]:
    """Style objects real call sites pass into `<component style={…}>`.

    `Panel` forwards its `style` prop into its own root view, so statically it
    could repaint its surface. Refusing to judge anything inside a Panel on
    that basis would silence most of this client; assuming the prop is empty
    would be a guess. The call sites are all in this repository, so they are
    read instead.
    """
    out: list[tuple[Binding, dict[str, str]]] = [(FREE, {})]
    for path in files:
        source = read(path)
        sheets = stylesheets(source)
        for match in re.finditer(rf"<{re.escape(component)}(?![\w$])", source):
            try:
                end, self_closing = find_tag_end(source, match.start())
            except ValueError:
                continue
            attrs = source[match.end() : end - (2 if self_closing else 1)]
            raw, kind = attr_raw(attrs, "style")
            if raw is None or kind != "expr":
                continue
            for flat in flatten_style(f"style={{{raw}}}", sheets, []):
                overlay = {k: v for k, v in flat.props.items() if k in ("backgroundColor", "color")}
                entry = (frozenset({(f"{component} style", f"{rel(path)}:{raw.strip()[:32]}")}), overlay)
                if entry not in out:
                    out.append(entry)
    return out[:MAX_VARIANTS]


# --------------------------------------------------------------------------
# Context: what colour is this text, and what is behind it
# --------------------------------------------------------------------------


# A tag opens with `<` and a letter or a slash *immediately*; a comparison is
# written `a < b`. Prettier formats this repository, so the space is reliable,
# and `direct_children` has already split real sibling elements out - the only
# markup left inside an expression is a nested `{cond && <Text>…}`.
JSX_TAG = re.compile(r"<[A-Za-z/]")


def has_text(node: Node) -> bool:
    """A text node, or an expression that renders words rather than markup.

    The web audit tests an expression child for a bare `<`, which reads as "this
    renders elements, not words". That is one comparison operator away from
    wrong, and this client walks straight into it: `{attacking < NEUTRAL ? '⚔️
    ×0.5' : ''}` is the whole content of `PickOpponent`'s matchup line, and a
    bare-`<` test dropped it silently - a 3.55:1 label that never appeared in
    any report. A tag needs a letter or a slash after the `<`.
    """
    for child in direct_children(node.inner):
        if child.kind == "text" and child.text.strip():
            return True
        if child.kind == "expr" and child.text.strip() and not JSX_TAG.search(child.text):
            return True
    return False


@dataclass(frozen=True)
class Context:
    backgrounds: tuple[tuple[Binding, RGB], ...]
    fore: tuple[tuple[Binding, Rgba], ...] | None
    size_px: float
    weight: int
    unresolved: str | None


def layer(
    current: list[tuple[Binding, RGB]], painted: list[tuple[Binding, Rgba | None]]
) -> list[tuple[Binding, RGB]]:
    """Paint `painted` over `current`. A `None` entry paints nothing and inherits."""
    stacked: list[tuple[Binding, RGB]] = []
    for top_binding, top in painted:
        for bottom_binding, bottom in current:
            if not compatible(top_binding, bottom_binding):
                continue
            entry = (merge(top_binding, bottom_binding), bottom if top is None else composite(top, bottom))
            if entry not in stacked:
                stacked.append(entry)
    return stacked[:MAX_VARIANTS] or current


def worst_pair(
    fore: list[tuple[Binding, Rgba]], back: list[tuple[Binding, RGB]]
) -> tuple[float, Rgba, RGB, Binding] | None:
    worst: tuple[float, Rgba, RGB, Binding] | None = None
    for fore_binding, text_colour in fore:
        for back_binding, background in back:
            if not compatible(fore_binding, back_binding):
                continue
            flat = composite(text_colour, background)
            ratio = contrast_ratio(flat, background)
            if worst is None or ratio < worst[0]:
                worst = (ratio, text_colour, background, merge(fore_binding, back_binding))
    return worst


def rule_for(size_px: float, weight: int) -> tuple[float, str]:
    if size_px >= LARGE_PX or (size_px >= LARGE_BOLD_PX and weight >= BOLD):
        return LARGE_MIN, f"large text ({size_px:g}px, weight {weight})"
    return NORMAL_MIN, f"normal text ({size_px:g}px, weight {weight})"


FONT_WEIGHT_WORDS = {"normal": 400, "bold": 700, "ultralight": 100, "thin": 100, "light": 300,
                     "medium": 500, "semibold": 600, "heavy": 800, "black": 900}


def font_size(value: str) -> float | None:
    try:
        return float(value.strip().rstrip(",").strip("'\""))
    except ValueError:
        return None


def font_weight(value: str) -> int | None:
    word = value.strip().rstrip(",").strip("'\"")
    if word in FONT_WEIGHT_WORDS:
        return FONT_WEIGHT_WORDS[word]
    try:
        return int(word)
    except ValueError:
        return None


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------


@dataclass
class Report:
    violations: list[Finding] = field(default_factory=list)
    review: list[Finding] = field(default_factory=list)
    pairs: list[tuple[str, str, float, float, str]] = field(default_factory=list)

    def fail(self, path: str, line: int, check: str, detail: str) -> None:
        finding = Finding(path, line, check, detail)
        if finding not in self.violations:
            self.violations.append(finding)

    def note(self, path: str, line: int, check: str, detail: str) -> None:
        finding = Finding(path, line, check, detail)
        if finding not in self.review:
            self.review.append(finding)


@dataclass
class FileScope:
    rel: str
    src: str
    palette: Palette
    report: Report
    sheets: dict[str, dict[str, str]]
    consts: dict[str, list[str]]
    forwarded: list[tuple[Binding, dict[str, str]]]


def judge(
    line: int,
    fore: list[tuple[Binding, Rgba]],
    back: list[tuple[Binding, RGB]],
    unresolved: str | None,
    minimum: float,
    rule: str,
    check: str,
    label: str,
    scope: FileScope,
) -> None:
    if unresolved:
        scope.report.note(scope.rel, line, check, f"{label} sits on a background that is not static ({unresolved})")
        return
    worst = worst_pair(fore, back)
    if worst is None:
        scope.report.note(scope.rel, line, check, f"{label} has no resolvable colour pair")
        return
    ratio, text_colour, background, binding = worst
    named = (
        "element-contrast"
        if check == "text-contrast" and any(name in scope.palette.elements for _, name in binding)
        else check
    )
    scope.report.pairs.append((f"{scope.rel}:{line}", f"{label}{show(binding)}", ratio, minimum, rule))
    if ratio + 1e-9 < minimum:
        scope.report.fail(
            scope.rel,
            line,
            named,
            f"{label}{show(binding)} {text_colour.hex()} on {rgb_hex(background)} "
            f"is {ratio:.2f}:1, below {minimum:g}:1 for {rule}",
        )


# --------------------------------------------------------------------------
# The walk
# --------------------------------------------------------------------------


def visit(node: Node, parent: Context, scope: FileScope) -> None:
    palette, report = scope.palette, scope.report
    flats = flatten_style(node.attrs, scope.sheets, scope.forwarded)

    # When branches disagree about size or weight the smallest of each is used:
    # that is the branch WCAG judges most strictly, so the error can only ever
    # be in the direction of demanding more contrast than one branch needs.
    sizes = [font_size(f.props["fontSize"]) for f in flats if "fontSize" in f.props]
    weights = [font_weight(f.props["fontWeight"]) for f in flats if "fontWeight" in f.props]
    size_px = min([s for s in sizes if s is not None], default=parent.size_px)
    weight = min([w for w in weights if w is not None], default=parent.weight)

    unresolved = parent.unresolved

    # ---- the surface this node paints -------------------------------------
    painted: list[tuple[Binding, Rgba | None]] = []
    paints = any("backgroundColor" in flat.props for flat in flats)
    if paints:
        for flat in flats:
            value = flat.props.get("backgroundColor")
            if value is None:
                painted.append((flat.binding, None))
                continue
            try:
                for extra, colour in resolve_colour_text(value, palette, scope.consts):
                    if compatible(flat.binding, extra):
                        painted.append((merge(flat.binding, extra), colour))
            except Unresolvable as error:
                painted = []
                unresolved = f"the background at line {node.line} is not static ({error})"
                break

    # ---- a <Panel>, whose surface lives in kit.tsx ------------------------
    #
    # The one component in this client that paints. Its own `styles.panel` is
    # opaque, so it hides whatever is beneath it; the optional `glow` is a
    # translucent tint of an element colour painted on top of that, which is
    # why an element-glowed Panel is a lighter ground than a plain one.
    if node.tag == PANEL_COMPONENT and palette.panel is not None and palette.glow_alpha is not None:
        glowed: list[tuple[Binding, Rgba | None]] = []
        raw, kind = attr_raw(node.attrs, "glow")
        if raw is not None and kind == "expr":
            try:
                for binding, colour in resolve_colour_text(raw, palette, scope.consts):
                    if colour is None:
                        continue
                    glowed.append(
                        (binding, Rgba(colour.r, colour.g, colour.b, colour.a * palette.glow_alpha))
                    )
            except Unresolvable as error:
                unresolved = f"the Panel glow at line {node.line} is not static ({error})"
                glowed = []
        backgrounds = layer(list(parent.backgrounds), [(FREE, palette.panel)])
        if glowed:
            backgrounds = layer(backgrounds, glowed)
        if unresolved == parent.unresolved:
            unresolved = None  # an opaque panel hides any unknown beneath it
        painted = []
        paints = False
    else:
        backgrounds = list(parent.backgrounds)
        if painted:
            backgrounds = layer(backgrounds, painted)
            unresolved = parent.unresolved  # a static repaint hides the unknown beneath

    # ---- the colour this node declares ------------------------------------
    fore = list(parent.fore) if parent.fore is not None else None
    declared: list[tuple[Binding, Rgba]] = []
    fore_unresolved: str | None = None
    if any("color" in flat.props for flat in flats):
        for flat in flats:
            value = flat.props.get("color")
            if value is None:
                continue  # this branch inherits
            try:
                for extra, colour in resolve_colour_text(value, palette, scope.consts):
                    if colour is not None and compatible(flat.binding, extra):
                        declared.append((merge(flat.binding, extra), colour))
            except Unresolvable as error:
                declared = []
                fore_unresolved = str(error)
                break
    if declared:
        fore = declared

    context = Context(
        backgrounds=tuple(backgrounds),
        # Only a <Text> passes a colour down; a <View> does not, so the
        # inherited colour is dropped at every non-text boundary. This is the
        # single biggest difference from the web walk, where <body> sets a
        # colour every descendant gets.
        fore=tuple(fore) if (fore is not None and node.tag in TEXT_TAGS) else None,
        size_px=size_px if node.tag in TEXT_TAGS else parent.size_px,
        weight=weight if node.tag in TEXT_TAGS else parent.weight,
        unresolved=unresolved,
    )

    # ---- (1) text ---------------------------------------------------------
    if node.tag in TEXT_TAGS and (has_text(node) or node.tag == "TextInput"):
        label = f"<{node.tag}>"
        if fore_unresolved:
            report.note(scope.rel, node.line, "text-contrast", f"{label} text colour is not static ({fore_unresolved})")
        elif fore is None:
            report.note(
                scope.rel,
                node.line,
                "text-contrast",
                f"{label} declares no colour and inherits none from a <Text> ancestor; "
                "React Native gives it the platform default, which only an emoji can survive",
            )
        else:
            minimum, rule = rule_for(size_px, weight)
            judge(node.line, fore, backgrounds, unresolved, minimum, rule, "text-contrast", label, scope)

    # ---- (2) placeholder text ---------------------------------------------
    raw, kind = attr_raw(node.attrs, "placeholderTextColor")
    if raw is not None:
        try:
            placeholder = [
                (binding, colour)
                for binding, colour in resolve_colour_text(raw, palette, scope.consts)
                if colour is not None
            ]
        except Unresolvable as error:
            report.note(scope.rel, node.line, "text-contrast", f"<{node.tag}> placeholder is not static ({error})")
            placeholder = []
        if placeholder:
            judge(
                node.line,
                placeholder,
                backgrounds,
                unresolved,
                NORMAL_MIN,
                f"placeholder text ({size_px:g}px, weight {weight})",
                "text-contrast",
                f"<{node.tag}> placeholder",
                scope,
            )

    # ---- (3) a meter fill against its own track ---------------------------
    children = jsx_nodes(node.inner, node.inner_offset, scope.src)
    hides_overflow = any(
        flat.props.get("overflow", "").strip().strip("',\"") == "hidden" for flat in flats
    )
    if hides_overflow and paints:
        track = backgrounds
        for child in children:
            if child.inner.strip():
                continue
            child_flats = flatten_style(child.attrs, scope.sheets, scope.forwarded)
            if not any("backgroundColor" in f.props for f in child_flats):
                continue
            fill: list[tuple[Binding, Rgba]] = []
            try:
                for flat in child_flats:
                    value = flat.props.get("backgroundColor")
                    if value is None:
                        continue
                    for extra, colour in resolve_colour_text(value, palette, scope.consts):
                        if colour is not None and compatible(flat.binding, extra):
                            fill.append((merge(flat.binding, extra), colour))
            except Unresolvable as error:
                report.note(
                    scope.rel,
                    child.line,
                    "meter-contrast",
                    f"<{child.tag}> fills a track but its colour is not static ({error})",
                )
                continue
            if fill:
                judge(
                    child.line,
                    fill,
                    track,
                    unresolved,
                    NON_TEXT_MIN,
                    "non-text (meter fill against its track)",
                    "meter-contrast",
                    f"<{child.tag}> fill",
                    scope,
                )

    for child in children:
        visit(child, context, scope)


# --------------------------------------------------------------------------
# The element chips, asserted of the palette rather than of a file
# --------------------------------------------------------------------------

CHIP = re.compile(
    r"export function ElementChip\([\s\S]*?<View style=\{\[styles\.chip,\s*\{\s*backgroundColor:\s*([^}]*?)\s*\}\]\}>"
    r"[\s\S]*?<Text style=\{\[styles\.chipText,\s*\{\s*color:\s*([^}]*?)\s*\}\]\}>"
)


def check_element_chips(palette: Palette, report: Report, surfaces: list[tuple[str, RGB]]) -> None:
    """Every element's label on the surface its own chip paints.

    The generic walk already judges the chip where it is written. This asks the
    same question of `ELEMENT_STYLE` directly, so a seventh element is covered
    the day it lands rather than the day someone remembers to render it - and
    it prints one line per element, which is what makes "which of the six is
    the bad one" answerable at a glance.

    The chip's own formula is read out of `kit.tsx`. If the chip stops being a
    label written in the element colour on a surface built from it, the audit
    stops rather than certifying a shape it no longer understands.
    """
    source = read(KIT)
    sheets = stylesheets(source)
    chip = CHIP.search(source)
    if not chip:
        broke(
            f"`ElementChip` in {rel(KIT)} no longer paints `<View style={{[styles.chip, "
            "{backgroundColor: …}]}}>` around `<Text style={{[styles.chipText, {color: …}]}}>`; "
            "teach this check the new shape"
        )
    background_expr, colour_expr = chip.group(1), chip.group(2)

    size_px = font_size(sheets.get("chipText", {}).get("fontSize", "")) or DEFAULT_FONT_PX
    weight = font_weight(sheets.get("chipText", {}).get("fontWeight", "")) or DEFAULT_WEIGHT
    minimum, rule = rule_for(size_px, weight)

    try:
        tints = resolve_colour_text(background_expr, palette, {})
        labels = resolve_colour_text(colour_expr, palette, {})
    except Unresolvable as error:
        broke(f"the element chip's colours in {rel(KIT)} cannot be resolved: {error}")

    for name in sorted(palette.elements):
        tint_for = [c for b, c in tints if (name in dict(b).values() or not b) and c is not None]
        label_for = [c for b, c in labels if (name in dict(b).values() or not b) and c is not None]
        if not tint_for or not label_for:
            report.note(rel(KIT), 1, "element-contrast", f"the {name} chip has no resolvable colour pair")
            continue
        for surface_name, surface in surfaces:
            # An opaque chip surface renders identically wherever it is
            # dropped, so the candidate list collapses to one - which is
            # precisely the property the web fix bought.
            painted = composite(tint_for[0], surface)
            if tint_for[0].a >= 1.0 and surface_name != surfaces[0][0]:
                continue
            ratio = contrast_ratio(composite(label_for[0], painted), painted)
            where = "" if tint_for[0].a >= 1.0 else f" on a {surface_name}"
            report.pairs.append(
                (f"{rel(KIT)}:chip", f"{name} label on its own chip{where}", ratio, minimum, rule)
            )
            if ratio + 1e-9 < minimum:
                report.fail(
                    rel(KIT),
                    1,
                    "element-contrast",
                    f"the {name} chip label {label_for[0].hex()} on its own surface "
                    f"{rgb_hex(painted)}{where} is {ratio:.2f}:1, below {minimum:g}:1 for {rule}; "
                    "an element chip's label is written in the element's own colour",
                )


# --------------------------------------------------------------------------
# Deliberately not checked
# --------------------------------------------------------------------------
UNCHECKED = [
    (
        "creature art",
        "`art.ts` emits gradients on a transparent ground and `CreatureArt.tsx` "
        "maps them onto react-native-svg. A creature is never the only carrier "
        "of its own identity - every one on screen is named in text beside it, "
        "and the album's locked slots are silhouettes on purpose. No WCAG "
        "threshold applies to a picture of a monster.",
    ),
    (
        "disabled and pressed states",
        "`disabled && styles.disabled` and `pressed && styles.pressed` are "
        "`opacity` only, and this script ignores opacity entirely. WCAG 1.4.3 "
        "and 1.4.11 both exempt inactive components, and a pressed state lasts "
        "as long as a thumb is down. A disabled move button is *meant* to read "
        "as unavailable.",
    ),
    (
        "the charge pips",
        "`ChargeMeter` is a row of discrete dots rather than a proportional "
        "bar, so it does not match the track/fill idiom the meter check "
        "derives. On/off is carried by fill *and* border, which is 1.4.11's "
        "adjacent-colours case and needs a model of borders this script does "
        "not have. If the border ever goes, this entry is where someone should "
        "notice.",
    ),
    (
        "borders and panel edges",
        "`borderColor` is read only to know it exists, never judged. Every "
        "input and card here is labelled, placed and permanently visible, so "
        "its edge is decoration rather than the only cue - and flagging all of "
        "them would bury the findings that are real.",
    ),
    (
        "emoji",
        "An emoji brings its own colours rather than taking `color`, so the "
        "several `<Text>` nodes that render nothing but one (`badgeIcon`, the "
        "matchup arrows) are reported as 'declares no colour' in NEEDS REVIEW "
        "rather than judged against a guessed default. The moment one of those "
        "styles gains a word of text, the review line is the warning.",
    ),
    (
        "which Panel a shared widget was dropped into",
        "`kit.tsx` cannot see its caller, so every widget there is judged "
        "against the bare app background, a plain Panel and all six "
        "element-glowed Panels, and the worst wins. That is stricter than any "
        "single call site, never laxer - the only direction an audit may err "
        "in.",
    ),
    (
        "the web client",
        "`scripts/audit_contrast.py` owns that, and owns the WCAG arithmetic "
        "this script imports. Neither script reaches into the other's "
        "stylesheet; they share the formulas and nothing else.",
    ),
]


# --------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------


def scan_targets() -> list[Path]:
    out: list[Path] = []
    for root in SCAN_ROOTS:
        if not root.is_dir():
            broke(f"{rel(root)} is missing, so it cannot be scanned")
        for path in sorted(root.rglob("*.tsx")):
            if ".test." in path.name:
                continue
            out.append(path)
    return sorted(out)


def root_surfaces(palette: Palette) -> list[tuple[str, RGB]]:
    """Every surface a shared widget can find itself on, worst last.

    A screen only ever renders on the app background, but `kit.tsx` is dropped
    onto all of these, and a `Panel` glowed by the lightest element is the
    lightest ground any label in this app has to survive.
    """
    assert palette.panel is not None and palette.glow_alpha is not None
    base = palette.app_background
    panel = composite(palette.panel, base)
    out: list[tuple[str, RGB]] = [("app background", base), ("panel", panel)]
    for name, colour in sorted(palette.elements.items()):
        glow = Rgba(colour.r, colour.g, colour.b, palette.glow_alpha)
        out.append((f"{name}-glowed panel", composite(glow, panel)))
    return out


def root_context(palette: Palette, path: Path) -> Context:
    if path.parent.name == "ui":
        backgrounds = [
            (frozenset({("the surface this widget is dropped on", name)}), surface)
            for name, surface in root_surfaces(palette)
        ]
    else:
        backgrounds = [(FREE, palette.app_background)]
    return Context(
        backgrounds=tuple(backgrounds),
        fore=None,
        size_px=DEFAULT_FONT_PX,
        weight=DEFAULT_WEIGHT,
        unresolved=None,
    )


def print_unchecked() -> None:
    print("What this audit deliberately does not check")
    print("-" * 78)
    for what, why in UNCHECKED:
        print(f"  {what}")
        for line in wrap(why, 72):
            print(f"      {line}")
        print()


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit WCAG colour contrast in the iOS client.")
    parser.add_argument("--pairs", action="store_true", help="dump every colour pair it resolved")
    parser.add_argument("--unchecked", action="store_true", help="print what this audit does not check")
    args = parser.parse_args()

    if args.unchecked:
        print_unchecked()
        return 0

    # The thresholds are WCAG's, not this repository's, and they are imported
    # from the web audit so the two clients cannot drift apart on what
    # "readable" means. Reaching green by lowering one would be the exact
    # failure this script exists to prevent, so it refuses to run against
    # weakened constants rather than quietly passing.
    if NORMAL_MIN < 4.5 or LARGE_MIN < 3.0 or NON_TEXT_MIN < 3.0:
        broke("the WCAG thresholds in scripts/audit_contrast.py have been lowered below the standard")
    if LARGE_PX < 24.0 or LARGE_BOLD_PX < 18.66 or BOLD < 700:
        broke("the large-text definition in scripts/audit_contrast.py has been widened beyond WCAG's")

    palette = Palette()
    load_theme(palette)
    load_elements(palette)
    load_surfaces(palette)

    report = Report()
    targets = scan_targets()
    forwarded = forwarded_styles(PANEL_COMPONENT, targets)

    for path in targets:
        source = read(path)
        scope = FileScope(
            rel=rel(path),
            src=source,
            palette=palette,
            report=report,
            sheets=stylesheets(source),
            consts=colour_consts(source),
            forwarded=forwarded,
        )
        root = root_context(palette, path)
        for node in jsx_nodes(source, 0, source):
            visit(node, root, scope)

    check_element_chips(palette, report, root_surfaces(palette))

    report.violations.sort()
    report.review.sort()
    report.pairs.sort()

    if args.pairs:
        if not report.pairs:
            broke("no colour pair resolved at all; the scanner is not seeing the source")
        width = min(max(len(where) for where, _, _, _, _ in report.pairs), 46)
        print(f"Colour pairs resolved ({len(report.pairs)})")
        print("-" * 78)
        for where, label, ratio, minimum, rule in report.pairs:
            verdict = "ok  " if ratio + 1e-9 >= minimum else "FAIL"
            print(f"  {verdict} {ratio:6.2f}:1 (>= {minimum:g})  {where.ljust(width)}  {label} - {rule}")
        return 0

    print("Mathmon iOS contrast audit")
    print("==========================")
    print(f"palette: {len(palette.named)} theme tokens, {len(palette.elements)} elements")
    print(f"surfaces: {len(root_surfaces(palette))} (app background, panel, one per element glow)")
    print(f"files scanned: {len(targets)}")
    print(f"colour pairs resolved: {len(report.pairs)}")
    print(
        f"thresholds: {NORMAL_MIN:g}:1 normal text, {LARGE_MIN:g}:1 large text "
        f"(fontSize >={LARGE_PX:g}, or >={LARGE_BOLD_PX:g} at weight >={BOLD}), "
        f"{NON_TEXT_MIN:g}:1 non-text"
    )
    print(f"not machine-checked (see --unchecked): {len(UNCHECKED)} groups")
    print()

    if report.review:
        print(f"NEEDS REVIEW ({len(report.review)}) - not provable either way, does not fail the build")
        for finding in report.review:
            print(finding.render())
        print()

    if report.violations:
        broken = sorted({finding.check for finding in report.violations})
        print(f"VIOLATIONS ({len(report.violations)})")
        for finding in report.violations:
            print(finding.render())
        print()
        print(
            f"FAIL: {len(broken)} propert{'y' if len(broken) == 1 else 'ies'} violated: "
            f"{', '.join(broken)}"
        )
        print("The player is seven and often outdoors. Text must clear 4.5:1 (3:1 when")
        print("large), and anything that carries meaning without words must clear 3:1.")
        return 1

    print("PASS: every colour pair this script can resolve clears its WCAG threshold.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
