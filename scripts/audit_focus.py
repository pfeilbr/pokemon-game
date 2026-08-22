#!/usr/bin/env python3
"""
Static audit of focus behaviour and keyboard reachability in the web client.

Why this exists
---------------
`scripts/audit_a11y.py` proves a tap target is big enough and that a button has
a name. `scripts/audit_contrast.py` proves a child can read what is on screen,
and it already measures the one focus ring against every surface it can be
drawn on. Neither of them asks the question this script asks: *can the control
be reached and pressed without a pointer at all, and can you see where you are
while you do it?*

That question stopped being hypothetical the day the battle screen grew
physical-keyboard support. The bug that came with it is the whole argument for
this file: a global `keydown` listener swallowed Enter, so a player who tabbed
onto the "7" key and pressed Enter submitted an empty answer instead of typing
a 7 - the keypad was unusable by keyboard alone. `Keypad.belongsToFocus` fixes
that one, and `e2e/keyboard.spec.ts` guards it. Everything *around* it - the
focus ring, the tab order, whether a `<div onClick>` can be reached at all, and
where focus goes when a screen replaces itself - was still unguarded.

What it checks
--------------
  focus-ring          `globals.css` still defines a `:focus-visible` rule whose
                      outline is real: a named colour (not `none`, not
                      `transparent`) at least MIN_RING_PX thick. The whole
                      client leans on this one rule - no component draws its
                      own - so it is the single point of failure for every
                      keyboard user, exactly as the reduced-motion block is for
                      `audit_a11y.py`.
  focus-ring-removed  nothing suppresses that ring without putting something
                      visible back: a CSS rule setting `outline: none`, or a
                      className carrying `outline-none`/`outline-hidden` with
                      no `focus:`/`focus-visible:` ring, outline, border or
                      shadow beside it. An invisible focus ring is not a style
                      choice; it is a player who cannot tell where they are.
  tab-order           no positive `tabIndex`. A `tabIndex={5}` does not move one
                      control - it lifts it out of document order into a
                      private sequence ahead of everything else, so the rest of
                      the page is then visited in an order nobody chose.
  unreachable-control a natively interactive element (`button`, `a[href]`,
                      `input`, `select`, `textarea`, `[role=button]`) does not
                      carry `tabIndex={-1}`, which removes it from the tab order
                      while leaving it perfectly clickable - the failure is
                      invisible to everyone testing with a mouse.
  keyboard-operable   no click handler on a non-interactive element (`div`,
                      `span`, `li`, …) without both a keyboard equivalent
                      (`onKeyDown`/`onKeyUp`) and a role. A `<div onClick>` is
                      not reachable by Tab and does not respond to Enter: it is
                      a control that simply does not exist for a keyboard.
  dismiss-without-escape
                      a presentational overlay that closes on a click - the
                      tap-outside-to-dismiss idiom, marked `role="presentation"`
                      - is only a mouse affordance. Unless its own file handles
                      `Escape`, the dialog it covers cannot be closed from the
                      keyboard at all. This is exactly the shape the album's
                      creature dialog had.
  nested-interactive  no interactive element inside another one (`<Link>` around
                      a `<Button>`). It is invalid HTML, it spends two tab stops
                      on one control, and the stop that looks like the button is
                      not the one that navigates.
  hidden-control      nothing interactive is buried inside an `aria-hidden`
                      subtree, which hides it from assistive technology while
                      leaving it in the tab order - focus lands on something a
                      screen reader will not name.

Where the facts come from
-------------------------
The JSX scanner is imported from `audit_a11y.py` rather than copied, exactly as
`audit_i18n.py` and `audit_contrast.py` do it. It is the same problem - "where
does this tag end, and what are its direct children" - and a second copy would
drift from the one those checks are already graded by.

The ring itself is read out of `src/app/globals.css`, never restated here, for
the reason `audit_a11y.py` reads its tap threshold out of the same file: a
script that duplicated the number would go green while the real value drifted.
`MIN_RING_PX` is the floor the parsed value is *checked against*, not a copy of
it.

Which components count as interactive is derived from the source too. A
`<Button>` is interactive because `src/components/ui.tsx` returns a `<button>`
from it; the script finds that by reading the component, so a new wrapper is
picked up without anyone remembering to list it here.

What static analysis can and cannot prove
-----------------------------------------
Same discipline as `audit_a11y.py`. A literal `tabIndex={5}`, a bare
`<div onClick>`, an `outline-none` with nothing beside it - each is provable
from the file and fails the build. What happens to focus *when the page
changes* is not: a new question replacing the keypad, or the result screen
replacing the whole battle, moves focus at runtime and nothing in the text of
the file says where it lands. That belongs to `e2e/focus.spec.ts`, which drives
a real browser and asserts focus never falls back to `<body>` mid-fight.
Guessing here would produce false alarms, and an audit people learn to ignore
enforces nothing.

Usage
-----
    python3 scripts/audit_focus.py             # verify
    python3 scripts/audit_focus.py --unchecked # list what this does not check

Exit status
-----------
0  every property holds.
1  at least one property is violated; each finding names the property it broke.
2  the audit itself could not run (a missing or restructured source file). A
   failure to measure is never a pass.

Determinism
-----------
Standard library only. No clock, no randomness, no network, no subprocess.
Findings are sorted, so two runs on the same tree print byte-identical output.
"""

