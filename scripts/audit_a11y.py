#!/usr/bin/env python3
"""
Static accessibility audit for tap targets, accessible names and reduced motion.

Why this exists
---------------
`CLAUDE.md` states the rule plainly: "Every tap target is at least 56px (`tap`
utility). Reduced motion is honoured globally in `globals.css`." The player is
seven; his aim is worse than an adult's, so a 32px "back" link is a button he
misses. Until this script existed nothing enforced the rule, and a `py-2`
button or a `Pressable` with no `minHeight` slipped through silently.

What it checks
--------------
  (a) WEB    interactive elements in `src/` carry `tap` or an explicit
             min-height >= the threshold.
  (b) IOS    `Pressable`/`Touchable*` in `mobile/src/` resolve to a style with
             `minHeight`/`height` >= `TAP`.
  (c) BOTH   every button has an accessible name.
  (d) IOS    any file that animates consults `AccessibilityInfo` for Reduce
             Motion. The web gets this free from a global CSS rule, so the
             script verifies that rule is still in `globals.css` instead.

Thresholds are *read from the source*, never hardcoded: the web threshold comes
from the `@utility tap` block in `src/app/globals.css` and the iOS one from
`TAP` in `mobile/src/theme.ts`. A script that duplicated the number would go
green while the real value drifted.

What static analysis can and cannot prove
-----------------------------------------
It can prove a violation when every input is a literal in the file: a static
class string, a single-row layout, and children whose rendered height is
knowable (text with a known Tailwind size, or `<Text>` with a numeric
`fontSize`). Those go in VIOLATIONS and fail the build.

It cannot prove anything about a class assembled at runtime, a card whose
height comes from a `<CreatureArt size={104} />`, a column layout whose height
is the sum of things it cannot measure, or a style handed down by a parent.
Those go in NEEDS REVIEW, which is printed but never fails the build. Guessing
there would produce false alarms, and an audit people learn to ignore enforces
nothing.

Usage:  python3 scripts/audit_a11y.py [--repo PATH]
Exit:   0 = no violations, 1 = violations found, 2 = the audit itself broke.

Standard library only. Deterministic: output is sorted and depends on nothing
but the file contents.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass, field
from typing import Iterable

# The convention from CLAUDE.md. The script does not measure against this
# directly - it measures against the values parsed out of the source - but it
# refuses to run if the source has drifted below it, because then the parsed
# threshold would happily certify a 40px button.
REQUIRED_MIN_PX = 56

QUOTES = ("'", '"', "`")

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
        return f"  {self.path}:{self.line}  [{self.check}] {self.detail}"


@dataclass
class Report:
    violations: list[Finding] = field(default_factory=list)
    review: list[Finding] = field(default_factory=list)
    scanned: int = 0

    def fail(self, path: str, line: int, check: str, detail: str) -> None:
        self.violations.append(Finding(path, line, check, detail))

    def note(self, path: str, line: int, check: str, detail: str) -> None:
        self.review.append(Finding(path, line, check, detail))


# --------------------------------------------------------------------------
# A very small JSX scanner
#
# Regex alone cannot find where an opening tag ends: `className={cond ? "a>" :
# "b"}` contains a `>` that is not the end of anything. So the scanner walks
# characters with a stack of string/brace contexts, which is enough structure
# for the questions asked here without pulling in a parser.
# --------------------------------------------------------------------------

IDENT = re.compile(r"[A-Za-z][A-Za-z0-9_.]*")


def find_tag_end(src: str, start: int) -> tuple[int, bool]:
    """Given the index of `<`, return (index just past `>`, self_closing)."""
    stack: list[str] = []
    i = start
    n = len(src)
    while i < n:
        c = src[i]
        if stack and stack[-1] in QUOTES:
            quote = stack[-1]
            if c == "\\":
                i += 2
                continue
            if c == quote:
                stack.pop()
            elif quote == "`" and c == "$" and i + 1 < n and src[i + 1] == "{":
                stack.append("{")
                i += 2
                continue
        else:
            if c in QUOTES:
                stack.append(c)
            elif c == "{":
                stack.append("{")
            elif c == "}":
                if stack and stack[-1] == "{":
                    stack.pop()
            elif c == ">" and not stack:
                self_closing = src[i - 1] == "/"
                return i + 1, self_closing
        i += 1
    raise ValueError(f"unterminated tag starting at offset {start}")


def find_close(src: str, tag: str, after_open: int) -> int:
    """Return the index of `<` in the matching `</tag>`, handling nesting."""
    depth = 1
    i = after_open
    n = len(src)
    open_re = re.compile(r"<" + re.escape(tag) + r"(?![A-Za-z0-9_])")
    close_re = re.compile(r"</\s*" + re.escape(tag) + r"\s*>")
    while i < n:
        c = src[i]
        if c in QUOTES:
            # Skip a whole string so `"</button>"` inside a prop is ignored.
            quote = c
            i += 1
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == quote:
                    break
                i += 1
            i += 1
            continue
        if c == "<":
            m = close_re.match(src, i)
            if m:
                depth -= 1
                if depth == 0:
                    return i
                i = m.end()
                continue
            if open_re.match(src, i):
                _, self_closing = find_tag_end(src, i)
                if not self_closing:
                    depth += 1
        i += 1
    raise ValueError(f"unterminated <{tag}> after offset {after_open}")


def attr_raw(attrs: str, name: str) -> tuple[str | None, str]:
    """
    Extract a JSX attribute's value and how it was written.

    The distinction matters: `className="a b"` is a literal the script can judge
    completely, while `className={...}` may be assembled from values that only
    exist at runtime. Conflating the two is what made the first draft of this
    script call every static button "dynamic" and prove nothing.
    """
    pattern = re.compile(r"(?<![A-Za-z0-9_-])" + re.escape(name) + r"\s*=\s*")
    for m in pattern.finditer(attrs):
        i = m.end()
        if i >= len(attrs):
            return None, "none"
        c = attrs[i]
        if c in ('"', "'"):
            j = attrs.index(c, i + 1)
            return attrs[i + 1 : j], "string"
        if c == "{":
            depth = 0
            j = i
            while j < len(attrs):
                ch = attrs[j]
                if ch in QUOTES:
                    quote = ch
                    j += 1
                    while j < len(attrs):
                        if attrs[j] == "\\":
                            j += 2
                            continue
                        if attrs[j] == quote:
                            break
                        j += 1
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        return attrs[i + 1 : j], "expr"
                j += 1
        return None, "none"
    return None, "none"


def attr_value(attrs: str, name: str) -> str | None:
    return attr_raw(attrs, name)[0]


def has_attr(attrs: str, name: str) -> bool:
    return re.search(r"(?<![A-Za-z0-9_-])" + re.escape(name) + r"(\s|=|/|>|$)", attrs) is not None


@dataclass
class Child:
    kind: str  # 'text' | 'expr' | 'element'
    tag: str = ""
    attrs: str = ""
    inner: str = ""
    text: str = ""


def direct_children(inner: str) -> list[Child]:
    """Split an element's body into its immediate children."""
    out: list[Child] = []
    i = 0
    n = len(inner)
    buf = ""
    while i < n:
        c = inner[i]
        if c == "<" and i + 1 < n and (inner[i + 1].isalpha() or inner[i + 1] == ">"):
            if buf.strip():
                out.append(Child("text", text=buf.strip()))
            buf = ""
            m = IDENT.match(inner, i + 1)
            tag = m.group(0) if m else ""
            end, self_closing = find_tag_end(inner, i)
            attrs = inner[i + len(tag) + 1 : end - (2 if self_closing else 1)]
            if self_closing or not tag:
                out.append(Child("element", tag=tag, attrs=attrs))
                i = end
            else:
                close = find_close(inner, tag, end)
                out.append(Child("element", tag=tag, attrs=attrs, inner=inner[end:close]))
                i = inner.index(">", close) + 1
            continue
        if c == "{":
            if buf.strip():
                out.append(Child("text", text=buf.strip()))
            buf = ""
            depth = 0
            j = i
            while j < n:
                ch = inner[j]
                if ch in QUOTES:
                    quote = ch
                    j += 1
                    while j < n:
                        if inner[j] == "\\":
                            j += 2
                            continue
                        if inner[j] == quote:
                            break
                        j += 1
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            body = inner[i + 1 : j]
            # A JSX comment is not a child.
            if not body.strip().startswith("/*"):
                out.append(Child("expr", text=body.strip()))
            i = j + 1
            continue
        buf += c
        i += 1
    if buf.strip():
        out.append(Child("text", text=buf.strip()))
    return out


