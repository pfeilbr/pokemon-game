#!/usr/bin/env python3
"""
WCAG colour-contrast audit for the web client.

Why this exists
---------------
`scripts/audit_a11y.py` already proves a tap target is big enough and that a
button has a name. Nothing proved a child could *read* anything. This app is a
dark theme - `--color-ink` (#0b1120) under two radial gradients - carrying six
element palettes, coloured meters, gradient buttons and a great deal of
`text-slate-400`-ish secondary text. Low contrast is the failure a designer
never notices, because the designer is looking at a good monitor in a dark
room. The player is seven and is often on an iPad in a sunlit car.

Contrast is also the one accessibility property that is pure arithmetic. There
is no judgement in it: two colours, one ratio, one threshold. So it can be
proven rather than reviewed, and that is what this does.

What it checks
--------------
  text-contrast      every JSX text node whose foreground and background both
                     resolve statically meets 4.5:1, or 3:1 when the text is
                     large (>= 24px, or >= 18.66px at font-weight >= 700).
                     Every finding names the rule it was judged by, with the
                     size and weight it inherited.
  element-contrast   the same test for the six element palettes. An element
                     chip's label sits on a tint of *its own* colour, so the
                     two ends of the pair move together and have to be
                     evaluated element by element - see "Correlated branches".
  meter-contrast     a meter's fill against its own track, at 3:1 (WCAG 1.4.11,
                     non-text contrast). How full a bar is *is* the
                     information; a fill the same luminance as its track shows
                     nothing. HP, XP, the speed meter and the album and skill
                     progress bars are all this one idiom - a childless
                     coloured box inside an `overflow-hidden` box.
  focus-contrast     the global focus ring against every surface it can be
                     drawn on, at 3:1. It is the only thing a keyboard user has.
  threshold          the ratios above are constants of WCAG 2.1, not of this
                     repository, so the script refuses to run against weakened
                     ones rather than certifying a lowered bar.

Where the colours come from
---------------------------
Nothing here restates a palette. The Tailwind colours are read out of the
installed package - `node_modules/tailwindcss/theme.css` - and converted from
OKLCH to sRGB with the standard matrices, so `text-slate-400` means whatever
the pinned Tailwind says it means, and a version bump that retunes a ramp is
measured rather than assumed away. The project tokens (`--color-ink`,
`--color-spark`, …) come from the `@theme` block in `src/app/globals.css`, the
page background from the `body` rule beneath it, the `panel` surface from its
`@utility` block, the inherited text colour from `<body className>` in
`layout.tsx`, and the six element colours from `ELEMENT_STYLE` in
`src/lib/game/elements.ts`.

Backgrounds are resolved by walking up the JSX nesting, compositing alpha as a
browser would (`bg-white/5`, `bg-slate-900/80`, `#ff6b3522`,
`rgba(19,28,51,0.92)`) and taking every stop of a gradient as its own
candidate. The worst candidate is the one reported, because the worst
candidate is the one a child has to read.

Two roots, not one. A shared component in `src/components/` is rendered
sometimes straight onto the page and sometimes inside a `panel`; the panel is
the lighter surface, so light text has *less* contrast there. Both are tried
and the worse wins. The page itself contributes three candidates - flat
`--color-ink` plus the two radial-gradient stops painted over it, which really
do reach full opacity at their centres, which is exactly where a header sits.

Correlated branches
-------------------
`background: ${style.color}22` with `color: style.color` is not two unknowns.
It is one unknown ranging over six known colours, and pairing an Ember label
with a Frost tint would invent a violation that cannot happen. The same is true
of `${has ? 'text-white' : 'text-slate-600'}` inside an element whose own
background is `has ? {…} : undefined`, and of `VARIANTS[variant]`, which
carries a button's background and its text colour in one string.

So every colour carries a *binding*: a set of (name, value) assignments such as
`{style=stone}` or `{has=false}` or `{VARIANTS[variant]=danger}`. Two colours
are only ever compared when their bindings agree on every name they share, and
the reported finding prints the binding it was found under. Without this the
first run of this script reported a slate-300 label on an amber-400 background
- a combination the toggle it came from can never render.

What static analysis can and cannot prove
-----------------------------------------
Same discipline as `audit_a11y.py` and `audit_i18n.py`. A pair whose two ends
are both literal - a Tailwind class, a hex, an `rgba()`, a `${style.color}22`
tint of a known element - is a provable violation and fails the build. A colour
that only exists at runtime is not judged; it goes in NEEDS REVIEW, which is
printed and never fails the build. Guessing there would produce false alarms,
and an audit people learn to ignore enforces nothing.

Usage
-----
    python3 scripts/audit_contrast.py             # verify
    python3 scripts/audit_contrast.py --pairs     # dump every pair it resolved
    python3 scripts/audit_contrast.py --unchecked # list what this does not check

Exit status
-----------
0  every property holds.
1  at least one property is violated; each finding names the property it broke
   and prints the computed ratio.
2  the audit itself could not run (no Tailwind package, no palette, a missing
   or restructured source file). A failure to measure is never a pass.

Determinism
-----------
Standard library only. No clock, no randomness, no network, no subprocess.
Findings are sorted, so two runs on the same tree print byte-identical output.

The JSX scanner is imported from `audit_a11y.py` rather than copied, exactly as
`audit_i18n.py` does it. It is the same problem - "where does this tag end, and
what are its direct children" - and a second copy would drift from the one that
is already exercised daily.
"""

from __future__ import annotations

import argparse
import math
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from audit_a11y import (
        attr_raw,
        base_tokens,
        class_tokens,
        direct_children,
        find_close,
        find_tag_end,
        parse_props,
        resolve_consts,
    )
except ImportError as error:  # pragma: no cover - only when a file is missing
    print(f"audit_contrast: cannot import the JSX scanner from audit_a11y.py: {error}", file=sys.stderr)
    raise SystemExit(2)

try:
    # Comments have to be invisible to a scanner that reads conditions out of
    # the source: the first run of this script reported a binding whose name
    # was half a `//` comment that happened to sit inside a ternary. The same
    # function already exists for the same reason next door - blanking rather
    # than deleting, so every line number still points at the real line.
    from audit_i18n import blank_comments
except ImportError as error:  # pragma: no cover - only when a file is missing
    print(f"audit_contrast: cannot import blank_comments from audit_i18n.py: {error}", file=sys.stderr)
    raise SystemExit(2)

REPO = Path(__file__).resolve().parent.parent

# WCAG 2.1 SC 1.4.3 (text) and 1.4.11 (non-text). Constants of the standard,
# not preferences of this repository - see the `threshold` guard in main().
NORMAL_MIN = 4.5
LARGE_MIN = 3.0
NON_TEXT_MIN = 3.0

# "Large scale" per WCAG: at least 18pt, or 14pt bold. At the 96dpi CSS
# reference that is 24px, or 18.66px at font-weight 700 or heavier.
LARGE_PX = 24.0
LARGE_BOLD_PX = 18.66
BOLD = 700

ROOT_FONT_PX = 16.0