from __future__ import annotations

import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from audit_a11y import (
        Report,
        attr_raw,
        attr_value,
        class_info,
        css_px,
        has_attr,
        iter_elements,
        resolve_consts,
        source_files,
    )
except ImportError as error:  # pragma: no cover - the message is the point
    print(f"audit_focus: cannot import the JSX scanner from audit_a11y.py: {error}", file=sys.stderr)
    raise SystemExit(2) from error

try:
    # Comments have to be invisible here for the reason `audit_contrast.py`
    # imports the same function: the very first run of this script failed the
    # build on the sentence in `ui.tsx` explaining *why* a link must not wrap a
    # button, because that sentence quotes the markup it is warning against.
    # CLAUDE.md asks that comments recording a caught bug are kept, so a
    # checker that fails on one would be asking for the history to be deleted.
    from audit_i18n import blank_comments
except ImportError as error:  # pragma: no cover - only when a file is missing
    print(f"audit_focus: cannot import blank_comments from audit_i18n.py: {error}", file=sys.stderr)
    raise SystemExit(2) from error


# WCAG 2.4.11 asks for a focus indicator at least as thick as a 2px perimeter.
# The real value is parsed out of `globals.css`; this is only the floor it is
# judged against, so a ring quietly thinned to 1px fails rather than certifies.
MIN_RING_PX = 2.0

# Elements the browser puts in the tab order and activates on Enter/Space by
# itself. Everything else needs a role, a tabindex and a key handler to become
# a control, which is what `keyboard-operable` is about.
NATIVE_INTERACTIVE = ("button", "a", "input", "select", "textarea", "Link")

# Ordinary containers. A click handler on one of these is the classic
# unreachable control.
NON_INTERACTIVE_TAGS = (
    "div",
    "span",
    "section",
    "article",
    "header",
    "footer",
    "main",
    "aside",
    "nav",
    "ul",
    "ol",
    "li",
    "p",
    "img",
    "svg",
    "table",
    "tr",
    "td",
    "th",
)

CLICK_ATTRS = ("onClick", "onMouseDown", "onMouseUp")
KEY_ATTRS = ("onKeyDown", "onKeyUp", "onKeyPress")

# A handler that only stops an event travelling further is not a control. The
# album dialog's panel uses exactly this to keep a click off the backdrop.
GUARD_ONLY = re.compile(r"^\(?\s*\w*\s*\)?\s*=>\s*\w+\.(?:stopPropagation|preventDefault)\(\)\s*$")

# `outline-none` and `outline-hidden` both remove the visible ring in Tailwind
# v4 (`outline-hidden` keeps a transparent one for forced-colours mode, which
# is not a ring anybody can see on this palette).
OUTLINE_OFF = re.compile(r"(?:^|:)outline-(?:none|hidden)$")