@dataclass
class Element:
    tag: str
    attrs: str
    inner: str
    line: int
    self_closing: bool


def iter_elements(src: str, tags: Iterable[str]) -> list[Element]:
    wanted = set(tags)
    found: list[Element] = []
    pattern = re.compile(r"<([A-Za-z][A-Za-z0-9_.]*)")
    for m in pattern.finditer(src):
        tag = m.group(1)
        if tag not in wanted:
            continue
        try:
            end, self_closing = find_tag_end(src, m.start())
            attrs = src[m.end() : end - (2 if self_closing else 1)]
            inner = "" if self_closing else src[end : find_close(src, tag, end)]
        except ValueError:
            continue
        found.append(Element(tag, attrs, inner, src.count("\n", 0, m.start()) + 1, self_closing))
    return found


# --------------------------------------------------------------------------
# Thresholds, read from the source rather than duplicated here
# --------------------------------------------------------------------------

CSS_LEN = re.compile(r"^([0-9]*\.?[0-9]+)(px|rem|em)?$")


def css_px(value: str) -> float | None:
    m = CSS_LEN.match(value.strip())
    if not m:
        return None
    size = float(m.group(1))
    unit = m.group(2) or "px"
    return size * 16 if unit in ("rem", "em") else size


def web_threshold(globals_css: str) -> float:
    m = re.search(r"@utility\s+tap\s*\{([^}]*)\}", globals_css)
    if not m:
        raise SystemExit("audit: no `@utility tap` block in src/app/globals.css")
    h = re.search(r"min-height\s*:\s*([^;]+);", m.group(1))
    if not h:
        raise SystemExit("audit: the `tap` utility declares no min-height")
    px = css_px(h.group(1))
    if px is None:
        raise SystemExit(f"audit: cannot read the tap min-height {h.group(1)!r}")
    return px