# Tailwind's default type scale, in px. `audit_a11y` holds the matching *line*
# heights, which answer a different question - a tap target is as tall as its
# line box, but the WCAG large-text rule is about the font size.
TEXT_SIZE_PX = {
    "xs": 12.0,
    "sm": 14.0,
    "base": 16.0,
    "lg": 18.0,
    "xl": 20.0,
    "2xl": 24.0,
    "3xl": 30.0,
    "4xl": 36.0,
    "5xl": 48.0,
    "6xl": 60.0,
    "7xl": 72.0,
    "8xl": 96.0,
    "9xl": 128.0,
}

FONT_WEIGHT = {
    "thin": 100,
    "extralight": 200,
    "light": 300,
    "normal": 400,
    "medium": 500,
    "semibold": 600,
    "bold": 700,
    "extrabold": 800,
    "black": 900,
}

SCAN_ROOTS = (Path("src") / "components", Path("src") / "app")

# A branch explosion is a bug in this script, not a property of the source. If
# an expression ever needs more than this many variants, the honest answer is
# "not resolved", not a minute of cross products.
MAX_VARIANTS = 48


def broke(message: str) -> None:
    print(f"audit_contrast: could not run the audit: {message}", file=sys.stderr)
    raise SystemExit(2)


# --------------------------------------------------------------------------
# Colour arithmetic. sRGB in, WCAG ratio out.
# --------------------------------------------------------------------------

RGB = tuple[int, int, int]


@dataclass(frozen=True, order=True)
class Rgba:
    r: int
    g: int
    b: int
    a: float = 1.0

    @property
    def rgb(self) -> RGB:
        return (self.r, self.g, self.b)

    def hex(self) -> str:
        base = f"#{self.r:02x}{self.g:02x}{self.b:02x}"
        return base if self.a >= 1.0 else f"{base}@{self.a:.0%}"


def oklch_to_srgb(lightness: float, chroma: float, hue_deg: float) -> RGB:
    """OKLCH -> sRGB, with the matrices from the Oklab specification.

    Tailwind v4 ships its palette as OKLCH, so this is the only way to get
    `slate-400` out of the installed package rather than out of a table typed
    in by hand - a table that would be silently wrong the day Tailwind retunes
    a ramp, which is exactly the drift an audit exists to catch.
    """
    hue = math.radians(hue_deg)
    a = chroma * math.cos(hue)
    b = chroma * math.sin(hue)

    l_ = lightness + 0.3963377774 * a + 0.2158037573 * b
    m_ = lightness - 0.1055613458 * a - 0.0638541728 * b
    s_ = lightness - 0.0894841775 * a - 1.2914855480 * b
    long_, medium, short = l_**3, m_**3, s_**3

    red = +4.0767416621 * long_ - 3.3077115913 * medium + 0.2309699292 * short
    green = -1.2684380046 * long_ + 2.6097574011 * medium - 0.3413193965 * short
    blue = -0.0041960863 * long_ - 0.7034186147 * medium + 1.7076147010 * short

    def encode(channel: float) -> int:
        channel = max(0.0, min(1.0, channel))
        srgb = 12.92 * channel if channel <= 0.0031308 else 1.055 * channel ** (1 / 2.4) - 0.055
        return int(round(srgb * 255))

    return (encode(red), encode(green), encode(blue))


def relative_luminance(colour: RGB) -> float:
    """WCAG 2.1 relative luminance."""

    def channel(value: int) -> float:
        srgb = value / 255
        return srgb / 12.92 if srgb <= 0.04045 else ((srgb + 0.055) / 1.055) ** 2.4

    red, green, blue = (channel(v) for v in colour)
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def contrast_ratio(fore: RGB, back: RGB) -> float:
    lighter, darker = sorted((relative_luminance(fore), relative_luminance(back)), reverse=True)
    return (lighter + 0.05) / (darker + 0.05)


def composite(top: Rgba, bottom: RGB) -> RGB:
    """Source-over: `top` painted onto the opaque `bottom`."""
    if top.a >= 1.0:
        return top.rgb
    return tuple(int(round(t * top.a + b * (1 - top.a))) for t, b in zip(top.rgb, bottom))  # type: ignore[return-value]


def rgb_hex(colour: RGB) -> str:
    return "#{:02x}{:02x}{:02x}".format(*colour)


# --------------------------------------------------------------------------
# Bindings: which branch of which condition a colour belongs to.
# --------------------------------------------------------------------------

Binding = frozenset  # frozenset[tuple[str, str]]
FREE: Binding = frozenset()


def compatible(one: Binding, other: Binding) -> bool:
    left = dict(one)
    return all(name not in left or left[name] == value for name, value in other)


def merge(one: Binding, other: Binding) -> Binding:
    return one | other


def show(binding: Binding) -> str:
    if not binding:
        return ""
    return " [" + ", ".join(f"{name}={value}" for name, value in sorted(binding)) + "]"


# --------------------------------------------------------------------------
# Parsing colours out of CSS-ish text
# --------------------------------------------------------------------------

HEX = re.compile(r"#([0-9a-fA-F]{3,8})\b")
FUNC_RGB = re.compile(r"\brgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)\s*(?:[,/]\s*([0-9.%]+)\s*)?\)")
VAR_REF = re.compile(r"var\(\s*(--[a-zA-Z0-9-]+)\s*\)")


def parse_hex(text: str) -> Rgba | None:
    digits = text.lstrip("#")
    if len(digits) in (3, 4):
        digits = "".join(c * 2 for c in digits)
    if len(digits) == 6:
        return Rgba(int(digits[0:2], 16), int(digits[2:4], 16), int(digits[4:6], 16))
    if len(digits) == 8:
        return Rgba(
            int(digits[0:2], 16),
            int(digits[2:4], 16),
            int(digits[4:6], 16),
            int(digits[6:8], 16) / 255,
        )
    return None


MIX_START = re.compile(r"color-mix\(\s*in\s+srgb\s*,", re.I)
MIX_OPERAND = re.compile(r"^\s*(.*?)\s*(?:([0-9.]+)%)?\s*$")


def _resolve_color_mix(text: str, tokens: dict[str, Rgba]) -> str:
    """Replace every `color-mix(in srgb, A p%, B)` with the colour it yields.

    The `panel` utility already mixes towards `transparent`, and an element
    chip mixes towards `--color-ink` so that its surface no longer depends on
    whatever card it was dropped onto. Both have to be *computed*: leaving the
    two operands lying around as separate candidates would have this script
    judge a chip label against the undiluted element colour it is written in,
    which is 1:1 and nonsense.
    """
    while True:
        start = MIX_START.search(text)
        if not start:
            return text
        depth = 1
        i = start.end()
        while i < len(text) and depth:
            if text[i] == "(":
                depth += 1
            elif text[i] == ")":
                depth -= 1
            i += 1
        if depth:
            return text
        operands = _split_top_level(text[start.end() : i - 1])
        if len(operands) != 2:
            return text
        parsed: list[tuple[Rgba, float | None]] = []
        for operand in operands:
            match = MIX_OPERAND.match(operand)
            body = match.group(1) if match else operand
            weight = float(match.group(2)) / 100 if match and match.group(2) else None
            if body.strip() == "transparent":
                parsed.append((Rgba(0, 0, 0, 0.0), weight))
                continue
            colours = colours_in(body, tokens)
            if not colours:
                return text
            parsed.append((colours[0], weight))
        (first, first_weight), (second, second_weight) = parsed
        if first_weight is None and second_weight is None:
            first_weight = second_weight = 0.5
        elif first_weight is None:
            first_weight = 1 - (second_weight or 0.0)
        elif second_weight is None:
            second_weight = 1 - first_weight
        alpha = first_weight * first.a + second_weight * second.a
        if alpha <= 0:
            mixed = Rgba(0, 0, 0, 0.0)
        else:
            channels = [
                (first_weight * first.a * a + second_weight * second.a * b) / alpha
                for a, b in zip(first.rgb, second.rgb)
            ]
            mixed = Rgba(*(int(round(c)) for c in channels), alpha)
        text = text[: start.start()] + f"rgba({mixed.r},{mixed.g},{mixed.b},{mixed.a})" + text[i:]