# What counts as putting something back: a focus-variant ring, outline, border
# or shadow. A colour change to text or background alone is not an indicator.
REPLACEMENT = re.compile(r"^(?:focus|focus-visible|focus-within):(?:ring|outline|border|shadow)")


def tab_index_value(attrs: str) -> tuple[int | None, str | None]:
    """The literal `tabIndex`, as (number, raw). Non-literals return (None, raw)."""
    raw, kind = attr_raw(attrs, "tabIndex")
    if raw is None:
        return None, None
    text = raw.strip().strip("'\"") if kind == "string" else raw.strip()
    try:
        return int(text), text
    except ValueError:
        return None, text


def role_of(attrs: str) -> str | None:
    role = attr_value(attrs, "role")
    return role.strip().strip("'\"") if role else None


def aria_hidden(attrs: str) -> bool:
    """
    True for `aria-hidden`, `aria-hidden="true"` and `aria-hidden={x}`.

    The bare form is the one that matters and the one that was missed first
    time: every decorative icon in this app is written `<span aria-hidden>`,
    with no value at all, so a checker that only reads `name=` sees nothing.
    """
    if not has_attr(attrs, "aria-hidden"):
        return False
    raw, kind = attr_raw(attrs, "aria-hidden")
    if raw is None:
        return True  # bare `aria-hidden`, which is `aria-hidden="true"`
    text = raw.strip().strip("'\"")
    return text != "false"


# --------------------------------------------------------------------------
# Which of this project's own components are interactive
# --------------------------------------------------------------------------


def interactive_components(files: list[tuple[str, str]]) -> set[str]:
    """
    Component names whose first rendered tag is natively interactive.

    Derived rather than listed, so a new `ButtonLink` is understood the moment
    it exists. `<Button>` is interactive because `ui.tsx` returns a `<button>`;
    nobody has to remember to add it here.
    """
    found: set[str] = set()
    for _rel, src in files:
        for match in re.finditer(r"\bexport\s+function\s+([A-Z][A-Za-z0-9_]*)\s*\(", src):
            body = src[match.end() : match.end() + 4000]
            ret = re.search(r"\breturn\s*\(?\s*<([A-Za-z][A-Za-z0-9_.]*)", body)
            if ret and ret.group(1) in NATIVE_INTERACTIVE:
                found.add(match.group(1))
    return found


# --------------------------------------------------------------------------
# (a) The stylesheet
# --------------------------------------------------------------------------


def audit_css(css: str, rel: str, report: Report) -> float | None:
    """Check the one focus ring the whole client relies on, and return its width."""
    rule = re.search(r":focus-visible\s*\{(.*?)\n\}", css, re.S)
    if not rule:
        report.fail(
            rel,
            1,
            "focus-ring",
            "no `:focus-visible` rule; the whole web client relies on this one block "
            "for every keyboard user",
        )
        return None

    line = css.count("\n", 0, rule.start()) + 1
    body = rule.group(1)
    outline = re.search(r"(?:^|;)\s*outline\s*:([^;]*);", body)
    if not outline:
        report.fail(rel, line, "focus-ring", "the `:focus-visible` rule declares no outline")
        return None

    value = outline.group(1).strip()
    if re.search(r"\b(?:none|transparent)\b", value) or value in ("0", "0px"):
        report.fail(
            rel,
            line,
            "focus-ring",
            f"the `:focus-visible` outline is `{value}`, which draws nothing",
        )
        return None

    width_match = re.search(r"(?<![\w.-])([0-9]*\.?[0-9]+(?:px|rem|em)?)(?![\w%])", value)
    width = css_px(width_match.group(1)) if width_match else None
    if width is None:
        report.fail(rel, line, "focus-ring", f"the `:focus-visible` outline `{value}` names no width")
        return None
    if width < MIN_RING_PX:
        report.fail(
            rel,
            line,
            "focus-ring",
            f"the `:focus-visible` outline is only {width:g}px; WCAG 2.4.11 wants at least "
            f"{MIN_RING_PX:g}px of visible indicator",
        )
    return width