def ios_threshold(theme_ts: str) -> float:
    m = re.search(r"export\s+const\s+TAP\s*=\s*([0-9]+)", theme_ts)
    if not m:
        raise SystemExit("audit: no `export const TAP` in mobile/src/theme.ts")
    return float(m.group(1))


# --------------------------------------------------------------------------
# (a) Web tap targets
# --------------------------------------------------------------------------

# Tailwind's default type scale: class -> line-height in px. Height estimates
# use the line box, since that is what a single line of text actually occupies.
TEXT_LINE_HEIGHT = {
    "xs": 16,
    "sm": 20,
    "base": 24,
    "lg": 28,
    "xl": 28,
    "2xl": 32,
    "3xl": 36,
    "4xl": 40,
    "5xl": 48,
    "6xl": 60,
    "7xl": 72,
    "8xl": 96,
    "9xl": 128,
}

SPACING_STEP = 4  # Tailwind spacing unit, in px.

STRING_LITERAL = re.compile(r"'([^'\\]*(?:\\.[^'\\]*)*)'|\"([^\"\\]*(?:\\.[^\"\\]*)*)\"")

# A `<a>`/`<Link>` is audited as a button only when it is styled like one - a
# padded, filled or bordered block. A bare underlined word inside a sentence is
# a link, and demanding 56px of it would be wrong.
BUTTONISH = ("bg-", "rounded", "ring-", "shadow", "border", "panel", "px-", "py-", "p-")


CONST_STRING = re.compile(
    r"\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*"
    r"((?:'[^'\n]*'|\"[^\"\n]*\")(?:\s*\+\s*(?:'[^'\n]*'|\"[^\"\n]*\"))*)\s*;"
)


def resolve_consts(src: str) -> dict[str, str]:
    """
    Local `const keyClass = '…' + '…';` bindings, flattened to their text.

    Without this the shared class string in `Keypad.tsx` reads as opaque and
    five perfectly compliant buttons land in NEEDS REVIEW - noise that trains
    the reader to skim the section that matters.
    """
    out: dict[str, str] = {}
    for name, expr in CONST_STRING.findall(src):
        parts = [m.group(1) if m.group(1) is not None else m.group(2) for m in STRING_LITERAL.finditer(expr)]
        out[name] = " ".join(p.strip() for p in parts)
    return out