def _split_top_level(text: str) -> list[str]:
    parts: list[str] = []
    depth = 0
    current = ""
    for char in text:
        if char in "([":
            depth += 1
        elif char in ")]":
            depth -= 1
        if char == "," and depth == 0:
            parts.append(current)
            current = ""
        else:
            current += char
    parts.append(current)
    return parts


def colours_in(text: str, tokens: dict[str, Rgba]) -> list[Rgba]:
    """Every colour literal in a CSS value, in source order, deduplicated."""
    if "color-mix" in text:
        text = _resolve_color_mix(text, tokens)
    found: list[Rgba] = []

    def add(colour: Rgba | None) -> None:
        if colour is not None and colour not in found:
            found.append(colour)

    for match in VAR_REF.finditer(text):
        add(tokens.get(match.group(1)))
    for match in FUNC_RGB.finditer(text):
        raw_alpha = match.group(4)
        alpha = 1.0
        if raw_alpha is not None:
            alpha = float(raw_alpha[:-1]) / 100 if raw_alpha.endswith("%") else float(raw_alpha)
        add(
            Rgba(
                int(round(float(match.group(1)))),
                int(round(float(match.group(2)))),
                int(round(float(match.group(3)))),
                alpha,
            )
        )
    for match in HEX.finditer(text):
        add(parse_hex(match.group(0)))
    return found


# --------------------------------------------------------------------------
# The palettes, all read from source
# --------------------------------------------------------------------------

OKLCH_TOKEN = re.compile(r"--color-([a-z]+-\d+)\s*:\s*oklch\(\s*([0-9.]+)%\s+([0-9.]+)\s+([0-9.]+)\s*\)")
FLAT_TOKEN = re.compile(r"--color-([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;")
ELEMENT_ENTRY = re.compile(r"(\w+)\s*:\s*\{\s*color:\s*'(#[0-9a-fA-F]{6})'\s*,\s*deep:\s*'(#[0-9a-fA-F]{6})'")


@dataclass
class Palette:
    named: dict[str, Rgba] = field(default_factory=dict)  # 'slate-400', 'ink', 'white'
    tokens: dict[str, Rgba] = field(default_factory=dict)  # '--color-ink' -> Rgba
    elements: dict[str, Rgba] = field(default_factory=dict)  # 'ember' -> Rgba
    element_deep: dict[str, Rgba] = field(default_factory=dict)
    page: list[RGB] = field(default_factory=list)  # body background candidates
    panel: Rgba | None = None  # the `panel` utility surface, alpha included
    focus_ring: Rgba | None = None


def load_tailwind(palette: Palette) -> None:
    theme = REPO / "node_modules" / "tailwindcss" / "theme.css"
    if not theme.is_file():
        broke(f"{theme} is missing - run `npm install` first")
    source = theme.read_text(encoding="utf-8")
    for name, lightness, chroma, hue in OKLCH_TOKEN.findall(source):
        red, green, blue = oklch_to_srgb(float(lightness) / 100, float(chroma), float(hue))
        palette.named[name] = Rgba(red, green, blue)
    for name, value in FLAT_TOKEN.findall(source):
        colour = parse_hex(value)
        if colour is not None:
            palette.named[name] = colour
    if "slate-400" not in palette.named or "white" not in palette.named:
        broke("the Tailwind theme names no slate-400/white; the palette could not be read")


def load_project(palette: Palette) -> None:
    css_path = REPO / "src" / "app" / "globals.css"
    if not css_path.is_file():
        broke("src/app/globals.css is missing")
    css = css_path.read_text(encoding="utf-8")

    theme_block = re.search(r"@theme\s*\{(.*?)\n\}", css, re.S)
    if not theme_block:
        broke("src/app/globals.css has no @theme block, so the project tokens cannot be read")
    for name, value in FLAT_TOKEN.findall(theme_block.group(1)):
        colour = parse_hex(value)
        if colour is None:
            continue
        palette.tokens[f"--color-{name}"] = colour
        palette.named.setdefault(name, colour)

    # The page. `body` in globals.css is unlayered, so it beats the
    # `bg-slate-950` utility on <body> in layout.tsx; the flat colour at the
    # bottom of that stack is --color-ink, and the two radial gradients above
    # it reach full opacity at their centres. All three are real backgrounds a
    # child reads text on, so all three are candidates. `body` appears twice in
    # the file - once grouped with `html` for the tap-highlight reset - so take
    # the rule that actually paints rather than the first one matched.
    background = None
    for body in re.finditer(r"(?:^|\n)(?:[^\n{}]*,\s*\n)*body\s*\{(.*?)\n\}", css, re.S):
        found = re.search(r"(?<![-\w])background\s*:(.*?);", body.group(1), re.S)
        if found:
            background = found
    if not background:
        broke("no `body` rule in src/app/globals.css paints a background")
    stack = colours_in(background.group(1), palette.tokens)
    if not stack:
        broke("the `body` background names no colour this script can read")
    base = stack[-1]
    palette.page = [base.rgb]
    for layer in stack[:-1]:
        painted = composite(layer, base.rgb)
        if painted not in palette.page:
            palette.page.append(painted)

    utility = re.search(r"@utility\s+panel\s*\{(.*?)\n\}", css, re.S)
    if not utility:
        broke("src/app/globals.css has no `@utility panel` block")
    surface = re.search(r"(?<![-\w])background\s*:(.*?);", utility.group(1), re.S)
    if not surface:
        broke("the `panel` utility declares no background")
    flat = colours_in(surface.group(1), palette.tokens)
    if not flat:
        broke("the `panel` utility declares no background this script can read")
    palette.panel = flat[0]

    focus = re.search(r":focus-visible\s*\{(.*?)\n\}", css, re.S)
    if not focus:
        broke("src/app/globals.css has no `:focus-visible` rule")
    outline = re.search(r"outline\s*:(.*?);", focus.group(1), re.S)
    if not outline:
        broke("the `:focus-visible` rule declares no outline")
    ring = colours_in(outline.group(1), palette.tokens)
    if not ring:
        broke("the focus outline names no colour this script can read")
    palette.focus_ring = ring[0]


def load_elements(palette: Palette) -> None:
    path = REPO / "src" / "lib" / "game" / "elements.ts"
    if not path.is_file():
        broke("src/lib/game/elements.ts is missing, so the element palette cannot be read")
    source = path.read_text(encoding="utf-8")
    block = re.search(r"ELEMENT_STYLE:\s*Record<Element,\s*ElementStyle>\s*=\s*\{(.*?)\n\};", source, re.S)
    if not block:
        broke("src/lib/game/elements.ts has no ELEMENT_STYLE table this script can read")
    for name, colour, deep in ELEMENT_ENTRY.findall(block.group(1)):
        parsed, parsed_deep = parse_hex(colour), parse_hex(deep)
        if parsed is None or parsed_deep is None:
            continue
        palette.elements[name] = parsed
        palette.element_deep[name] = parsed_deep
    listed = re.search(r"export const ELEMENTS = \[(.*?)\] as const;", source, re.S)
    if not listed:
        broke("src/lib/game/elements.ts has no ELEMENTS list")
    missing = sorted(set(re.findall(r"'([a-z]+)'", listed.group(1))) - set(palette.elements))
    if missing:
        broke(f"ELEMENT_STYLE has no readable colour for: {', '.join(missing)}")