def audit_css_suppression(css: str, rel: str, report: Report) -> None:
    """No rule may turn the ring off without drawing something else."""
    for match in re.finditer(r"([^{}]+)\{([^{}]*)\}", css):
        selector, body = match.group(1).strip(), match.group(2)
        # The line of the selector itself, not of the blank where the comment
        # above it used to be - a finding has to point at the rule it names.
        lead = len(match.group(1)) - len(match.group(1).lstrip())
        selector_line = css.count("\n", 0, match.start() + lead) + 1
        if not re.search(r"(?:^|;)\s*outline\s*:\s*(?:none|0)\s*(?:;|$)", body) and not re.search(
            r"(?:^|;)\s*outline-style\s*:\s*none\s*(?:;|$)", body
        ):
            continue
        if re.search(r"box-shadow\s*:|border\s*:|background\s*:", body):
            continue
        report.fail(
            rel,
            selector_line,
            "focus-ring-removed",
            f"`{' '.join(selector.split())}` sets `outline: none` and draws no replacement",
        )


# --------------------------------------------------------------------------
# (b) The JSX
# --------------------------------------------------------------------------


def audit_file(rel: str, src: str, components: set[str], report: Report) -> None:
    consts = resolve_consts(src)
    interactive_tags = tuple(NATIVE_INTERACTIVE) + tuple(sorted(components))
    handles_escape = bool(re.search(r"===\s*'Escape'|===\s*\"Escape\"", src))

    scan = sorted(set(interactive_tags + NON_INTERACTIVE_TAGS + ("label", "Panel")))
    for el in iter_elements(src, scan):
        role = role_of(el.attrs)
        native = el.tag in interactive_tags
        is_control = native or role == "button" or role == "link"

        index, raw_index = tab_index_value(el.attrs)
        if index is not None and index > 0:
            report.fail(
                rel,
                el.line,
                "tab-order",
                f"<{el.tag}> has tabIndex={{{index}}}; a positive tabindex jumps ahead of "
                "document order and re-sequences the whole page behind it",
            )
        elif index is None and raw_index is not None:
            report.note(
                rel,
                el.line,
                "tab-order",
                f"<{el.tag}> computes its tabIndex ({raw_index}); this script cannot read the value",
            )

        if index is not None and index < 0 and is_control:
            report.fail(
                rel,
                el.line,
                "unreachable-control",
                f"<{el.tag}> carries tabIndex={{{index}}}, so it is clickable but cannot be "
                "reached by Tab at all",
            )

        # `class_info` is `audit_a11y`'s own reader, so a class list assembled
        # from a local `const keyClass = '...'` - which is how the whole keypad
        # is styled - is resolved here exactly as it is there. Reading only the
        # literals in the attribute would have let an `outline-none` hide in
        # that const, which is the first thing this check was tried against.
        tokens, _dynamic, _present = class_info(el.attrs, consts)
        if any(OUTLINE_OFF.search(t) for t in tokens) and not any(
            REPLACEMENT.match(t) for t in tokens
        ):
            off = sorted({t for t in tokens if OUTLINE_OFF.search(t)})
            report.fail(
                rel,
                el.line,
                "focus-ring-removed",
                f"<{el.tag}> has `{' '.join(off)}` and no focus-variant ring, outline, border or "
                "shadow to replace the global `:focus-visible` outline it suppresses",
            )

        clicks = [a for a in CLICK_ATTRS if has_attr(el.attrs, a)]
        if clicks and el.tag in NON_INTERACTIVE_TAGS and not is_control:
            raw, _ = attr_raw(el.attrs, clicks[0])
            if raw is not None and GUARD_ONLY.match(raw.strip()):
                report.note(
                    rel,
                    el.line,
                    "keyboard-operable",
                    f"<{el.tag}> {clicks[0]} only stops the event travelling further; it is a "
                    "propagation guard, not a control",
                )
            elif role in ("presentation", "none"):
                if not handles_escape:
                    report.fail(
                        rel,
                        el.line,
                        "dismiss-without-escape",
                        f"<{el.tag} role=\"{role}\"> closes on a click, but nothing in this file "
                        "handles Escape, so there is no way out from the keyboard",
                    )
            elif not any(has_attr(el.attrs, a) for a in KEY_ATTRS):
                report.fail(
                    rel,
                    el.line,
                    "keyboard-operable",
                    f"<{el.tag}> has {clicks[0]} but no keyboard equivalent and no role; Tab "
                    "cannot reach it and Enter cannot press it",
                )
            elif role is None:
                report.fail(
                    rel,
                    el.line,
                    "keyboard-operable",
                    f"<{el.tag}> handles clicks and keys but declares no role, so it is not "
                    "announced as a control",
                )

        if native and el.inner:
            for inner in iter_elements(el.inner, interactive_tags):
                if el.tag in ("a", "Link") and inner.tag in ("input", "select", "textarea"):
                    continue
                report.fail(
                    rel,
                    el.line,
                    "nested-interactive",
                    f"<{el.tag}> contains <{inner.tag}>: two tab stops for one control, and the "
                    "one that looks like the button is not the one that acts",
                )

        if aria_hidden(el.attrs) and el.inner:
            buried = iter_elements(el.inner, interactive_tags)
            focusable = [b for b in buried if tab_index_value(b.attrs)[0] != -1]
            if focusable:
                report.fail(
                    rel,
                    el.line,
                    "hidden-control",
                    f"<{el.tag} aria-hidden> buries <{focusable[0].tag}>, which stays in the tab "
                    "order while being hidden from assistive technology",
                )