def class_tokens(raw: str | None, kind: str, consts: dict[str, str] | None = None) -> tuple[list[str], bool]:
    """Return (literal class tokens, dynamic) for a className attribute value."""
    if raw is None:
        return [], False
    if kind == "string":
        return [t for t in raw.split() if t], False
    for name, text in sorted((consts or {}).items()):
        raw = re.sub(r"\$\{\s*" + re.escape(name) + r"\s*\}", text, raw)
        raw = re.sub(r"(?<![\w$.])" + re.escape(name) + r"(?![\w$])", "'" + text + "'", raw)
    literals = [m.group(1) if m.group(1) is not None else m.group(2) for m in STRING_LITERAL.finditer(raw)]
    # Template chunks between backticks are literal too: `panel p-4 ${x}`.
    for m in re.finditer(r"`([^`]*)`", raw):
        literals.extend(re.split(r"\$\{[^}]*\}", m.group(1)))
    stripped = re.sub(r"`[^`]*`", " ", STRING_LITERAL.sub(" ", raw))
    # Anything identifier-shaped left over means part of the class list is
    # computed, so the absence of `tap` here proves nothing.
    dynamic = bool(re.search(r"[A-Za-z0-9_$]", stripped)) or "${" in raw
    tokens: list[str] = []
    for lit in literals:
        tokens.extend(t for t in lit.split() if t)
    return tokens, dynamic


def class_info(attrs: str, consts: dict[str, str] | None = None) -> tuple[list[str], bool, bool]:
    """(tokens, dynamic, present) for an element's className."""
    raw, kind = attr_raw(attrs, "className")
    if raw is None:
        return [], False, False
    tokens, dynamic = class_tokens(raw, kind, consts)
    return tokens, dynamic, True


def base_tokens(tokens: list[str]) -> list[str]:
    """Drop variant-prefixed classes (`sm:`, `hover:`) - they are conditional."""
    return [t for t in tokens if ":" not in t]


def explicit_height_px(tokens: list[str]) -> float | None:
    best: float | None = None
    for t in base_tokens(tokens):
        m = re.fullmatch(r"(?:min-)?h-\[([^\]]+)\]", t)
        if m:
            px = css_px(m.group(1))
        else:
            m = re.fullmatch(r"(?:min-)?h-([0-9]+(?:\.[0-9]+)?)", t)
            px = float(m.group(1)) * SPACING_STEP if m else None
        if px is not None:
            best = px if best is None else max(best, px)
    return best


def vertical_padding_px(tokens: list[str]) -> float:
    top = bottom = 0.0
    for t in base_tokens(tokens):
        m = re.fullmatch(r"(p|py|pt|pb)-([0-9]+(?:\.[0-9]+)?)", t)
        if not m:
            continue
        px = float(m.group(2)) * SPACING_STEP
        if m.group(1) in ("p", "py"):
            top = max(top, px)
            bottom = max(bottom, px)
        elif m.group(1) == "pt":
            top = max(top, px)
        else:
            bottom = max(bottom, px)
    return top + bottom


def text_line_height(tokens: list[str]) -> tuple[float | None, bool]:
    """(line height in px, arbitrary) for the first known text-size class."""
    for t in base_tokens(tokens):
        if t.startswith("text-["):
            return None, True
        m = re.fullmatch(r"text-([a-z0-9]+)", t)
        if m and m.group(1) in TEXT_LINE_HEIGHT:
            return float(TEXT_LINE_HEIGHT[m.group(1)]), False
    return None, False


def inline_min_height(style_attr: str | None) -> float | None:
    if not style_attr:
        return None
    best: float | None = None
    for m in re.finditer(r"\b(minHeight|height)\s*:\s*([^,}\n]+)", style_attr):
        raw = m.group(2).strip().strip("'\"")
        px = css_px(raw)
        if px is not None:
            best = px if best is None else max(best, px)
    return best


def is_interactive_web(el: Element, consts: dict[str, str]) -> bool:
    if el.tag == "button":
        return True
    role = attr_value(el.attrs, "role")
    if role and role.strip().strip("'\"") == "button":
        return True
    if el.tag in ("a", "Link"):
        tokens, _, _ = class_info(el.attrs, consts)
        return any(any(t.startswith(p) or t == p.rstrip("-") for p in BUTTONISH) for t in base_tokens(tokens))
    return False