# --------------------------------------------------------------------------
# Tailwind class -> colour
# --------------------------------------------------------------------------


def class_colour(token: str, prefix: str, palette: Palette) -> Rgba | None:
    """Resolve `bg-slate-900/80`, `text-white`, `bg-[#123456]`, `bg-white/[0.03]`."""
    if not token.startswith(prefix + "-"):
        return None
    rest = token[len(prefix) + 1 :]

    alpha = 1.0
    if "/" in rest:
        rest, _, opacity = rest.rpartition("/")
        # Tailwind writes an opacity modifier as a percentage (`/80`), or in
        # square brackets as a raw alpha (`/[0.03]`). Deciding by the brackets
        # rather than by "is it <= 1" keeps `/1` meaning one per cent.
        bracketed = opacity.startswith("[") and opacity.endswith("]")
        try:
            value = float(opacity[1:-1] if bracketed else opacity)
        except ValueError:
            return None
        alpha = value if bracketed else value / 100

    if rest.startswith("[") and rest.endswith("]"):
        inner = rest[1:-1]
        parsed = parse_hex(inner) if inner.startswith("#") else None
        if parsed is None:
            return None
        return Rgba(parsed.r, parsed.g, parsed.b, parsed.a * alpha)

    base = palette.named.get(rest)
    if base is None:
        return None
    return Rgba(base.r, base.g, base.b, base.a * alpha)


# --------------------------------------------------------------------------
# Expanding a JSX expression into its branches
#
# `className={`… ${has ? 'text-white' : 'text-slate-600'}`}` is two class
# lists, not one, and `style={has ? {…} : undefined}` on the ancestor is the
# same `has`. Collapsing either into "all the literals I can see" is what made
# the first draft report a slate-300 label on an amber-400 button - a pairing
# the toggle it came from cannot render. So an expression is expanded into
# (binding, concrete text) pairs, and only compatible bindings are compared.
# --------------------------------------------------------------------------

PLACEHOLDER = re.compile("\x00(\\d+)\x00")


def _slot(index: int) -> str:
    return f"\x00{index}\x00"


def _read_branch(text: str, start: int) -> tuple[int, int] | None:
    """Consume one ternary branch: a string, an object literal, or a name."""
    n = len(text)
    i = start
    while i < n and text[i].isspace():
        i += 1
    if i >= n:
        return None
    char = text[i]
    if char in "'\"`":
        j = i + 1
        while j < n:
            if text[j] == "\\":
                j += 2
                continue
            if text[j] == char:
                return (i, j + 1)
            if char == "`" and text[j] == "$" and j + 1 < n and text[j + 1] == "{":
                depth = 1
                j += 2
                while j < n and depth:
                    if text[j] == "{":
                        depth += 1
                    elif text[j] == "}":
                        depth -= 1
                    j += 1
                continue
            j += 1
        return None
    if char == "{":
        depth = 0
        j = i
        while j < n:
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0:
                    return (i, j + 1)
            j += 1
        return None
    match = re.compile(r"\x00\d+\x00|[A-Za-z_$][\w$]*").match(text, i)
    return (i, match.end()) if match else None


def _condition_start(text: str, question: int) -> int:
    """Where the condition governing `text[question]` begins."""
    depth = 0
    i = question - 1
    while i >= 0:
        char = text[i]
        if char in ")]}":
            depth += 1
        elif char in "([{":
            if depth == 0:
                break
            depth -= 1
        elif depth == 0 and (char in ",;:`" or char == "\x00"):
            # `:` ends the condition in both shapes that matter: an object key
            # (`background: crit ? … : …`) and an enclosing ternary's else
            # branch. Without it the property name was swallowed into the
            # condition and the whole declaration disappeared - which is how
            # the speed meter's fill went unmeasured on the first green run.
            break
        i -= 1
    return i + 1


CLASS_RECORD = re.compile(r"\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*\{")


def class_records(src: str) -> dict[str, dict[str, str]]:
    """`const VARIANTS: Record<…, string> = { primary: '…', … }`.

    Without this a `<Button variant="danger">` carries no colour at all as far
    as this script is concerned, and the one string that holds both its
    background and its text colour goes unread - which is precisely where the
    worst pair in the app was hiding.
    """
    out: dict[str, dict[str, str]] = {}
    for match in CLASS_RECORD.finditer(src):
        start = match.end() - 1
        depth = 0
        i = start
        while i < len(src):
            if src[i] == "{":
                depth += 1
            elif src[i] == "}":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        entries: dict[str, str] = {}
        for entry in re.finditer(
            r"([A-Za-z_$][\w$]*)\s*:\s*((?:'[^'\n]*'|\"[^\"\n]*\")(?:\s*\+\s*(?:'[^'\n]*'|\"[^\"\n]*\"))*)",
            src[start + 1 : i],
        ):
            parts = re.findall(r"'([^'\n]*)'|\"([^\"\n]*)\"", entry.group(2))
            entries[entry.group(1)] = " ".join((a or b).strip() for a, b in parts)
        if entries:
            out[match.group(1)] = entries
    return out


def expr_variants(raw: str, records: dict[str, dict[str, str]]) -> list[tuple[Binding, str]]:
    """(binding, concrete expression) for every branch of `raw`."""
    text = raw
    options: dict[int, list[tuple[Binding, str]]] = {}
    counter = 0

    for name in sorted(records):
        pattern = re.compile(r"(?<![\w$.])" + re.escape(name) + r"\[\s*([^\]\n]*?)\s*\]")
        while True:
            match = pattern.search(text)
            if not match:
                break
            key = f"{name}[{match.group(1)}]"
            options[counter] = [
                (frozenset({(key, entry)}), f"'{value}'")
                for entry, value in sorted(records[name].items())
            ]
            text = text[: match.start()] + _slot(counter) + text[match.end() :]
            counter += 1

    while True:
        collapsed = False
        for question in reversed([m.start() for m in re.finditer(r"\?", text)]):
            first = _read_branch(text, question + 1)
            if first is None:
                continue
            after = first[1]
            while after < len(text) and text[after].isspace():
                after += 1
            if after >= len(text) or text[after] != ":":
                continue
            second = _read_branch(text, after + 1)
            if second is None:
                continue
            start = _condition_start(text, question)
            condition = " ".join(text[start:question].split())
            if not condition:
                continue
            options[counter] = [
                (frozenset({(condition, "true")}), text[first[0] : first[1]]),
                (frozenset({(condition, "false")}), text[second[0] : second[1]]),
            ]
            text = text[:start] + _slot(counter) + text[second[1] :]
            counter += 1
            collapsed = True
            break
        if not collapsed:
            break

    def resolve(current: str, binding: Binding) -> list[tuple[Binding, str]]:
        match = PLACEHOLDER.search(current)
        if match is None:
            return [(binding, current)]
        out: list[tuple[Binding, str]] = []
        for extra, replacement in options[int(match.group(1))]:
            if not compatible(binding, extra):
                continue
            out.extend(
                resolve(current[: match.start()] + replacement + current[match.end() :], merge(binding, extra))
            )
            if len(out) > MAX_VARIANTS:
                break
        return out

    variants = resolve(text, FREE)
    if not variants or len(variants) > MAX_VARIANTS:
        return [(FREE, raw)]
    return variants