UNCHECKED = """\
Not machine-checked by this script
----------------------------------
  * Where focus goes when the page changes under it - a new question, the
    result screen replacing the battle, a dialog opening or closing. Nothing in
    the text of a file says where focus lands, so `e2e/focus.spec.ts` drives a
    real browser and asserts it never falls back to `<body>`.
  * Whether the focus ring is actually visible against the surface it lands on.
    That is arithmetic on two colours and belongs to `audit_contrast.py`, which
    already measures this ring against every surface in the app.
  * Whether the visual order of a screen matches its DOM order. CSS can reorder
    a grid; only a browser knows where a box ended up.
  * Whether a focus trap holds. A dialog's Tab cycle is behaviour, not text.
  * A `tabIndex` computed at runtime, or a className assembled from values this
    script cannot read. Both are reported under NEEDS REVIEW instead.
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit focus behaviour and keyboard reachability.")
    parser.add_argument("--repo", default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    parser.add_argument("--unchecked", action="store_true", help="list what this does not check")
    args = parser.parse_args()

    if args.unchecked:
        print(UNCHECKED, end="")
        return 0

    repo = os.path.abspath(args.repo)
    css_path = os.path.join(repo, "src", "app", "globals.css")
    src_root = os.path.join(repo, "src")
    if not os.path.exists(css_path) or not os.path.isdir(src_root):
        print("audit_focus: missing src/app/globals.css or src/", file=sys.stderr)
        return 2

    with open(css_path, encoding="utf-8") as fh:
        # `/* ... */` blocks are blanked to spaces for the same reason the JSX
        # comments are, and to keep every reported line number honest: the
        # comment above the `:focus-visible` rule describes `outline: none`.
        css = re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), fh.read(), flags=re.S)

    report = Report()
    ring = audit_css(css, "src/app/globals.css", report)
    audit_css_suppression(css, "src/app/globals.css", report)

    files: list[tuple[str, str]] = []
    for path in source_files(src_root, (".tsx",)):
        with open(path, encoding="utf-8") as fh:
            files.append((os.path.relpath(path, repo), blank_comments(fh.read())))

    components = interactive_components(files)
    for rel, src in files:
        report.scanned += 1
        audit_file(rel, src, components, report)

    report.violations.sort()
    report.review.sort()

    ring_text = f"{ring:g}px ring" if ring is not None else "no readable ring"
    print(f"focus audit - {report.scanned} file(s), {ring_text}, "
          f"interactive components: {', '.join(sorted(components)) or 'none found'}")
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
        print("FAIL: every control must be reachable by Tab, pressable by Enter, and visible "
              "while focused.")
        return 1

    print("PASS: no provable violations.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