def simple_child_line_heights(
    children: list[Child], own: float | None, consts: dict[str, str]
) -> tuple[list[float], str | None]:
    """
    Line heights of children, or (…, reason) when the height is not knowable.

    "Knowable" means the children are text: a literal, a `{expr}` rendering one
    line at the parent's size, or a `<span>` whose own children are text. A
    `<CreatureArt size={104} />` or a nested `<div>` is not, and saying so is
    the honest answer.
    """
    heights: list[float] = []
    default = own if own is not None else float(TEXT_LINE_HEIGHT["base"])
    for child in children:
        if child.kind in ("text", "expr"):
            heights.append(default)
            continue
        if child.tag != "span":
            return [], f"child <{child.tag or '?'}> has a height this script cannot compute"
        tokens, _, _ = class_info(child.attrs, consts)
        lh, arbitrary = text_line_height(tokens)
        if arbitrary:
            return [], "child uses an arbitrary text size with no known line-height"
        if any(c.kind == "element" for c in direct_children(child.inner)):
            return [], "child <span> wraps further elements"
        heights.append(lh if lh is not None else default)
    return heights, None


def audit_web_file(path: str, rel: str, report: Report, threshold: float) -> None:
    with open(path, encoding="utf-8") as fh:
        src = fh.read()

    consts = resolve_consts(src)

    for el in iter_elements(src, ("button", "a", "Link", "div", "span", "Pressable")):
        interactive = is_interactive_web(el, consts)
        if not interactive:
            # Report unstyled links once so the reader knows they were seen and
            # deliberately not judged, rather than silently skipped.
            if el.tag in ("a", "Link"):
                report.note(
                    rel,
                    el.line,
                    "tap-target",
                    f"<{el.tag}> has no button-like styling; audited as an inline text link, not a tap target",
                )
            continue

        tokens, dynamic, has_class = class_info(el.attrs, consts)
        base = base_tokens(tokens)
        label = f"<{el.tag}>"
        testid = attr_value(el.attrs, "data-testid")
        if testid:
            label += f' data-testid="{testid}"'

        if "tap" in base:
            continue
        explicit = explicit_height_px(tokens)
        inline = inline_min_height(attr_value(el.attrs, "style"))
        best = max([v for v in (explicit, inline) if v is not None], default=None)
        if best is not None and best >= threshold:
            continue
        if best is not None:
            report.fail(
                rel,
                el.line,
                "tap-target",
                f"{label} sets an explicit height of {best:g}px, below the {threshold:g}px minimum",
            )
            continue

        if not has_class:
            report.note(rel, el.line, "tap-target", f"{label} has no className; height comes from elsewhere")
            continue
        if dynamic:
            report.note(
                rel,
                el.line,
                "tap-target",
                f"{label} builds its className at runtime; `tap` may be applied by a value this script cannot read",
            )
            continue
        if any(t in base for t in ("flex-col", "grid")) or "flex-col" in tokens:
            report.note(
                rel,
                el.line,
                "tap-target",
                f"{label} stacks its children (flex-col/grid); the height is the sum of parts this script cannot measure",
            )
            continue

        own_lh, arbitrary = text_line_height(tokens)
        if arbitrary:
            report.note(rel, el.line, "tap-target", f"{label} uses an arbitrary text size with no known line-height")
            continue
        heights, reason = simple_child_line_heights(direct_children(el.inner), own_lh, consts)
        if reason:
            report.note(rel, el.line, "tap-target", f"{label} {reason}")
            continue
        pad = vertical_padding_px(tokens)
        content = max(heights) if heights else (own_lh or float(TEXT_LINE_HEIGHT["base"]))
        est = pad + content
        if est < threshold:
            report.fail(
                rel,
                el.line,
                "tap-target",
                f"{label} is about {est:g}px tall ({pad:g}px padding + {content:g}px line) "
                f"vs the {threshold:g}px minimum; add the `tap` utility",
            )

    audit_web_names(src, rel, report)


def audit_web_names(src: str, rel: str, report: Report) -> None:
    for el in iter_elements(src, ("button",)):
        if any(has_attr(el.attrs, a) for a in ("aria-label", "aria-labelledby", "title")):
            continue
        if el.self_closing:
            report.fail(rel, el.line, "accessible-name", "<button> renders nothing and has no aria-label")
            continue
        children = direct_children(el.inner)
        if not children:
            report.fail(rel, el.line, "accessible-name", "<button> has no children and no aria-label")
            continue
        visible = [
            c
            for c in children
            if not (c.kind == "element" and has_attr(c.attrs, "aria-hidden"))
        ]
        if not visible:
            report.fail(
                rel,
                el.line,
                "accessible-name",
                "<button> contains only aria-hidden content, so it has no accessible name",
            )