# --------------------------------------------------------------------------
# Element colours and local hex constants inside a resolved expression
# --------------------------------------------------------------------------

INTERPOLATION = re.compile(r"\$\{([^{}]*)\}")
ELEMENT_FIELD = re.compile(r"^(?P<root>.+?)\.\s*(?P<half>color|deep)$")
HEX_LITERAL = re.compile(r"'(#[0-9a-fA-F]{3,8})'|\"(#[0-9a-fA-F]{3,8})\"")


# Values that mean "this declaration paints nothing", as opposed to "this
# declaration paints something I cannot read".
NO_PAINT = {"", "undefined", "null", "none", "transparent", "inherit", "initial", "unset"}


class Unresolvable(Exception):
    """A colour that only exists at runtime. Reported, never guessed at."""


def colour_consts(src: str) -> dict[str, list[str]]:
    """Local `const colour = cond ? '#34d399' : '#fb7185';` bindings.

    Both the health bar and the maths breakdown choose their bar colour this
    way, so without this the two most meaningful meters in the app would be
    unresolvable. Every branch is kept and the worst is the one judged.
    """
    out: dict[str, list[str]] = {}
    for match in re.finditer(r"\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]*);", src):
        literals = [a or b for a, b in HEX_LITERAL.findall(match.group(2))]
        if literals:
            out[match.group(1)] = literals
    return out


def _substitute(text: str, palette: Palette, consts: dict[str, list[str]]) -> list[tuple[Binding, str]]:
    """Replace element references and hex constants, one variant per element."""
    variants: list[tuple[Binding, str]] = [(FREE, text)]

    def apply(needle: str, choices: list[tuple[Binding, str]], word: bool) -> None:
        nonlocal variants
        pattern = re.compile((r"(?<![\w$.])" + re.escape(needle) + r"(?![\w$])") if word else re.escape(needle))
        grown: list[tuple[Binding, str]] = []
        for binding, current in variants:
            for extra, replacement in choices:
                if not compatible(binding, extra):
                    continue
                grown.append((merge(binding, extra), pattern.sub(replacement, current)))
        variants = grown[:MAX_VARIANTS]

    for match in INTERPOLATION.finditer(text):
        inner = match.group(1).strip()
        field_match = ELEMENT_FIELD.match(inner)
        if field_match:
            root = field_match.group("root").strip()
            table = palette.elements if field_match.group("half") == "color" else palette.element_deep
            apply(
                match.group(0),
                [(frozenset({(root, name)}), colour.hex()) for name, colour in sorted(table.items())],
                word=False,
            )
            continue
        head = inner.split(".")[0].strip()
        if head in consts:
            apply(
                match.group(0),
                [(frozenset({(head, value)}), value) for value in consts[head]],
                word=False,
            )
            continue
        raise Unresolvable(f"`{match.group(0)}` is computed at runtime")

    # A bare reference, as in `background: colour` or `color: style.color`.
    outside = INTERPOLATION.sub(" ", text)
    for match in re.finditer(r"(?<![\w$.'\"#])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)", outside):
        expression = match.group(1)
        field_match = ELEMENT_FIELD.match(expression)
        if field_match:
            root = field_match.group("root").strip()
            table = palette.elements if field_match.group("half") == "color" else palette.element_deep
            apply(
                expression,
                [(frozenset({(root, name)}), colour.hex()) for name, colour in sorted(table.items())],
                word=True,
            )
            continue
        head = expression.split(".")[0]
        if head in consts and expression == head:
            apply(expression, [(frozenset({(head, v)}), v) for v in consts[head]], word=True)
    return variants


def value_colours(
    values: list[tuple[Binding, str | None]], palette: Palette, consts: dict[str, list[str]]
) -> list[tuple[Binding, Rgba | None]]:
    """Colour candidates for a set of CSS values, each carrying its binding."""
    out: list[tuple[Binding, Rgba | None]] = []
    for binding, text in values:
        if text is None:
            out.append((binding, None))
            continue
        before = len(out)
        for extra, concrete in _substitute(text, palette, consts):
            for colour in colours_in(concrete, palette.tokens):
                entry = (merge(binding, extra), colour)
                if entry not in out:
                    out.append(entry)
        if len(out) == before:
            # Two very different silences. `background: isCatch ? 'rgba(…)' :
            # undefined` has a branch that names no colour and still renders,
            # so it paints nothing rather than ceasing to exist - dropping it
            # is how a 2.26:1 label once passed. `background: tintFor(element)`
            # names a colour this script cannot read, and calling *that* "no
            # paint" would silently measure against the wrong surface, which
            # is worse than admitting ignorance.
            if text.strip().rstrip(",") in NO_PAINT:
                out.append((binding, None))
            else:
                raise Unresolvable(f"`{text.strip()}` names no colour this script can read")
    return out


# --------------------------------------------------------------------------
# The JSX tree
# --------------------------------------------------------------------------


@dataclass
class Node:
    tag: str
    attrs: str
    inner: str
    inner_offset: int
    line: int
    self_closing: bool


def jsx_nodes(text: str, offset: int, src: str) -> list[Node]:
    """Top-level JSX elements in `text`, in source order, with real offsets.

    Elements nested inside another element's body are not returned; recursing
    through `.inner` reaches them. Tag-shaped text that is really a TypeScript
    generic (`useState<Profile | null>`) has no matching close tag, so
    `find_close` raises and it is skipped - which is the whole reason this
    walks with the scanner instead of a regex.
    """
    out: list[Node] = []
    consumed = 0
    for match in re.finditer(r"<([A-Za-z][A-Za-z0-9_.]*)", text):
        if match.start() < consumed:
            continue
        tag = match.group(1)
        try:
            end, self_closing = find_tag_end(text, match.start())
            if self_closing:
                inner, after = "", end
            else:
                close = find_close(text, tag, end)
                inner, after = text[end:close], text.index(">", close) + 1
        except ValueError:
            continue
        out.append(
            Node(
                tag=tag,
                attrs=text[match.end() : end - (2 if self_closing else 1)],
                inner=inner,
                inner_offset=offset + end,
                line=src.count("\n", 0, offset + match.start()) + 1,
                self_closing=self_closing,
            )
        )
        consumed = after
    return out


