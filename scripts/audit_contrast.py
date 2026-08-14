#!/usr/bin/env python3
"""
WCAG colour-contrast audit for the web client.

Why this exists
---------------
`scripts/audit_a11y.py` already proves a tap target is big enough and a button
has a name. Nothing proved a child could *read* anything. This app is a dark
theme - `--color-ink` (#0b1120) under two radial gradients - carrying six
element palettes, coloured meters, gradient buttons and a great deal of
`text-slate-400`-ish secondary text. Low contrast is the failure a designer
never sees, because the designer is looking at a good monitor in a dark room.
The player is seven and is often on an iPad in a sunlit car.

Contrast is also the one accessibility property that is pure arithmetic. There
is no judgement in it: two colours, one ratio, one threshold. So it can be
proven rather than reviewed, and that is what this does.

What it checks
--------------
  text-contrast      every JSX text node whose foreground and background both
                     resolve statically meets 4.5:1, or 3:1 when the text is
                     large (>= 24px, or >= 18.66px at font-weight >= 700).
                     Every finding says which rule it was judged by.
  element-contrast   the same test for the six element palettes, where the
                     foreground *and* the background are both derived from the
                     same `ELEMENT_STYLE` entry - an element chip's label sits
                     on a tint of its own colour, so the two move together and
                     have to be evaluated element by element.
  meter-contrast     a meter's fill against its own track, at 3:1 (WCAG 1.4.11,
                     non-text contrast). How full a bar is *is* the
                     information; a fill the same luminance as its track shows
                     nothing. HP, XP, the speed meter and the album/skill
                     progress bars are all this idiom.
  focus-contrast     the global focus ring against every background it can be
                     drawn on, at 3:1. It is the only thing a keyboard user has.
  threshold          the ratios above are constants of WCAG 2.1, not of this
                     repository, so the script refuses to run against weakened
                     ones.

Where the colours come from
---------------------------
Nothing here restates a palette. The Tailwind colours are read out of the
installed package - `node_modules/tailwindcss/theme.css` - and converted from
OKLCH to sRGB with the standard matrices, so `text-slate-400` means whatever
the pinned Tailwind version says it means and a major-version bump that
re-tunes the ramp is caught rather than assumed away. The project tokens
(`--color-ink`, `--color-spark`, …) come from the `@theme` block in
`src/app/globals.css`, the page background from the `body` rule beneath it, the
`panel` surface from its `@utility` block, and the six element colours from
`ELEMENT_STYLE` in `src/lib/game/elements.ts`.

Backgrounds are resolved by walking up the JSX nesting: a colour is composited
onto whatever its ancestors painted, honouring alpha (`bg-white/5`,
`bg-slate-900/80`, `#ff6b3522`, `rgba(19,28,51,0.92)`) and taking every stop of
a gradient as a separate candidate. The worst candidate is the one reported,
because the worst candidate is the one a child has to read.

Two roots, not one. A shared component in `src/components/` is rendered
sometimes straight onto the page and sometimes inside a `panel`, and the panel
is the lighter of the two, so light text has less contrast there. Both are
tried and the worse wins. The page background itself contributes three
candidates - the flat `--color-ink` plus the two radial-gradient stops painted
over it, which really do reach full opacity at their centres, right where the
header sits.

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
2  the audit itself could not run (no Tailwind package, no palette, a source
   file missing). A failure to measure is never reported as a pass.

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
        TEXT_LINE_HEIGHT,
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

REPO = Path(__file__).resolve().parent.parent

# WCAG 2.1 SC 1.4.3 (text) and 1.4.11 (non-text). These are constants of the
# standard, not preferences of this repository, so they are asserted rather
# than parsed out of anything - see the `threshold` check in main().
NORMAL_MIN = 4.5
LARGE_MIN = 3.0
NON_TEXT_MIN = 3.0

# "Large scale" per WCAG: at least 18pt, or 14pt bold. At the 96dpi CSS
# reference that is 24px, or 18.66px at font-weight 700 or heavier.
LARGE_PX = 24.0
LARGE_BOLD_PX = 18.66
BOLD = 700

ROOT_FONT_PX = 16.0

# Tailwind's default type scale, in px. The line heights already live in
# audit_a11y as TEXT_LINE_HEIGHT; the *font* sizes are what the WCAG large-text
# rule is about, and they are a different table.
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


def broke(message: str) -> None:
    print(f"audit_contrast: could not run the audit: {message}", file=sys.stderr)
    raise SystemExit(2)


# --------------------------------------------------------------------------
# Colour arithmetic
#
# sRGB in, WCAG ratio out. Everything is exact float maths on integers parsed
# from the source, so the numbers below are reproducible by hand.
# --------------------------------------------------------------------------

RGB = tuple[int, int, int]


@dataclass(frozen=True)
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
        return base if self.a >= 1.0 else f"{base} @{self.a:.0%}"


def oklch_to_srgb(lightness: float, chroma: float, hue_deg: float) -> RGB:
    """OKLCH -> sRGB, with the matrices from the Oklab specification.

    Tailwind v4 ships its palette as OKLCH, so this is the only way to get
    `slate-400` out of the installed package rather than out of a table typed
    in by hand - a table that would be silently wrong the day Tailwind retunes
    a ramp, which is precisely the drift an audit exists to catch.
    """
    hue = math.radians(hue_deg)
    a = chroma * math.cos(hue)
    b = chroma * math.sin(hue)

    l_ = lightness + 0.3963377774 * a + 0.2158037573 * b
    m_ = lightness - 0.1055613458 * a - 0.0638541728 * b
    s_ = lightness - 0.0894841775 * a - 1.2914855480 * b
    long, medium, short = l_**3, m_**3, s_**3

    red = +4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short
    green = -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short
    blue = -0.0041960863 * long - 0.7034186147 * medium + 1.7076147010 * short

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


# --------------------------------------------------------------------------
# Parsing colours out of CSS-ish text
# --------------------------------------------------------------------------

HEX = re.compile(r"#([0-9a-fA-F]{3,8})\b")
FUNC_RGB = re.compile(r"\brgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)\s*(?:[,/]\s*([0-9.%]+)\s*)?\)")
VAR_REF = re.compile(r"var\(\s*(--[a-zA-Z0-9-]+)\s*\)")


def parse_hex(text: str) -> Rgba | None:
    digits = text.lstrip("#")
    if len(digits) == 3:
        digits = "".join(c * 2 for c in digits)
    elif len(digits) == 4:
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


def colours_in(text: str, tokens: dict[str, Rgba]) -> list[Rgba]:
    """Every colour literal in a CSS value, in source order, deduplicated."""
    found: list[Rgba] = []

    def add(colour: Rgba | None) -> None:
        if colour is not None and colour not in found:
            found.append(colour)

    for match in VAR_REF.finditer(text):
        add(tokens.get(match.group(1)))
    for match in FUNC_RGB.finditer(text):
        alpha_raw = match.group(4)
        alpha = 1.0
        if alpha_raw is not None:
            alpha = float(alpha_raw[:-1]) / 100 if alpha_raw.endswith("%") else float(alpha_raw)
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

OKLCH_TOKEN = re.compile(
    r"--color-([a-z]+-\d+)\s*:\s*oklch\(\s*([0-9.]+)%\s+([0-9.]+)\s+([0-9.]+)\s*\)"
)
FLAT_TOKEN = re.compile(r"--color-([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;")
ELEMENT_ENTRY = re.compile(
    r"(\w+)\s*:\s*\{\s*color:\s*'(#[0-9a-fA-F]{6})'\s*,\s*deep:\s*'(#[0-9a-fA-F]{6})'"
)


@dataclass
class Palette:
    """Every colour name the app can write, and the surfaces it paints on."""

    named: dict[str, Rgba] = field(default_factory=dict)  # 'slate-400', 'ink', 'white'
    tokens: dict[str, Rgba] = field(default_factory=dict)  # '--color-ink' -> Rgba
    elements: dict[str, Rgba] = field(default_factory=dict)  # 'ember' -> Rgba
    element_deep: dict[str, Rgba] = field(default_factory=dict)
    page: list[RGB] = field(default_factory=list)  # body background candidates
    panel: Rgba | None = None  # the `panel` utility surface, with its alpha
    focus_ring: Rgba | None = None


def load_tailwind(palette: Palette) -> None:
    theme = REPO / "node_modules" / "tailwindcss" / "theme.css"
    if not theme.is_file():
        broke(f"{theme.relative_to(REPO)} is missing - run `npm install` first")
    source = theme.read_text(encoding="utf-8")
    for name, lightness, chroma, hue in OKLCH_TOKEN.findall(source):
        red, green, blue = oklch_to_srgb(float(lightness) / 100, float(chroma), float(hue))
        palette.named[name] = Rgba(red, green, blue)
    for name, value in FLAT_TOKEN.findall(source):
        colour = parse_hex(value)
        if colour is not None:
            palette.named[name] = colour
    if "slate-400" not in palette.named or "white" not in palette.named:
        broke("the Tailwind theme has no slate-400/white; the palette could not be read")


def load_project(palette: Palette) -> str:
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

    # The page. `body` in globals.css is unlayered, so it wins over the
    # `bg-slate-950` utility on <body> in layout.tsx; the flat colour at the
    # bottom of the stack is --color-ink, and the two radial gradients above it
    # reach full opacity at their centres - which is exactly where the header
    # sits. All three are real backgrounds, so all three are candidates.
    # `body` appears twice - once grouped with `html` for the tap-highlight
    # reset - so take the rule that actually paints, not the first one matched.
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
    palette.page = [base.rgb] + [composite(c, base.rgb) for c in stack[:-1]]

    utility = re.search(r"@utility\s+panel\s*\{(.*?)\n\}", css, re.S)
    if not utility:
        broke("src/app/globals.css has no `@utility panel` block")
    mix = re.search(
        r"color-mix\(\s*in srgb\s*,\s*var\(\s*(--[a-z-]+)\s*\)\s*([0-9.]+)%\s*,\s*transparent\s*\)",
        utility.group(1),
    )
    if mix:
        token = palette.tokens.get(mix.group(1))
        if token is None:
            broke(f"the `panel` utility mixes {mix.group(1)}, which is not a @theme token")
        palette.panel = Rgba(token.r, token.g, token.b, float(mix.group(2)) / 100)
    else:
        flat = colours_in(utility.group(1), palette.tokens)
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

    return css


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
    expected = re.findall(r"'([a-z]+)'", listed.group(1))
    missing = sorted(set(expected) - set(palette.elements))
    if missing:
        broke(f"ELEMENT_STYLE has no readable colour for: {', '.join(missing)}")


# --------------------------------------------------------------------------
# Tailwind class -> colour
# --------------------------------------------------------------------------

UTILITY = re.compile(
    r"^(?:text|bg|from|via|to|ring|border|outline|placeholder|decoration|caret|fill|stroke|accent|shadow|divide)-"
)


def class_colour(token: str, prefix: str, palette: Palette) -> Rgba | None:
    """Resolve `bg-slate-900/80`, `text-white`, `bg-[#123456]`, `bg-white/[0.03]`."""
    if not token.startswith(prefix + "-"):
        return None
    rest = token[len(prefix) + 1 :]

    alpha = 1.0
    if "/" in rest:
        rest, _, opacity = rest.rpartition("/")
        if opacity.startswith("[") and opacity.endswith("]"):
            opacity = opacity[1:-1]
        try:
            alpha = float(opacity) / 100 if not opacity.startswith("0.") else float(opacity)
        except ValueError:
            return None
        if alpha > 1.0:
            alpha = alpha / 100

    if rest.startswith("[") and rest.endswith("]"):
        parsed = parse_hex(rest[1:-1]) if rest[1:-1].startswith("#") else None
        if parsed is None:
            return None
        return Rgba(parsed.r, parsed.g, parsed.b, parsed.a * alpha)

    base = palette.named.get(rest)
    if base is None:
        return None
    return Rgba(base.r, base.g, base.b, base.a * alpha)


# --------------------------------------------------------------------------
# Element-bound values
#
# `background: ${style.color}22` and `color: style.color` are not two unknowns:
# they are the same unknown, ranging over six known colours. Evaluating them
# independently would pair an Ember label with a Frost tint and invent a
# violation that cannot happen. So every colour is resolved once per binding -
# '' for "does not depend on an element", or the element's own name - and only
# ratios computed under the same binding are compared.
# --------------------------------------------------------------------------

NEUTRAL_BINDING = ""
INTERPOLATION = re.compile(r"\$\{([^{}]*)\}")
ELEMENT_FIELD = re.compile(r"\.\s*(color|deep)\s*$")
HEX_LITERAL = re.compile(r"'(#[0-9a-fA-F]{3,8})'|\"(#[0-9a-fA-F]{3,8})\"")


class Unresolvable(Exception):
    """A colour that only exists at runtime. Reported, never guessed at."""


def colour_consts(src: str) -> dict[str, list[str]]:
    """Local `const colour = cond ? '#34d399' : '#fb7185';` bindings.

    Both the health bar and the maths breakdown pick their bar colour this way,
    so without this the two most meaningful meters in the app would be
    unresolvable. Every branch is kept and the worst is the one judged.
    """
    out: dict[str, list[str]] = {}
    for match in re.finditer(r"\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]*);", src):
        literals = [a or b for a, b in HEX_LITERAL.findall(match.group(2))]
        if literals:
            out[match.group(1)] = literals
    return out


def expand(text: str, palette: Palette, consts: dict[str, list[str]]) -> dict[str, list[str]]:
    """Substitute interpolations, giving concrete CSS per binding.

    Raises Unresolvable when an interpolation is neither an element colour nor
    a local constant of hex literals.
    """
    variants: dict[str, list[str]] = {NEUTRAL_BINDING: [text]}

    def apply(replacer) -> None:
        nonlocal variants
        next_variants: dict[str, list[str]] = {}
        for binding, texts in variants.items():
            for candidate_binding, replacement in replacer(binding):
                merged = candidate_binding if candidate_binding else binding
                bucket = next_variants.setdefault(merged, [])
                for value in texts:
                    swapped = replacement(value)
                    if swapped not in bucket:
                        bucket.append(swapped)
        variants = next_variants

    for match in INTERPOLATION.finditer(text):
        whole, inner = match.group(0), match.group(1).strip()
        field_match = ELEMENT_FIELD.search(inner)
        if field_match:
            source = palette.elements if field_match.group(1) == "color" else palette.element_deep

            def replacer(_binding, whole=whole, source=source):
                return [
                    (name, lambda value, w=whole, c=colour: value.replace(w, c.hex().split(" ")[0]))
                    for name, colour in sorted(source.items())
                ]

            apply(replacer)
            continue
        name = inner.split(".")[0].strip()
        if name in consts:

            def replacer(_binding, whole=whole, options=consts[name]):
                return [(NEUTRAL_BINDING, lambda value, w=whole, o=option: value.replace(w, o)) for option in options]

            apply(replacer)
            continue
        raise Unresolvable(f"`{whole}` is computed at runtime")

    # A bare identifier, as in `background: colour` or `color: style.color`.
    stripped = INTERPOLATION.sub(" ", text)
    for match in re.finditer(r"(?<![\w$.'\"#])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)", stripped):
        expression = match.group(1)
        if expression in ("undefined", "null", "transparent", "none", "solid", "linear", "radial"):
            continue
        field_match = ELEMENT_FIELD.search(expression)
        if field_match:
            source = palette.elements if field_match.group(1) == "color" else palette.element_deep

            def replacer(_binding, expression=expression, source=source):
                return [
                    (
                        name,
                        lambda value, e=expression, c=colour: re.sub(
                            r"(?<![\w$.])" + re.escape(e) + r"(?![\w$])", c.hex(), value
                        ),
                    )
                    for name, colour in sorted(source.items())
                ]

            apply(replacer)
            continue
        root = expression.split(".")[0]
        if root in consts:

            def replacer(_binding, expression=expression, options=consts[root]):
                return [
                    (
                        NEUTRAL_BINDING,
                        lambda value, e=expression, o=option: re.sub(
                            r"(?<![\w$.])" + re.escape(e) + r"(?![\w$])", o, value
                        ),
                    )
                    for option in options
                ]

            apply(replacer)

    return variants


def value_colours(
    text: str, palette: Palette, consts: dict[str, list[str]]
) -> dict[str, list[Rgba]]:
    """Colour candidates for a CSS value, keyed by element binding."""
    out: dict[str, list[Rgba]] = {}
    for binding, texts in expand(text, palette, consts).items():
        bucket: list[Rgba] = []
        for value in texts:
            for colour in colours_in(value, palette.tokens):
                if colour not in bucket:
                    bucket.append(colour)
        out[binding] = bucket
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
        attrs = text[match.end() : end - (2 if self_closing else 1)]
        out.append(
            Node(
                tag=tag,
                attrs=attrs,
                inner=inner,
                inner_offset=offset + end,
                line=src.count("\n", 0, offset + match.start()) + 1,
                self_closing=self_closing,
            )
        )
        consumed = after
    return out


def style_values(attrs: str, names: tuple[str, ...]) -> list[str]:
    """Values of `background`/`color`/… inside a `style={{…}}` attribute.

    `parse_props` from audit_a11y handles the common shape. The album's
    `style={has ? {…} : undefined}` is not an object literal at all, so a
    balanced scan forward from the property name picks it up too.
    """
    raw, kind = attr_raw(attrs, "style")
    if raw is None or kind != "expr":
        return []
    out: list[str] = []
    body = raw.strip()
    if body.startswith("{") and body.endswith("}"):
        props = parse_props(body[1:-1], 0)
        for name in names:
            if name in props:
                out.append(props[name])
        if out:
            return out
    for name in names:
        for match in re.finditer(r"(?<![\w$-])" + re.escape(name) + r"\s*:", raw):
            depth = 0
            i = match.end()
            start = i
            while i < len(raw):
                char = raw[i]
                if char in "{[(":
                    depth += 1
                elif char in "]))":
                    depth -= 1
                elif char == "}":
                    if depth == 0:
                        break
                    depth -= 1
                elif char == "," and depth == 0:
                    break
                i += 1
            out.append(raw[start:i].strip())
    return out


# --------------------------------------------------------------------------
# Context: what colour is this text, and what is behind it
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Context:
    backgrounds: tuple[tuple[str, tuple[RGB, ...]], ...]  # binding -> candidates
    fore: tuple[tuple[str, tuple[Rgba, ...]], ...] | None
    size_px: float
    weight: int
    unresolved: str | None

    def background_map(self) -> dict[str, list[RGB]]:
        return {binding: list(values) for binding, values in self.backgrounds}

    def fore_map(self) -> dict[str, list[Rgba]] | None:
        if self.fore is None:
            return None
        return {binding: list(values) for binding, values in self.fore}


def freeze_bg(mapping: dict[str, list[RGB]]) -> tuple[tuple[str, tuple[RGB, ...]], ...]:
    return tuple((binding, tuple(values)) for binding, values in sorted(mapping.items()))


def freeze_fg(mapping: dict[str, list[Rgba]]) -> tuple[tuple[str, tuple[Rgba, ...]], ...]:
    return tuple((binding, tuple(values)) for binding, values in sorted(mapping.items()))


def bindings_of(*maps: dict) -> list[str]:
    """The bindings two maps have in common, broadcasting the neutral one."""
    keys: set[str] = set()
    for mapping in maps:
        keys |= {k for k in mapping if k != NEUTRAL_BINDING}
    if not keys:
        return [NEUTRAL_BINDING]
    return sorted(keys)


def lookup(mapping: dict[str, list], binding: str) -> list:
    if binding in mapping:
        return mapping[binding]
    return mapping.get(NEUTRAL_BINDING, [])


def layer_backgrounds(
    current: dict[str, list[RGB]], painted: dict[str, list[Rgba]]
) -> dict[str, list[RGB]]:
    out: dict[str, list[RGB]] = {}
    for binding in bindings_of(current, painted):
        beneath = lookup(current, binding)
        above = lookup(painted, binding)
        if not above:
            out[binding] = beneath
            continue
        stacked: list[RGB] = []
        for top in above:
            for bottom in beneath or [(0, 0, 0)]:
                result = composite(top, bottom)
                if result not in stacked:
                    stacked.append(result)
        out[binding] = stacked
    return out


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
        self.review.append(Finding(path, line, check, detail))


def rule_for(size_px: float, weight: int) -> tuple[float, str]:
    if size_px >= LARGE_PX or (size_px >= LARGE_BOLD_PX and weight >= BOLD):
        return LARGE_MIN, f"large text ({size_px:g}px/{weight})"
    return NORMAL_MIN, f"normal text ({size_px:g}px/{weight})"


def worst_pair(
    fore: dict[str, list[Rgba]], back: dict[str, list[RGB]]
) -> tuple[float, Rgba, RGB, str] | None:
    """The lowest ratio over every binding and every candidate on both sides."""
    worst: tuple[float, Rgba, RGB, str] | None = None
    for binding in bindings_of(fore, back):
        for text_colour in lookup(fore, binding):
            for background in lookup(back, binding):
                flat = composite(text_colour, background)
                ratio = contrast_ratio(flat, background)
                if worst is None or ratio < worst[0]:
                    worst = (ratio, text_colour, background, binding)
    return worst


def rgb_hex(colour: RGB) -> str:
    return "#{:02x}{:02x}{:02x}".format(*colour)


# --------------------------------------------------------------------------
# The walk
# --------------------------------------------------------------------------

TEXTLESS_TAGS = {"svg", "path", "circle", "ellipse", "rect", "g", "defs", "radialGradient", "stop"}


def has_visible_text(node: Node) -> bool:
    """A text node or an expression that renders something, rather than markup."""
    for child in direct_children(node.inner):
        if child.kind == "text" and child.text.strip():
            return True
        if child.kind == "expr" and child.text.strip() and "<" not in child.text:
            return True
    return False


def audit_file(rel: str, src: str, palette: Palette, report: Report, root: Context) -> None:
    consts = colour_consts(src)
    class_consts = resolve_consts(src)
    for node in jsx_nodes(src, 0, src):
        visit(node, root, rel, src, palette, report, consts, class_consts)


def visit(
    node: Node,
    parent: Context,
    rel: str,
    src: str,
    palette: Palette,
    report: Report,
    consts: dict[str, list[str]],
    class_consts: dict[str, str],
) -> None:
    raw, kind = attr_raw(node.attrs, "className")
    tokens: list[str] = []
    if raw is not None:
        tokens, _ = class_tokens(raw, kind, class_consts)
    base = base_tokens(tokens)

    size_px = parent.size_px
    weight = parent.weight
    for token in base:
        if token.startswith("text-["):
            arbitrary = token[6:-1]
            if arbitrary.endswith("px"):
                size_px = float(arbitrary[:-2])
            elif arbitrary.endswith("rem"):
                size_px = float(arbitrary[:-3]) * ROOT_FONT_PX
        else:
            match = re.fullmatch(r"text-([a-z0-9]+)", token)
            if match and match.group(1) in TEXT_SIZE_PX:
                size_px = TEXT_SIZE_PX[match.group(1)]
        match = re.fullmatch(r"font-([a-z]+)", token)
        if match and match.group(1) in FONT_WEIGHT:
            weight = FONT_WEIGHT[match.group(1)]

    unresolved = parent.unresolved

    # ---- background painted by this element -------------------------------
    painted: dict[str, list[Rgba]] = {}
    for token in base:
        if token == "panel" or token.startswith("panel"):
            if palette.panel is not None:
                painted.setdefault(NEUTRAL_BINDING, []).append(palette.panel)
        for prefix in ("bg", "from", "via", "to"):
            colour = class_colour(token, prefix, palette)
            if colour is not None:
                painted.setdefault(NEUTRAL_BINDING, []).append(colour)
    if node.tag == "Panel" and palette.panel is not None:
        painted.setdefault(NEUTRAL_BINDING, []).insert(0, palette.panel)

    inline_backgrounds = style_values(node.attrs, ("background", "backgroundColor"))
    for value in inline_backgrounds:
        try:
            resolved = value_colours(value, palette, consts)
        except Unresolvable as error:
            unresolved = f"the background at line {node.line} is not static: {error}"
            painted = {}
            break
        # An inline `background` shorthand replaces whatever a class painted.
        painted = {}
        for binding, colours in resolved.items():
            painted.setdefault(binding, []).extend(colours)

    backgrounds = parent.background_map()
    if painted:
        backgrounds = layer_backgrounds(backgrounds, painted)
        unresolved = parent.unresolved  # a static repaint hides the unknown beneath

    # ---- foreground declared by this element ------------------------------
    fore = parent.fore_map()
    declared: dict[str, list[Rgba]] = {}
    for token in base:
        colour = class_colour(token, "text", palette)
        if colour is not None:
            declared.setdefault(NEUTRAL_BINDING, []).append(colour)
    fore_unresolved: str | None = None
    for value in style_values(node.attrs, ("color",)):
        try:
            resolved = value_colours(value, palette, consts)
        except Unresolvable as error:
            fore_unresolved = str(error)
            declared = {}
            break
        declared = {}
        for binding, colours in resolved.items():
            declared.setdefault(binding, []).extend(colours)
    if declared:
        fore = declared

    context = Context(
        backgrounds=freeze_bg(backgrounds),
        fore=freeze_fg(fore) if fore is not None else None,
        size_px=size_px,
        weight=weight,
        unresolved=unresolved,
    )

    # ---- (1) text ---------------------------------------------------------
    if node.tag not in TEXTLESS_TAGS and has_visible_text(node):
        check_text(node, context, fore_unresolved, rel, report)

    # ---- (2) placeholder text, which the base tokens deliberately drop -----
    for token in tokens:
        colour = class_colour(token, "placeholder:text", palette)
        if colour is None:
            continue
        check_pair(
            node,
            {NEUTRAL_BINDING: [colour]},
            backgrounds,
            unresolved,
            NORMAL_MIN,
            f"placeholder text ({size_px:g}px/{weight})",
            "text-contrast",
            f"<{node.tag}> placeholder",
            rel,
            report,
        )

    # ---- (3) a meter fill against its own track ---------------------------
    children = jsx_nodes(node.inner, node.inner_offset, src)
    if "overflow-hidden" in base and painted:
        track = backgrounds
        for child in children:
            if child.inner.strip() or child.tag in TEXTLESS_TAGS:
                continue
            fill = fill_colours(child, palette, consts, class_consts)
            if fill is None:
                report.note(
                    rel,
                    child.line,
                    "meter-contrast",
                    f"<{child.tag}> fills a track but its colour is computed at runtime",
                )
                continue
            check_pair(
                child,
                fill,
                track,
                unresolved,
                NON_TEXT_MIN,
                "non-text (meter fill vs track)",
                "meter-contrast",
                f"<{child.tag}> fill",
                rel,
                report,
            )

    for child in children:
        visit(child, context, rel, src, palette, report, consts, class_consts)


def fill_colours(
    node: Node, palette: Palette, consts: dict[str, list[str]], class_consts: dict[str, str]
) -> dict[str, list[Rgba]] | None:
    raw, kind = attr_raw(node.attrs, "className")
    tokens = base_tokens(class_tokens(raw, kind, class_consts)[0]) if raw is not None else []
    out: dict[str, list[Rgba]] = {}
    for token in tokens:
        for prefix in ("bg", "from", "via", "to"):
            colour = class_colour(token, prefix, palette)
            if colour is not None:
                out.setdefault(NEUTRAL_BINDING, []).append(colour)
    for value in style_values(node.attrs, ("background", "backgroundColor")):
        try:
            resolved = value_colours(value, palette, consts)
        except Unresolvable:
            return None
        out = {}
        for binding, colours in resolved.items():
            out.setdefault(binding, []).extend(colours)
    return out or None


def check_text(
    node: Node, context: Context, fore_unresolved: str | None, rel: str, report: Report
) -> None:
    label = f"<{node.tag}>"
    if fore_unresolved:
        report.note(rel, node.line, "text-contrast", f"{label} text colour is not static: {fore_unresolved}")
        return
    fore = context.fore_map()
    if fore is None:
        report.note(
            rel,
            node.line,
            "text-contrast",
            f"{label} declares no colour and none is inherited in this file; "
            "the effective colour comes from a caller",
        )
        return
    minimum, rule = rule_for(context.size_px, context.weight)
    check_pair(
        node,
        fore,
        context.background_map(),
        context.unresolved,
        minimum,
        rule,
        "text-contrast",
        label,
        rel,
        report,
    )


def check_pair(
    node: Node,
    fore: dict[str, list[Rgba]],
    back: dict[str, list[RGB]],
    unresolved: str | None,
    minimum: float,
    rule: str,
    check: str,
    label: str,
    rel: str,
    report: Report,
) -> None:
    if unresolved:
        report.note(rel, node.line, check, f"{label} sits on a background that is not static: {unresolved}")
        return
    worst = worst_pair(fore, back)
    if worst is None:
        report.note(rel, node.line, check, f"{label} has no resolvable colour pair")
        return
    ratio, text_colour, background, binding = worst
    where = f" [{binding}]" if binding else ""
    name = "element-contrast" if binding and check == "text-contrast" else check
    report.pairs.append((f"{rel}:{node.line}", f"{label}{where}", ratio, minimum, rule))
    if ratio + 1e-9 < minimum:
        report.fail(
            rel,
            node.line,
            name,
            f"{label}{where} {text_colour.hex()} on {rgb_hex(background)} "
            f"is {ratio:.2f}:1, below {minimum:g}:1 for {rule}",
        )


# --------------------------------------------------------------------------
# Deliberately not checked
# --------------------------------------------------------------------------
UNCHECKED = [
    (
        "container boundaries",
        "WCAG 1.4.11 also asks that the boundary of an input or a card be "
        "distinguishable when nothing else identifies it. This script judges "
        "only what carries information a player has to read: text, and the "
        "fill of a meter against its own track. Every input in this app is "
        "labelled, placed and permanently visible, so its `ring-white/15` edge "
        "is decoration rather than the only cue - and flagging all of them "
        "would bury the findings that are real.",
    ),
    (
        "creature art",
        "`art.ts` emits gradients over a transparent background and the "
        "creature is never the only carrier of its own identity - every "
        "creature on screen is named in text beside it, and the album's "
        "locked slots are silhouettes on purpose. There is no threshold in "
        "WCAG that applies to a picture of a monster.",
    ),
    (
        "state dots and icons",
        "The sync dot in the header and the ▲/▼ matchup arrows are marked "
        "aria-hidden and each sits next to text that says the same thing, so "
        "they are redundant by 1.4.11's own exception. The moment one of them "
        "becomes the only cue, that exception stops applying - and this entry "
        "is where someone should notice.",
    ),
    (
        "disabled controls",
        "`disabled:opacity-40` puts a button below every threshold, which is "
        "what WCAG explicitly exempts (1.4.3 and 1.4.11 both exclude inactive "
        "components). A disabled move button is *meant* to read as unavailable.",
    ),
    (
        "where on the page a gradient actually lands",
        "The body's two radial gradients are entered as flat candidates at "
        "full opacity, because that is what they reach at their centres. "
        "Whether a given paragraph sits under that centre or out in the "
        "transparent tail depends on the viewport, so the strict answer is "
        "assumed everywhere. That is the conservative direction: it can only "
        "make the audit stricter than reality, never laxer.",
    ),
    (
        "the iOS client",
        "`mobile/` has its own palette in `mobile/src/theme.ts` and its own "
        "renderer. Auditing it belongs in the same script one day, but the "
        "root CI job does not install `mobile/node_modules`, and nothing here "
        "should grow a reason to reach across that boundary.",
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
    """The surfaces a component can find itself on, and the inherited colour.

    Both the bare page and a `panel` on the page are candidates: a shared
    component is rendered on each in this app, and the panel is the lighter of
    the two, so light text has less contrast there. The inherited text colour
    is whatever `<body>` in layout.tsx sets, because a paragraph that declares
    no colour of its own gets that one.
    """
    surfaces = list(palette.page)
    if palette.panel is not None:
        for page in palette.page:
            surface = composite(palette.panel, page)
            if surface not in surfaces:
                surfaces.append(surface)

    inherited: dict[str, list[Rgba]] | None = None
    layout = REPO / "src" / "app" / "layout.tsx"
    if layout.is_file():
        match = re.search(r"<body[^>]*className=\"([^\"]*)\"", layout.read_text(encoding="utf-8"))
        if match:
            for token in match.group(1).split():
                colour = class_colour(token, "text", palette)
                if colour is not None:
                    inherited = {NEUTRAL_BINDING: [colour]}
    return Context(
        backgrounds=freeze_bg({NEUTRAL_BINDING: surfaces}),
        fore=freeze_fg(inherited) if inherited else None,
        size_px=ROOT_FONT_PX,
        weight=FONT_WEIGHT["normal"],
        unresolved=None,
    )


def check_focus_ring(palette: Palette, report: Report) -> None:
    if palette.focus_ring is None:
        broke("the focus ring colour could not be read")
    surfaces = list(palette.page)
    if palette.panel is not None:
        surfaces += [composite(palette.panel, page) for page in palette.page]
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


def check_element_chips(palette: Palette, report: Report) -> None:
    """Every element label on every other element's surface it is drawn over.

    The generic walk already judges each chip where it is written; this is the
    same six colours asked as a property of the engine rather than of a file,
    so a new element added to `ELEMENT_STYLE` is covered the day it lands.
    """
    if palette.panel is None:
        return
    for page in palette.page:
        surface = composite(palette.panel, page)
        for name, colour in sorted(palette.elements.items()):
            ratio = contrast_ratio(composite(colour, surface), surface)
            report.pairs.append(
                (
                    "src/lib/game/elements.ts",
                    f"{name} label on a panel",
                    ratio,
                    NORMAL_MIN,
                    "normal text (16px/700)",
                )
            )
            if ratio + 1e-9 < NORMAL_MIN:
                report.fail(
                    "src/lib/game/elements.ts",
                    1,
                    "element-contrast",
                    f"{name} {colour.hex()} on the panel surface {rgb_hex(surface)} is "
                    f"{ratio:.2f}:1, below {NORMAL_MIN:g}:1; an element's own label is "
                    "written in this colour",
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
        rel = str(path.relative_to(REPO))
        audit_file(rel, path.read_text(encoding="utf-8"), palette, report, root)

    check_element_chips(palette, report)
    check_focus_ring(palette, report)

    report.violations.sort()
    report.review.sort()
    report.pairs.sort()

    if args.pairs:
        width = min(max(len(where) for where, _, _, _, _ in report.pairs), 42)
        print(f"Colour pairs resolved ({len(report.pairs)})")
        print("-" * 78)
        for where, label, ratio, minimum, rule in report.pairs:
            verdict = "ok  " if ratio + 1e-9 >= minimum else "FAIL"
            print(f"  {verdict} {ratio:6.2f}:1  (>= {minimum:g})  {where.ljust(width)}  {label}  - {rule}")
        return 0

    print("Mathmon contrast audit")
    print("======================")
    print(f"palette: {len(palette.named)} named colours, {len(palette.elements)} elements")
    print(f"surfaces: {len(palette.page)} page background(s), 1 panel")
    print(f"files scanned: {len(targets)}")
    print(f"colour pairs resolved: {len(report.pairs)}")
    print(f"thresholds: {NORMAL_MIN:g}:1 normal text, {LARGE_MIN:g}:1 large text "
          f"(>={LARGE_PX:g}px, or >={LARGE_BOLD_PX:g}px bold), {NON_TEXT_MIN:g}:1 non-text")
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
        print(f"FAIL: {len(broken)} propert{'y' if len(broken) == 1 else 'ies'} violated: "
              f"{', '.join(broken)}")
        print("The player is seven and often outdoors. Text must clear 4.5:1 (3:1 when")
        print("large), and anything that carries meaning without words must clear 3:1.")
        return 1

    print("PASS: every colour pair this script can resolve clears its WCAG threshold.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