# --------------------------------------------------------------------------
# (b) iOS tap targets
# --------------------------------------------------------------------------

TOUCHABLES = ("Pressable", "TouchableOpacity", "TouchableHighlight", "TouchableWithoutFeedback")
ARITHMETIC = re.compile(r"^[0-9+\-*/(). ]+$")


def parse_stylesheets(src: str, tap: float) -> dict[str, dict[str, str]]:
    """Map style name -> {property: raw value} for every StyleSheet.create call."""
    sheets: dict[str, dict[str, str]] = {}
    for m in re.finditer(r"StyleSheet\.create\(\s*\{", src):
        start = m.end() - 1
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
        body = src[start + 1 : i]
        for name, props in iter_entries(body):
            sheets[name] = parse_props(props, tap)
    return sheets


def iter_entries(body: str) -> list[tuple[str, str]]:
    """Yield (key, object-literal body) for `key: { ... }` at the top level."""
    out: list[tuple[str, str]] = []
    i = 0
    while i < len(body):
        m = re.compile(r"([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*\{").search(body, i)
        if not m:
            break
        depth = 0
        j = m.end() - 1
        while j < len(body):
            if body[j] == "{":
                depth += 1
            elif body[j] == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        # Only top-level keys: skip if the match sat inside a previous object.
        out.append((m.group(1), body[m.end() : j]))
        i = j + 1
    return out


def parse_props(body: str, tap: float) -> dict[str, str]:
    props: dict[str, str] = {}
    depth = 0
    current = ""
    for ch in body:
        if ch in "{[(":
            depth += 1
        elif ch in "}])":
            depth -= 1
        if ch == "," and depth == 0:
            record_prop(current, props)
            current = ""
        else:
            current += ch
    record_prop(current, props)
    return props


def record_prop(chunk: str, props: dict[str, str]) -> None:
    if ":" not in chunk:
        return
    key, _, value = chunk.partition(":")
    key = key.strip().strip("'\"")
    if re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", key):
        props[key] = value.strip()


def numeric(value: str, tap: float, space: dict[str, float]) -> float | None:
    """Evaluate a style value like `TAP`, `TAP + 20`, `12`, `space.lg`."""
    expr = value.strip().rstrip(",")
    expr = re.sub(r"\bTAP\b", str(tap), expr)
    for name, px in space.items():
        expr = re.sub(r"\bspace\." + re.escape(name) + r"\b", str(px), expr)
    if not ARITHMETIC.fullmatch(expr) or not expr.strip():
        return None
    try:
        return float(eval(expr, {"__builtins__": {}}, {}))  # noqa: S307 - digits and operators only
    except Exception:
        return None


def parse_space(theme_src: str) -> dict[str, float]:
    m = re.search(r"export\s+const\s+space\s*=\s*\{([^}]*)\}", theme_src)
    if not m:
        return {}
    out: dict[str, float] = {}
    for k, v in re.findall(r"([A-Za-z]+)\s*:\s*([0-9]+)", m.group(1)):
        out[k] = float(v)
    return out


def style_refs(style_attr: str | None) -> list[str]:
    if not style_attr:
        return []
    return re.findall(r"styles\.([A-Za-z0-9_$]+)", style_attr)


def resolved_height(
    style_attr: str | None, sheets: dict[str, dict[str, str]], tap: float, space: dict[str, float]
) -> tuple[float | None, bool]:
    """(best minHeight/height found, any referenced style was unresolvable)."""
    best: float | None = None
    unknown = False
    for name in style_refs(style_attr):
        props = sheets.get(name)
        if props is None:
            unknown = True
            continue
        for key in ("minHeight", "height"):
            if key in props:
                px = numeric(props[key], tap, space)
                if px is None:
                    unknown = True
                else:
                    best = px if best is None else max(best, px)
    if style_attr:
        for m in re.finditer(r"\b(minHeight|height)\s*:\s*([^,}\n]+)", style_attr):
            px = numeric(m.group(2), tap, space)
            if px is not None:
                best = px if best is None else max(best, px)
    return best, unknown