def style_values(attrs: str, names: tuple[str, ...]) -> list[tuple[Binding, str]]:
    """`background`/`color` values from `style={{…}}`, one entry per branch.

    `parse_props` from audit_a11y reads the common object-literal shape. The
    album's `style={has ? {…} : undefined}` is not an object literal at all, so
    it is expanded into branches first and each branch read on its own - which
    is what keeps a locked slot's grey label paired with the plain panel it
    actually sits on rather than with the caught slot's tint.
    """
    raw, kind = attr_raw(attrs, "style")
    if raw is None or kind != "expr":
        return []
    out: list[tuple[Binding, str | None]] = []
    for binding, branch in expr_variants(raw, {}):
        body = branch.strip()
        found = False
        if body.startswith("{") and body.endswith("}"):
            props = parse_props(body[1:-1], 0)
            for name in names:
                if name in props:
                    out.append((binding, props[name]))
                    found = True
        if not found:
            # `style={has ? {…} : undefined}` paints nothing in one branch, and
            # that branch still renders. Recording it as "no paint" rather than
            # dropping it is what keeps a locked album slot's grey label paired
            # with the plain panel it really sits on - without it the whole
            # branch vanished and a 2.26:1 label passed unnoticed.
            out.append((binding, None))
    return out if any(value is not None for _, value in out) else []


# --------------------------------------------------------------------------
# Context: what colour is this text, and what is behind it
# --------------------------------------------------------------------------


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
    """Paint `painted` over `current`. A `None` entry is a branch that paints
    nothing, and inherits rather than disappearing."""
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
    """The lowest ratio over every compatible combination of both sides."""
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


# --------------------------------------------------------------------------
# Findings
# --------------------------------------------------------------------------


@dataclass(frozen=True, order=True)
class Finding:
    path: str
    line: int
    check: str
    detail: str

    def render(self) -> str:
        where = f"{self.path}:{self.line}" if self.line else self.path
        return f"  {where}  [{self.check}] {self.detail}"


@dataclass
class Report:
    violations: list[Finding] = field(default_factory=list)
    review: list[Finding] = field(default_factory=list)
    pairs: list[tuple[str, str, float, float, str]] = field(default_factory=list)

    def fail(self, path: str, line: int, check: str, detail: str) -> None:
        self.violations.append(Finding(path, line, check, detail))

    def note(self, path: str, line: int, check: str, detail: str) -> None:
        finding = Finding(path, line, check, detail)
        if finding not in self.review:
            self.review.append(finding)


def rule_for(size_px: float, weight: int) -> tuple[float, str]:
    if size_px >= LARGE_PX or (size_px >= LARGE_BOLD_PX and weight >= BOLD):
        return LARGE_MIN, f"large text ({size_px:g}px, weight {weight})"
    return NORMAL_MIN, f"normal text ({size_px:g}px, weight {weight})"


# --------------------------------------------------------------------------
# The walk
# --------------------------------------------------------------------------

# SVG has its own painting model and `art.ts` owns it; see UNCHECKED.
TEXTLESS_TAGS = {"svg", "path", "circle", "ellipse", "rect", "g", "defs", "radialGradient", "stop", "Primitive", "Defs"}


def has_visible_text(node: Node) -> bool:
    """A text node, or an expression that renders words rather than markup."""
    for child in direct_children(node.inner):
        if child.kind == "text" and child.text.strip():
            return True
        if child.kind == "expr" and child.text.strip() and "<" not in child.text:
            return True
    return False


@dataclass
class FileScope:
    rel: str
    src: str
    palette: Palette
    report: Report
    consts: dict[str, list[str]]
    class_consts: dict[str, str]
    records: dict[str, dict[str, str]]


def audit_file(rel: str, src: str, palette: Palette, report: Report, root: Context) -> None:
    scope = FileScope(
        rel=rel,
        src=src,
        palette=palette,
        report=report,
        consts=colour_consts(src),
        class_consts=resolve_consts(src),
        records=class_records(src),
    )
    for node in jsx_nodes(src, 0, src):
        visit(node, root, scope)


def class_variants(node: Node, scope: FileScope) -> list[tuple[Binding, list[str]]]:
    raw, kind = attr_raw(node.attrs, "className")
    if raw is None:
        return [(FREE, [])]
    if kind == "string":
        return [(FREE, raw.split())]
    out: list[tuple[Binding, list[str]]] = []
    for binding, branch in expr_variants(raw, scope.records):
        tokens, _ = class_tokens(branch, "expr", scope.class_consts)
        out.append((binding, tokens))
    return out or [(FREE, [])]