def audit_mobile_file(
    path: str,
    rel: str,
    report: Report,
    tap: float,
    space: dict[str, float],
    shared: dict[str, dict[str, str]],
) -> None:
    with open(path, encoding="utf-8") as fh:
        src = fh.read()

    sheets = dict(shared)
    sheets.update(parse_stylesheets(src, tap))

    for el in iter_elements(src, TOUCHABLES):
        style_attr = attr_value(el.attrs, "style")
        testid = attr_value(el.attrs, "testID")
        label = f"<{el.tag}>" + (f' testID="{testid}"' if testid else "")

        height, unknown = resolved_height(style_attr, sheets, tap, space)
        if height is not None and height >= tap:
            pass
        elif height is not None:
            report.fail(
                rel,
                el.line,
                "tap-target",
                f"{label} resolves to a height of {height:g}px, below TAP ({tap:g}px)",
            )
        elif style_attr is None:
            report.fail(rel, el.line, "tap-target", f"{label} has no style at all, so no minHeight")
        elif unknown:
            report.note(rel, el.line, "tap-target", f"{label} references a style this script cannot resolve")
        else:
            est, reason = estimate_mobile_height(el, sheets, tap, space)
            if reason:
                report.note(rel, el.line, "tap-target", f"{label} {reason}")
            elif est < tap:
                report.fail(
                    rel,
                    el.line,
                    "tap-target",
                    f"{label} has no minHeight and its text comes to about {est:g}px, below TAP ({tap:g}px)",
                )

        # (c) accessible names
        if has_attr(el.attrs, "accessibilityLabel") or has_attr(el.attrs, "aria-label"):
            continue
        children = direct_children(el.inner)
        if el.self_closing or not children:
            report.fail(rel, el.line, "accessible-name", f"{label} renders nothing and has no accessibilityLabel")
            continue
        if not any(child_has_text(c) for c in children):
            report.note(
                rel,
                el.line,
                "accessible-name",
                f"{label} has no direct <Text> child and no accessibilityLabel; check its name",
            )

    audit_mobile_motion(src, rel, report)


def child_has_text(child: Child) -> bool:
    if child.kind in ("text", "expr"):
        return True
    if child.tag == "Text":
        return True
    # A render callback (`style={({pressed}) => …}`) or nested view: look inside.
    return "<Text" in child.inner


def estimate_mobile_height(
    el: Element, sheets: dict[str, dict[str, str]], tap: float, space: dict[str, float]
) -> tuple[float, str | None]:
    """Height from padding plus `<Text>` children, when every part is literal."""
    padding = 0.0
    row = False
    for name in style_refs(attr_value(el.attrs, "style")):
        props = sheets.get(name, {})
        if props.get("flexDirection", "").strip().strip("'\"") == "row":
            row = True
        top = bottom = 0.0
        for key, target in (("padding", "both"), ("paddingVertical", "both"), ("paddingTop", "t"), ("paddingBottom", "b")):
            if key in props:
                px = numeric(props[key], tap, space)
                if px is None:
                    return 0.0, "has padding this script cannot evaluate"
                if target == "both":
                    top = max(top, px)
                    bottom = max(bottom, px)
                elif target == "t":
                    top = max(top, px)
                else:
                    bottom = max(bottom, px)
        padding = max(padding, top + bottom)

    children = direct_children(el.inner)
    lines: list[float] = []
    for child in children:
        if child.kind in ("text", "expr"):
            continue
        if child.tag != "Text":
            return 0.0, f"contains <{child.tag or '?'}>, whose height this script cannot compute"
        size = None
        for name in style_refs(attr_value(child.attrs, "style")):
            props = sheets.get(name, {})
            if "fontSize" in props:
                px = numeric(props["fontSize"], tap, space)
                if px is not None:
                    size = px if size is None else max(size, px)
        if size is None:
            return 0.0, "contains a <Text> whose fontSize this script cannot resolve"
        lines.append(size * 1.4)  # React Native's default line height factor.
    if not lines:
        return 0.0, "has no measurable content"
    content = max(lines) if row else sum(lines)
    return padding + content, None


ANIMATION = re.compile(
    r"Animated\.(timing|spring|decay|sequence|parallel|stagger|loop)\b"
    r"|LayoutAnimation\.\w+"
    r"|\bwith(Timing|Spring|Repeat|Decay)\b"
    r"|\buseAnimatedStyle\b"
)


def audit_mobile_motion(src: str, rel: str, report: Report) -> None:
    m = ANIMATION.search(src)
    if not m:
        return
    line = src.count("\n", 0, m.start()) + 1
    if "AccessibilityInfo" in src and "isReduceMotionEnabled" in src:
        return
    report.fail(
        rel,
        line,
        "reduced-motion",
        f"{m.group(0)} animates without consulting AccessibilityInfo.isReduceMotionEnabled(); "
        "iOS gets no equivalent of the global CSS rule",
    )


def audit_web_motion(css: str, rel: str, report: Report) -> None:
    block = re.search(r"@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{", css)
    if not block:
        report.fail(rel, 1, "reduced-motion", "no `@media (prefers-reduced-motion: reduce)` rule; "
                    "the whole web client relies on this one block")
        return
    tail = css[block.end() :]
    if "animation-duration" not in tail[:600] or "transition-duration" not in tail[:600]:
        report.fail(
            rel,
            css.count("\n", 0, block.start()) + 1,
            "reduced-motion",
            "the reduced-motion block no longer neutralises both animation-duration and transition-duration",
        )


# --------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------


def source_files(root: str, suffixes: tuple[str, ...]) -> list[str]:
    out: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in ("node_modules", ".next", "dist", "build"))
        for name in sorted(filenames):
            if name.endswith(suffixes) and ".test." not in name:
                out.append(os.path.join(dirpath, name))
    return sorted(out)


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit tap targets, accessible names and reduced motion.")
    parser.add_argument("--repo", default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    args = parser.parse_args()
    repo = os.path.abspath(args.repo)

    css_path = os.path.join(repo, "src", "app", "globals.css")
    theme_path = os.path.join(repo, "mobile", "src", "theme.ts")
    for required in (css_path, theme_path):
        if not os.path.exists(required):
            print(f"audit: missing {os.path.relpath(required, repo)}", file=sys.stderr)
            return 2

    with open(css_path, encoding="utf-8") as fh:
        css = fh.read()
    with open(theme_path, encoding="utf-8") as fh:
        theme = fh.read()

    web_min = web_threshold(css)
    tap = ios_threshold(theme)
    space = parse_space(theme)

    report = Report()

    # The thresholds are read from source, so verify the source still meets the
    # convention before trusting them to judge anything else.
    if web_min < REQUIRED_MIN_PX:
        report.fail(
            "src/app/globals.css",
            css.count("\n", 0, css.index("@utility tap")) + 1,
            "threshold",
            f"the `tap` utility is only {web_min:g}px; CLAUDE.md requires {REQUIRED_MIN_PX}px",
        )
        web_min = REQUIRED_MIN_PX
    if tap < REQUIRED_MIN_PX:
        report.fail(
            "mobile/src/theme.ts",
            theme.count("\n", 0, theme.index("export const TAP")) + 1,
            "threshold",
            f"TAP is only {tap:g}; CLAUDE.md requires {REQUIRED_MIN_PX}",
        )
        tap = REQUIRED_MIN_PX

    audit_web_motion(css, "src/app/globals.css", report)

    kit_path = os.path.join(repo, "mobile", "src", "ui", "kit.tsx")
    shared: dict[str, dict[str, str]] = {}
    if os.path.exists(kit_path):
        with open(kit_path, encoding="utf-8") as fh:
            shared = parse_stylesheets(fh.read(), tap)

    for path in source_files(os.path.join(repo, "src"), (".tsx",)):
        report.scanned += 1
        audit_web_file(path, os.path.relpath(path, repo), report, web_min)

    for path in source_files(os.path.join(repo, "mobile", "src"), (".tsx",)):
        report.scanned += 1
        audit_mobile_file(path, os.path.relpath(path, repo), report, tap, space, shared)

    report.violations.sort()
    report.review.sort()

    print(f"a11y audit - {report.scanned} file(s), web minimum {web_min:g}px, iOS TAP {tap:g}px")
    print()

    if report.review:
        print(f"NEEDS REVIEW ({len(report.review)}) - not provable either way, does not fail the build")
        for finding in report.review:
            print(finding.render())
        print()

    if report.violations:
        print(f"VIOLATIONS ({len(report.violations)})")
        for finding in report.violations:
            print(finding.render())
        print()
        print("FAIL: every tap target must be at least "
              f"{REQUIRED_MIN_PX}px (CLAUDE.md), and every button needs a name.")
        return 1

    print("PASS: no provable violations.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