def visit(node: Node, parent: Context, scope: FileScope) -> None:
    palette, report = scope.palette, scope.report
    variants = class_variants(node, scope)
    every_token = [token for _, tokens in variants for token in base_tokens(tokens)]

    # When branches disagree about the size or the weight - `size === 'lg' ?
    # 'text-2xl' : 'text-lg'` - the smallest of each is used. That is the
    # branch WCAG judges most strictly, so the error can only ever be in the
    # direction of demanding more contrast than one branch strictly needs.
    size_px, weight = parent.size_px, parent.weight
    sizes: list[float] = []
    weights: list[int] = []
    for token in every_token:
        if token.startswith("text-[") and token.endswith("]"):
            arbitrary = token[6:-1]
            if arbitrary.endswith("px"):
                sizes.append(float(arbitrary[:-2]))
            elif arbitrary.endswith("rem"):
                sizes.append(float(arbitrary[:-3]) * ROOT_FONT_PX)
            continue
        match = re.fullmatch(r"text-([a-z0-9]+)", token)
        if match and match.group(1) in TEXT_SIZE_PX:
            sizes.append(TEXT_SIZE_PX[match.group(1)])
        match = re.fullmatch(r"font-([a-z]+)", token)
        if match and match.group(1) in FONT_WEIGHT:
            weights.append(FONT_WEIGHT[match.group(1)])
    if sizes:
        size_px = min(sizes)
    if weights:
        weight = min(weights)

    unresolved = parent.unresolved

    # ---- background painted by this element -------------------------------
    from_classes: list[tuple[Binding, Rgba | None]] = []
    for binding, tokens in variants:
        before = len(from_classes)
        for token in base_tokens(tokens):
            if token == "panel" and palette.panel is not None:
                from_classes.append((binding, palette.panel))
            for prefix in ("bg", "from", "via", "to"):
                colour = class_colour(token, prefix, palette)
                if colour is not None:
                    from_classes.append((binding, colour))
        if len(from_classes) == before:
            from_classes.append((binding, None))  # this branch paints nothing
    if not any(colour is not None for _, colour in from_classes):
        from_classes = []
    if node.tag == "Panel" and palette.panel is not None:
        from_classes.append((FREE, palette.panel))

    painted = from_classes
    inline = style_values(node.attrs, ("background", "backgroundColor"))
    if inline:
        try:
            resolved = value_colours(inline, palette, scope.consts)
        except Unresolvable as error:
            resolved = []
            unresolved = f"the background at line {node.line} is not static ({error})"
        # An inline `background` shorthand replaces whatever a class painted -
        # but React omits the property entirely when the value is `undefined`,
        # so that branch falls back to the class, not to the parent.
        painted = []
        for binding, colour in resolved:
            if colour is not None:
                painted.append((binding, colour))
            elif from_classes:
                painted.extend(
                    (merge(binding, other), fallback)
                    for other, fallback in from_classes
                    if compatible(binding, other)
                )
            else:
                painted.append((binding, None))

    backgrounds = list(parent.backgrounds)
    if painted:
        backgrounds = layer(backgrounds, painted)
        unresolved = parent.unresolved  # a static repaint hides the unknown beneath

    # ---- foreground declared by this element ------------------------------
    fore = list(parent.fore) if parent.fore is not None else None
    declared: list[tuple[Binding, Rgba]] = []
    for binding, tokens in variants:
        for token in base_tokens(tokens):
            colour = class_colour(token, "text", palette)
            if colour is not None:
                declared.append((binding, colour))
    fore_unresolved: str | None = None
    inline_colour = style_values(node.attrs, ("color",))
    if inline_colour:
        try:
            # A branch that declares no `color` inherits, so it drops out here
            # and the parent's colour keeps standing for it.
            declared = [(b, c) for b, c in value_colours(inline_colour, palette, scope.consts) if c is not None]
        except Unresolvable as error:
            declared = []
            fore_unresolved = str(error)
    if declared:
        fore = declared

    context = Context(
        backgrounds=tuple(backgrounds),
        fore=tuple(fore) if fore is not None else None,
        size_px=size_px,
        weight=weight,
        unresolved=unresolved,
    )

    # ---- (1) text ---------------------------------------------------------
    if node.tag not in TEXTLESS_TAGS and has_visible_text(node):
        label = f"<{node.tag}>"
        if fore_unresolved:
            report.note(scope.rel, node.line, "text-contrast", f"{label} text colour is not static ({fore_unresolved})")
        elif fore is None:
            report.note(
                scope.rel,
                node.line,
                "text-contrast",
                f"{label} declares no colour and inherits none in this file; "
                "the effective colour comes from a caller",
            )
        else:
            minimum, rule = rule_for(size_px, weight)
            judge(node, fore, backgrounds, unresolved, minimum, rule, "text-contrast", label, scope)

    # ---- (2) placeholder text, which base_tokens deliberately drops --------
    for binding, tokens in variants:
        for token in tokens:
            colour = class_colour(token, "placeholder:text", palette)
            if colour is None:
                continue
            judge(
                node,
                [(binding, colour)],
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
    if "overflow-hidden" in every_token and painted:
        for child in children:
            if child.inner.strip() or child.tag in TEXTLESS_TAGS:
                continue
            try:
                fill = fill_colours(child, scope)
            except Unresolvable as error:
                report.note(
                    scope.rel,
                    child.line,
                    "meter-contrast",
                    f"<{child.tag}> fills a track but its colour is not static ({error})",
                )
                continue
            if not fill:
                continue
            judge(
                child,
                fill,
                backgrounds,
                unresolved,
                NON_TEXT_MIN,
                "non-text (meter fill against its track)",
                "meter-contrast",
                f"<{child.tag}> fill",
                scope,
            )

    for child in children:
        visit(child, context, scope)


def fill_colours(node: Node, scope: FileScope) -> list[tuple[Binding, Rgba]]:
    out: list[tuple[Binding, Rgba]] = []
    for binding, tokens in class_variants(node, scope):
        for token in base_tokens(tokens):
            for prefix in ("bg", "from", "via", "to"):
                colour = class_colour(token, prefix, scope.palette)
                if colour is not None:
                    out.append((binding, colour))
    inline = style_values(node.attrs, ("background", "backgroundColor"))
    if inline:
        return [(b, c) for b, c in value_colours(inline, scope.palette, scope.consts) if c is not None]
    return out


def judge(
    node: Node,
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
        scope.report.note(
            scope.rel, node.line, check, f"{label} sits on a background that is not static ({unresolved})"
        )
        return
    worst = worst_pair(fore, back)
    if worst is None:
        scope.report.note(scope.rel, node.line, check, f"{label} has no resolvable colour pair")
        return
    ratio, text_colour, background, binding = worst
    named = "element-contrast" if check == "text-contrast" and any(
        name in scope.palette.elements for _, name in binding
    ) else check
    scope.report.pairs.append(
        (f"{scope.rel}:{node.line}", f"{label}{show(binding)}", ratio, minimum, rule)
    )
    if ratio + 1e-9 < minimum:
        scope.report.fail(
            scope.rel,
            node.line,
            named,
            f"{label}{show(binding)} {text_colour.hex()} on {rgb_hex(background)} "
            f"is {ratio:.2f}:1, below {minimum:g}:1 for {rule}",
        )


# --------------------------------------------------------------------------
# Properties asserted of the engine rather than of a file
# --------------------------------------------------------------------------


CHIP_SURFACE = re.compile(
    r"background:\s*`color-mix\(\s*in srgb\s*,\s*\$\{[^}]*\}\s*([0-9.]+)%\s*,\s*var\(\s*(--[a-z-]+)\s*\)\s*\)`"
)


def check_element_chips(palette: Palette, report: Report) -> None:
    """Every element's label colour on the surface its own chip paints.

    The generic walk already judges each chip where it is written. This asks
    the same thing of `ELEMENT_STYLE` itself, so a seventh element is covered
    the day it lands rather than the day someone remembers to render it.

    The chip's mix ratio is read out of `ui.tsx` rather than restated here, in
    the same spirit as `audit_a11y.py` reading its tap threshold out of the
    `@utility tap` block: a duplicated constant certifies the wrong surface the
    moment the real one moves. If the chip stops being a flat mix over a token,
    the audit stops rather than guessing.
    """
    path = REPO / "src" / "components" / "ui.tsx"
    if not path.is_file():
        broke("src/components/ui.tsx is missing, so the element chip surface is unknown")
    match = CHIP_SURFACE.search(path.read_text(encoding="utf-8"))
    if not match:
        broke(
            "ElementChip in src/components/ui.tsx no longer paints "
            "`color-mix(in srgb, ${…} N%, var(--token))`, so the surface its label sits on "
            "cannot be computed; teach this check the new shape"
        )
    weight = float(match.group(1)) / 100
    base = palette.tokens.get(match.group(2))
    if base is None:
        broke(f"the element chip mixes towards {match.group(2)}, which is not a @theme token")

    for name, colour in sorted(palette.elements.items()):
        surface = composite(Rgba(colour.r, colour.g, colour.b, weight), base.rgb)
        ratio = contrast_ratio(colour.rgb, surface)
        report.pairs.append(
            (
                "src/lib/game/elements.ts",
                f"{name} label on its own chip",
                ratio,
                NORMAL_MIN,
                "normal text (12px, weight 700)",
            )
        )
        if ratio + 1e-9 < NORMAL_MIN:
            report.fail(
                "src/lib/game/elements.ts",
                1,
                "element-contrast",
                f"{name} {colour.hex()} on its own chip surface {rgb_hex(surface)} is "
                f"{ratio:.2f}:1, below {NORMAL_MIN:g}:1; an element chip's label is "
                "written in the element's colour",
            )


def check_focus_ring(palette: Palette, report: Report) -> None:
    if palette.focus_ring is None:
        broke("the focus ring colour could not be read")
    surfaces = list(palette.page)
    if palette.panel is not None:
        for page in palette.page:
            surface = composite(palette.panel, page)
            if surface not in surfaces:
                surfaces.append(surface)
    for surface in surfaces:
        ratio = contrast_ratio(composite(palette.focus_ring, surface), surface)
        report.pairs.append(
            ("src/app/globals.css", f"focus ring on {rgb_hex(surface)}", ratio, NON_TEXT_MIN, "non-text (focus ring)")
        )
        if ratio + 1e-9 < NON_TEXT_MIN:
            report.fail(
                "src/app/globals.css",
                1,
                "focus-contrast",
                f":focus-visible outline {palette.focus_ring.hex()} on {rgb_hex(surface)} "
                f"is {ratio:.2f}:1, below {NON_TEXT_MIN:g}:1 for a focus indicator",
            )


# --------------------------------------------------------------------------
# Deliberately not checked
# --------------------------------------------------------------------------
UNCHECKED = [
    (
        "container boundaries",
        "WCAG 1.4.11 also asks that the edge of an input or a card be "
        "distinguishable when nothing else identifies it. This script judges "
        "only what carries information a player has to read: text, and a "
        "meter's fill against its own track. Every input here is labelled, "
        "placed and permanently visible, so its `ring-white/15` edge is "
        "decoration rather than the only cue - and flagging all of them would "
        "bury the findings that are real.",
    ),
    (
        "creature art",
        "`art.ts` emits gradients over a transparent background, and a "
        "creature is never the only carrier of its own identity: every "
        "creature on screen is named in text beside it, and the album's locked "
        "slots are silhouettes on purpose. No WCAG threshold applies to a "
        "picture of a monster.",
    ),
    (
        "state dots and icons",
        "The sync dot in the header and the ▲/▼ matchup arrows are aria-hidden "
        "and each sits next to text that says the same thing, so they are "
        "redundant by 1.4.11's own exception. The moment one becomes the only "
        "cue that exception stops applying - and this entry is where someone "
        "should notice.",
    ),
    (
        "disabled controls",
        "`disabled:opacity-40` puts a button below every threshold, which is "
        "what WCAG explicitly exempts: 1.4.3 and 1.4.11 both exclude inactive "
        "components. A disabled move button is *meant* to read as unavailable.",
    ),
    (
        "where on the page a gradient actually lands",
        "The body's two radial gradients are treated as flat candidates at "
        "full opacity, because that is what they reach at their centres. "
        "Whether a given paragraph sits under a centre or out in the "
        "transparent tail depends on the viewport, so the strict answer is "
        "assumed everywhere. That errs towards stricter than reality, never "
        "laxer, which is the only direction an audit may err in.",
    ),
    (
        "text over creature art or an emoji",
        "Nothing in this app draws a label across a sprite, and an emoji "
        "brings its own colours rather than taking `color`. If either changes, "
        "the pair stops being two flat colours and this script's arithmetic "
        "stops describing it.",
    ),
    (
        "a shared component on a caller's tinted card",
        "`<HealthBar>` is judged where it is written, against the page and "
        "against a panel. It is also dropped into the battle's "
        "element-tinted panels, which are lighter than either. Following a "
        "component's props across files is real dataflow analysis; the "
        "practical guard is that the tint is the same `${style.color}` in "
        "every one of those call sites, so anything that reads on the "
        "lightest element (Spark) reads on all of them - and the element chip, "
        "the one component whose own colour is the tint, is checked exactly.",
    ),
    (
        "the iOS client",
        "`mobile/` has its own palette in `mobile/src/theme.ts` and its own "
        "renderer. Auditing it belongs here one day, but the root CI job does "
        "not install `mobile/node_modules`, and nothing at the root should "
        "grow a reason to reach across that boundary.",
    ),
]


# --------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------


def scan_targets() -> list[Path]:
    out: list[Path] = []
    for root in SCAN_ROOTS:
        base = REPO / root
        if not base.is_dir():
            broke(f"{root} is missing, so it cannot be scanned")
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = sorted(d for d in dirnames if d not in ("node_modules", ".next"))
            for name in sorted(filenames):
                if name.endswith(".tsx") and ".test." not in name and not name.startswith("__"):
                    out.append(Path(dirpath) / name)
    return sorted(out)


def root_context(palette: Palette) -> Context:
    """The surfaces a component can find itself on, and the colour it inherits.

    Both the bare page and a `panel` on the page are candidates: shared
    components in this app are rendered on each, and the panel is the lighter
    of the two, so light text has less contrast there. The inherited colour is
    whatever `<body>` in layout.tsx sets, because a paragraph that declares
    none of its own gets that one.
    """
    surfaces: list[RGB] = list(palette.page)
    if palette.panel is not None:
        for page in palette.page:
            surface = composite(palette.panel, page)
            if surface not in surfaces:
                surfaces.append(surface)

    inherited: list[tuple[Binding, Rgba]] = []
    layout = REPO / "src" / "app" / "layout.tsx"
    if layout.is_file():
        match = re.search(r"<body[^>]*className=\"([^\"]*)\"", layout.read_text(encoding="utf-8"))
        if match:
            for token in match.group(1).split():
                colour = class_colour(token, "text", palette)
                if colour is not None:
                    inherited.append((FREE, colour))
    return Context(
        backgrounds=tuple((FREE, surface) for surface in surfaces),
        fore=tuple(inherited) if inherited else None,
        size_px=ROOT_FONT_PX,
        weight=FONT_WEIGHT["normal"],
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


def wrap(text: str, width: int) -> list[str]:
    lines: list[str] = []
    current = ""
    for word in text.split():
        if current and len(current) + 1 + len(word) > width:
            lines.append(current)
            current = word
        else:
            current = f"{current} {word}".strip()
    if current:
        lines.append(current)
    return lines


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit WCAG colour contrast in the web client.")
    parser.add_argument("--pairs", action="store_true", help="dump every colour pair it resolved")
    parser.add_argument("--unchecked", action="store_true", help="print what this audit does not check")
    args = parser.parse_args()

    if args.unchecked:
        print_unchecked()
        return 0

    # The thresholds are WCAG's, not this repository's. Reaching green by
    # lowering one would be the exact failure this script exists to prevent, so
    # it refuses to run against weakened constants rather than quietly passing.
    if NORMAL_MIN < 4.5 or LARGE_MIN < 3.0 or NON_TEXT_MIN < 3.0:
        broke("the WCAG thresholds in this file have been lowered below the standard")

    palette = Palette()
    load_tailwind(palette)
    load_project(palette)
    load_elements(palette)

    report = Report()
    root = root_context(palette)

    targets = scan_targets()
    for path in targets:
        audit_file(
            str(path.relative_to(REPO)),
            blank_comments(path.read_text(encoding="utf-8")),
            palette,
            report,
            root,
        )

    check_element_chips(palette, report)
    check_focus_ring(palette, report)

    report.violations.sort()
    report.review.sort()
    report.pairs.sort()

    if args.pairs:
        if not report.pairs:
            broke("no colour pair resolved at all; the scanner is not seeing the source")
        width = min(max(len(where) for where, _, _, _, _ in report.pairs), 42)
        print(f"Colour pairs resolved ({len(report.pairs)})")
        print("-" * 78)
        for where, label, ratio, minimum, rule in report.pairs:
            verdict = "ok  " if ratio + 1e-9 >= minimum else "FAIL"
            print(f"  {verdict} {ratio:6.2f}:1 (>= {minimum:g})  {where.ljust(width)}  {label} - {rule}")
        return 0

    print("Mathmon contrast audit")
    print("======================")
    print(f"palette: {len(palette.named)} named colours, {len(palette.elements)} elements")
    print(f"surfaces: {len(palette.page)} page background(s) + the panel over each")
    print(f"files scanned: {len(targets)}")
    print(f"colour pairs resolved: {len(report.pairs)}")
    print(
        f"thresholds: {NORMAL_MIN:g}:1 normal text, {LARGE_MIN:g}:1 large text "
        f"(>={LARGE_PX:g}px, or >={LARGE_BOLD_PX:g}px bold), {NON_TEXT_MIN:g}:1 non-text"
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
