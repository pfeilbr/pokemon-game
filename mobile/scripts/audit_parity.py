#!/usr/bin/env python3
"""Check that the two clients are still playing the same game.

Why this exists
---------------
There is one engine, ``src/lib/game/``, and two clients that consume it: the
Next.js app under ``src/app`` and this one, reached through
``mobile/src/engine.ts``. ``CLAUDE.md`` states the rule plainly - *a rule change
belongs in ``src/lib/game/`` and lands on both clients at once; never fork a
rule into a client*.

The failure mode that rule guards against is silent. Nobody sets out to fork a
rule; someone reimplements a small one in a screen because threading it through
the engine was slower, and from then on the two clients disagree while both look
completely fine. The art port has already produced exactly this class of bug: a
primitive with no branch in one client's renderer draws nothing, and nothing
looks like art rather than like a bug.

So the things that must stay true across the seam are checked here rather than
remembered.

The properties
--------------
P1  No rule is reimplemented client-side. Everything the engine owns is
    imported through the seam, not recomputed in a screen.
P2  The art renderer handles every primitive the engine can emit, with every
    field of each one, derived from ``art.ts`` rather than from a list typed
    out here.
P3  Every screen and feature the web client offers, this client offers - or its
    absence is deliberately written down in the "Not yet here" paragraph of
    ``mobile/README.md``.
P4  Both languages on both clients: user-facing text on iOS routes through the
    shared ``STRINGS`` table instead of being an English literal in a screen.
P5  The platform-substitution table in ``mobile/README.md`` is honest - each of
    the substitutions it documents is really in the code, and no fourth,
    undocumented divergence has crept in.

Everything each property compares is read out of the real source on each run.
Nothing here restates a value the code already owns; a second copy of the Shape
union or of the screen list in this file would just move the drift somewhere new.

What this cannot catch is listed in ``LIMITATIONS`` and printed by
``--limitations``. An audit that silently checks only the easy half is the same
failure mode it is meant to prevent.

Usage
-----
    python3 mobile/scripts/audit_parity.py               # verify
    python3 mobile/scripts/audit_parity.py --json        # machine-readable
    python3 mobile/scripts/audit_parity.py --limitations # what this misses

Exit status
-----------
0  every property holds.
1  at least one property is violated; each violation is printed with the
   property it belongs to.
2  the audit itself could not run (a file it needs is missing, or a shape it
   parses is no longer there). A failure to check is never reported as a pass.

Which CI job
------------
Either, and that is deliberate. This script reads **source as plain text**: no
bundler, no ``node``, no ``mobile/node_modules``, nothing executed. It is
therefore safe in the root job as well as the iOS one, unlike
``mobile/scripts/album_cost.py``, which needs ``mobile/node_modules`` and would
fail in the root job where those are never installed. Two CI outages in this
repository came from root-level tooling reaching into ``mobile/``; the fix here
is to reach for nothing. It belongs in ``.github/workflows/ios.yml`` next to the
other iOS checks, but it will not break the root job if it is run there.

Determinism
-----------
Standard library only. No clock, no randomness, no environment lookups, no
subprocesses. Files are walked in sorted order and findings are sorted by
(property, location, detail), so two runs on the same tree print byte-identical
output.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

MOBILE = Path(__file__).resolve().parent.parent
REPO = MOBILE.parent

ENGINE_DIR = REPO / "src" / "lib" / "game"
ART = ENGINE_DIR / "art.ts"
I18N = REPO / "src" / "lib" / "i18n.ts"
ACCOUNTS = REPO / "src" / "lib" / "server" / "accounts.ts"

SEAM = MOBILE / "src" / "engine.ts"
MOBILE_APP = MOBILE / "App.tsx"
MOBILE_README = MOBILE / "README.md"
IOS_ART = MOBILE / "src" / "ui" / "CreatureArt.tsx"

WEB_APP = REPO / "src" / "app"
WEB_COMPONENTS = REPO / "src" / "components"

PROPERTIES = {
    "P1": "no rule is reimplemented client-side",
    "P2": "the art renderer handles every primitive",
    "P3": "screen and feature parity",
    "P4": "both languages on both clients",
    "P5": "the platform-substitution table is honest",
}


# ---------------------------------------------------------------------------
# Plumbing
# ---------------------------------------------------------------------------
def broke(message: str) -> "None":
    """Exit 2. Used only when the audit cannot be performed at all."""
    print(f"audit_parity: could not run the audit: {message}", file=sys.stderr)
    raise SystemExit(2)


@dataclass(frozen=True)
class Finding:
    prop: str
    where: str
    detail: str
    note: str = ""

    def sort_key(self) -> tuple:
        return (self.prop, self.where, self.detail)

    def render(self) -> str:
        text = f"  {self.prop}  {self.where}\n        {self.detail}"
        if self.note:
            text += f"\n        {self.note}"
        return text


def read(path: Path) -> str:
    if not path.is_file():
        broke(f"{rel(path)} is missing")
    return path.read_text(encoding="utf-8")


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(REPO))
    except ValueError:
        return str(path)


def line_of(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def at(path: Path, text: str, index: int) -> str:
    return f"{rel(path)}:{line_of(text, index)}"


def blank(text: str, spans: list[tuple[int, int]]) -> str:
    """Replace the given spans with spaces, keeping every newline in place.

    Offsets stay valid, so a finding still reports the line the code is on even
    after comments, styles or string bodies have been removed from the scan.
    """
    chars = list(text)
    for start, end in spans:
        for i in range(max(0, start), min(len(chars), end)):
            if chars[i] != "\n":
                chars[i] = " "
    return "".join(chars)


def strip_comments(source: str) -> str:
    """Blank out comments so the scanners read code rather than prose.

    The same trap `mobile/src/engine.test.ts` documents applies here: without
    this, a guard fires on an English sentence in a doc comment and gets
    "fixed" by rewording English until a regex is happy. The `[^:]` before `//`
    keeps a URL's slashes from eating the rest of the line.
    """
    spans: list[tuple[int, int]] = []
    for match in re.finditer(r"/\*[\s\S]*?\*/", source):
        spans.append(match.span())
    for match in re.finditer(r"(^|[^:])(//[^\n]*)", source):
        spans.append(match.span(2))
    return blank(source, spans)


def balanced_spans(source: str, opener: str) -> list[tuple[int, int]]:
    """Spans of every `opener ... )` region, matched by counting brackets."""
    spans: list[tuple[int, int]] = []
    for match in re.finditer(re.escape(opener), source):
        depth = 0
        i = match.end() - 1
        while i < len(source):
            if source[i] in "([{":
                depth += 1
            elif source[i] in ")]}":
                depth -= 1
                if depth == 0:
                    spans.append((match.start(), i + 1))
                    break
            i += 1
    return spans


def strip_literals(source: str) -> str:
    """Blank out the *contents* of string and template literals.

    Numbers inside a label ("⚔️ ×2") are text, not logic, and a scanner for
    magic numbers that reads them reports the game's own UI copy as a rule.
    """
    spans = [
        m.span(1)
        for m in re.finditer(r"'([^'\n\\]*(?:\\.[^'\n\\]*)*)'", source)
    ]
    spans += [m.span(1) for m in re.finditer(r'"([^"\n\\]*(?:\\.[^"\n\\]*)*)"', source)]
    spans += [m.span(1) for m in re.finditer(r"`([^`\\]*(?:\\.[^`\\]*)*)`", source)]
    return blank(source, spans)


def logic_only(source: str) -> str:
    """Code with comments, styling and string bodies removed.

    `StyleSheet.create({...})` is where every font size, radius and padding in
    this client lives, and inline `style={...}` props hold the rest. Scanning
    those for game constants reports `fontSize: 30` as the trainer level cap and
    `opacity: 0.3` as the speed bonus, which is how a checker earns the right to
    be ignored.
    """
    text = strip_comments(source)
    text = blank(text, balanced_spans(text, "StyleSheet.create("))
    text = blank(text, balanced_spans(text, "style={"))
    return strip_literals(text)


def ts_sources(root: Path) -> list[Path]:
    """Every non-test TypeScript source under `root`, sorted."""
    found = [
        path
        for path in list(root.rglob("*.ts")) + list(root.rglob("*.tsx"))
        if ".test." not in path.name
    ]
    return sorted(found, key=lambda p: str(p))


def mobile_sources(include_tests: bool = False) -> list[Path]:
    src = MOBILE / "src"
    if not src.is_dir():
        broke(f"{rel(src)} is missing")
    files = list(src.rglob("*.ts")) + list(src.rglob("*.tsx")) + [MOBILE_APP]
    if not include_tests:
        files = [f for f in files if ".test." not in f.name]
        # `src/test/` is the vitest harness, not shipped code.
        files = [f for f in files if "src/test/" not in str(f).replace("\\", "/")]
    return sorted(set(files), key=lambda p: str(p))


def mobile_screens() -> list[Path]:
    return ts_sources(MOBILE / "src" / "screens")


def web_sources() -> list[Path]:
    return ts_sources(WEB_APP) + ts_sources(WEB_COMPONENTS)


# ---------------------------------------------------------------------------
# The shared surface
# ---------------------------------------------------------------------------
def seam_exports() -> set[str]:
    """Every name `mobile/src/engine.ts` re-exports from the engine.

    This is the whole surface the iOS client is allowed to reach, by design -
    the seam is the one file that knows the path across the directory boundary.
    """
    source = strip_comments(read(SEAM))
    names: set[str] = set()
    for block in re.finditer(r"export\s*\{([^}]*)\}\s*from\s*'([^']+)'", source):
        for raw in block.group(1).split(","):
            name = raw.strip()
            if not name:
                continue
            name = re.sub(r"^type\s+", "", name)
            name = re.split(r"\s+as\s+", name)[0].strip()
            if name:
                names.add(name)
    if not names:
        broke(f"{rel(SEAM)} re-exports nothing; the seam cannot be read")
    return names


def web_engine_imports() -> dict[str, list[str]]:
    """Engine names the web client imports, mapped to where it imports them.

    Only `@/lib/game/*` and `@/lib/i18n` count: those are the shared modules,
    the ones this client reaches through the seam.
    """
    used: dict[str, list[str]] = {}
    pattern = re.compile(
        r"import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'@/lib/(?:game/[\w.]+|i18n)'"
    )
    for path in web_sources():
        source = strip_comments(path.read_text(encoding="utf-8"))
        for block in pattern.finditer(source):
            where = at(path, source, block.start())
            for raw in block.group(1).split(","):
                name = re.sub(r"^type\s+", "", raw.strip())
                name = re.split(r"\s+as\s+", name)[0].strip()
                if name:
                    used.setdefault(name, []).append(where)
    if not used:
        broke("the web client imports nothing from src/lib/game - check the paths")
    return used


def engine_numeric_constants() -> dict[float, list[str]]:
    """`value -> [constant names]` for every numeric constant the engine exports.

    Read from the engine source rather than executed, so this needs no bundler
    and no node_modules. Only plain numeric literals are picked up; a constant
    computed from another one (`PATIENCE_WINDOW = ADAPT_WINDOW * 2`) is skipped
    rather than guessed at.
    """
    by_value: dict[float, list[str]] = {}
    files = sorted(ENGINE_DIR.glob("*.ts"), key=lambda p: p.name)
    if not files:
        broke(f"no engine modules under {rel(ENGINE_DIR)}")
    for path in files:
        if ".test." in path.name:
            continue
        source = strip_comments(path.read_text(encoding="utf-8"))
        for match in re.finditer(
            r"^export const ([A-Z][A-Z_0-9]*)\s*=\s*(-?\d+(?:\.\d+)?)\s*;", source, re.M
        ):
            by_value.setdefault(float(match.group(2)), []).append(match.group(1))
    for names in by_value.values():
        names.sort()
    return by_value


# ---------------------------------------------------------------------------
# P1 - no rule is reimplemented client-side
# ---------------------------------------------------------------------------
#
# Three heuristics, in decreasing order of confidence. None of them can prove
# the absence of a fork; what they can do is name the shapes a fork actually
# takes in this codebase, which is what the three real ones found so far looked
# like.
#
# D1 (exact) A local declaration whose name the engine already exports. There is
#            no innocent reason for a screen to declare its own `effectiveness`
#            or `MAX_CHARGE`; the import is right there.
# D2 (narrow) An engine constant's *value* written as a bare number in a line
#            that is also talking about game state. Style blocks and string
#            bodies are removed first, values 0 and 1 are ignored as too
#            universal to mean anything, and the line must mention a domain word
#            - without all three filters this reports `fontSize: 30` as the
#            level cap.
# D3 (narrow) A game quantity assigned from arithmetic that mentions no engine
#            export at all. `Math.round(accuracyOf(stat) * 100)` is presentation
#            derived from an engine answer and is fine; `hp * 2 * 1.2` is the
#            engine's job done again, worse.
# D4 (curated) Known engine selectors written out by hand. Each entry names the
#            export it duplicates, so a hit reads as "call this instead" rather
#            than as a style complaint.

DOMAIN_WORDS = (
    "xp",
    "hp",
    "damage",
    "level",
    "tier",
    "charge",
    "combo",
    "stage",
    "streak",
    "badge",
    "effectiveness",
    "multiplier",
    "crit",
    "evolve",
    "evolution",
    "element",
    "attack",
    "defend",
    "accuracy",
    "attempts",
    "speed",
    "caught",
    "catch",
)
DOMAIN_RE = re.compile(r"\b(" + "|".join(DOMAIN_WORDS) + r")\w*\b", re.IGNORECASE)

# Identifiers whose value is a rule quantity rather than a layout or a label.
DOMAIN_ASSIGN_RE = re.compile(
    r"\b(?:const|let|var)\s+"
    r"(damage|dmg|xp\w*|level|tier|multiplier|effectiveness|charge|combo|hp|"
    r"maxHp|accuracy|streak|par\w*)\s*=\s*([^;\n]+)",
    re.IGNORECASE,
)
ARITHMETIC_RE = re.compile(r"[*/%]|\*\*|(?<![=!<>])\+(?!\+)|(?<![=!<>])-(?!-)|Math\.")

# Each pattern is one engine export written out longhand. The engine name is
# printed with the finding so the fix is "import this", not "rewrite this".
INLINED_SELECTORS: tuple[tuple[str, str, str], ...] = (
    (
        "creaturesByElement",
        r"\.filter\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\1\.element\s*===",
        "picking a roster subset by element",
    ),
    (
        "SKILLS",
        r"Object\.keys\(\s*[\w.]*skillStats",
        "enumerating the maths skills from a save file instead of the engine's list",
    ),
    (
        "getCreature",
        r"CREATURES\.find\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\1\.id\s*===",
        "looking a creature up by id",
    ),
    (
        "badgeById",
        r"BADGES\.find\(",
        "looking a badge up by id",
    ),
    (
        "availableAtLevel",
        r"\.filter\([^)]*\bunlockLevel\b",
        "deciding which creatures a level has unlocked",
    ),
    (
        "evolutionLine",
        r"\.filter\([^)]*\blineId\b",
        "walking an evolution line",
    ),
    (
        "levelFromXp",
        r"Math\.floor\([^)]*\bxp\b",
        "turning XP into a level",
    ),
    (
        "accuracyOf",
        r"\.correct\s*/\s*[\w.]*\battempts\b",
        "computing accuracy from raw attempt counts",
    ),
    (
        "completion",
        r"caught\.length\s*/\s*CREATURES\.length",
        "computing album completion",
    ),
    (
        "statsAtLevel",
        r"\b(?:maxHp|attack|defence|defense)\s*=\s*[^;\n]*[*+]",
        "scaling a creature's stats by level",
    ),
)


def check_rules(seam: set[str], constants: dict[float, list[str]]) -> list[Finding]:
    findings: list[Finding] = []
    prop = "P1"

    # --- the seam offers everything the other client uses -------------------
    for name, places in sorted(web_engine_imports().items()):
        if name not in seam:
            findings.append(
                Finding(
                    prop,
                    rel(SEAM),
                    f"the web client imports {name!r} from the engine, "
                    f"but the seam does not re-export it (first used at {sorted(places)[0]})",
                    note=(
                        "A rule the other client reaches and this one cannot is a "
                        "fork waiting to happen: the screen that needs it will "
                        "write its own."
                    ),
                )
            )

    # --- the seam is the only path across the boundary ----------------------
    for path in mobile_sources(include_tests=True):
        if path == SEAM:
            continue
        source = strip_comments(path.read_text(encoding="utf-8"))
        for match in re.finditer(r"from\s*'((?:\.\./)+src/lib/[^']+)'", source):
            findings.append(
                Finding(
                    prop,
                    at(path, source, match.start()),
                    f"imports {match.group(1)!r} directly instead of through the seam",
                    note="mobile/src/engine.ts is the one file that knows this path.",
                )
            )

    for path in mobile_sources():
        raw = path.read_text(encoding="utf-8")
        source = strip_comments(raw)
        code = logic_only(raw)

        # --- D1: a local declaration shadowing an engine export -------------
        if path != SEAM:
            for match in re.finditer(
                r"^(?:export\s+)?(?:const|let|var|function|class|type|interface|enum)\s+(\w+)",
                source,
                re.M,
            ):
                if match.group(1) in seam:
                    findings.append(
                        Finding(
                            prop,
                            at(path, source, match.start()),
                            f"declares {match.group(1)!r}, which the engine already exports",
                            note="Import it from '../engine' rather than declaring a second one.",
                        )
                    )

        # --- D2: an engine constant's value as a bare number ----------------
        for number in re.finditer(r"(?<![\w.])(\d+(?:\.\d+)?)(?![\w.])", code):
            value = float(number.group(1))
            if value in (0.0, 1.0) or value not in constants:
                continue
            start = code.rfind("\n", 0, number.start()) + 1
            end = code.find("\n", number.end())
            line = code[start : end if end != -1 else len(code)]
            if not DOMAIN_RE.search(line):
                continue
            names = constants[value]
            # Already importing the constant it duplicates? Then the number is
            # something else on a line that happens to mention the game.
            if any(re.search(rf"\b{name}\b", source) for name in names):
                continue
            findings.append(
                Finding(
                    prop,
                    at(path, code, number.start()),
                    f"uses the literal {number.group(1)} where the engine exports "
                    f"{' / '.join(names)} with that value",
                    note=f"in: {line.strip()[:96]}",
                )
            )

        # --- D3: a rule quantity computed without the engine ----------------
        for match in DOMAIN_ASSIGN_RE.finditer(code):
            name, rhs = match.group(1), match.group(2)
            if not ARITHMETIC_RE.search(rhs):
                continue
            if any(re.search(rf"\b{export}\b", rhs) for export in seam):
                continue
            findings.append(
                Finding(
                    prop,
                    at(path, code, match.start()),
                    f"computes {name!r} from arithmetic that mentions no engine export",
                    note=f"in: {match.group(0).strip()[:96]}",
                )
            )

        # --- D4: a known engine selector written out longhand ---------------
        for export, pattern, what in INLINED_SELECTORS:
            if path == SEAM:
                continue
            for match in re.finditer(pattern, code):
                if re.search(rf"\b{export}\b", source):
                    continue
                findings.append(
                    Finding(
                        prop,
                        at(path, code, match.start()),
                        f"{what} by hand; the engine exports `{export}` for this",
                        note=f"in: {code[match.start():match.end()].strip()[:96]}",
                    )
                )

    return findings


# ---------------------------------------------------------------------------
# P2 - the art renderer handles every primitive
# ---------------------------------------------------------------------------
def art_model() -> dict[str, dict]:
    """The drawing model, parsed out of `art.ts`.

    Returns the `Shape` union as `kind -> {"fields": [...], "paint": bool}`,
    plus the field lists of `Paint`, `Gradient`, `GradientStop` and `Drawing`.

    Derived rather than typed out: a new primitive, or a new field on an old
    one, has to appear here on the run after it is added to the engine. That is
    the whole point - the bug this guards against is a renderer that quietly
    does not know about something the engine emits.
    """
    source = strip_comments(read(ART))

    union = re.search(r"export type Shape\s*=\s*([\s\S]*?);\s*\n", source)
    if union is None:
        broke(f"no `export type Shape = ...` union in {rel(ART)}")

    variants: dict[str, dict] = {}
    for arm in re.finditer(r"\{([^{}]*)\}(\s*&\s*Paint)?", union.group(1)):
        body, paint = arm.group(1), arm.group(2) is not None
        kind = re.search(r"kind:\s*'(\w+)'", body)
        if kind is None:
            continue
        fields = [
            name
            for name in re.findall(r"(\w+)\??\s*:", body)
            if name != "kind" and name not in ("string", "number", "boolean")
        ]
        variants[kind.group(1)] = {"fields": sorted(set(fields)), "paint": paint}

    if not variants:
        broke(f"the `Shape` union in {rel(ART)} parsed to no variants")

    def fields_of(type_name: str) -> list[str]:
        """Field names of one object type, brace-matched rather than line-matched.

        `GradientStop` is written on one line and `Gradient` over several. A
        regex anchored on `\\n};` reads straight past the one-liner and returns
        the *next* type's fields, which is how this first ran: the renderer was
        told it must read `stop.stops`.
        """
        head = re.search(rf"export type {type_name}\s*=\s*\{{", source)
        if head is None:
            broke(f"no `export type {type_name}` in {rel(ART)}")
        spans = [s for s in balanced_spans(source, "{") if s[0] == head.end() - 1]
        if not spans:
            broke(f"could not brace-match `export type {type_name}` in {rel(ART)}")
        body = source[spans[0][0] + 1 : spans[0][1] - 1]
        return sorted(set(re.findall(r"(\w+)\??\s*:", body)))

    return {
        "variants": variants,
        "paint": fields_of("Paint"),
        "gradient": fields_of("Gradient"),
        "stop": fields_of("GradientStop"),
        "drawing": fields_of("Drawing"),
    }


def check_art(model: dict) -> list[Finding]:
    prop = "P2"
    findings: list[Finding] = []
    source = read(IOS_ART)
    code = strip_comments(source)

    # Split the renderer's switch into one chunk per `case`, so a field can be
    # required *in the branch that draws it* rather than merely somewhere in the
    # file. A `shape.rotate` in the circle branch would not help the ellipse.
    marks = [(m.group(1), m.start()) for m in re.finditer(r"case\s+'(\w+)':", code)]
    bounds = [m[1] for m in marks] + [len(code)]
    chunks = {kind: code[start : bounds[i + 1]] for i, (kind, start) in enumerate(marks)}

    for kind in sorted(model["variants"]):
        spec = model["variants"][kind]
        if kind not in chunks:
            findings.append(
                Finding(
                    prop,
                    rel(IOS_ART),
                    f"no `case '{kind}':` branch, but the engine's Shape union can emit one",
                    note=(
                        "A primitive with no branch renders as nothing, and nothing "
                        "looks like art rather than like a bug."
                    ),
                )
            )
            continue
        for field in spec["fields"]:
            if f"shape.{field}" not in chunks[kind]:
                findings.append(
                    Finding(
                        prop,
                        rel(IOS_ART),
                        f"the '{kind}' branch never reads `shape.{field}`, "
                        f"which art.ts declares on that primitive",
                        note="A geometry field the renderer ignores is silently dropped.",
                    )
                )
        if spec["paint"] and "paint(" not in chunks[kind]:
            findings.append(
                Finding(
                    prop,
                    rel(IOS_ART),
                    f"the '{kind}' branch does not apply Paint, which art.ts mixes into it",
                )
            )

    # Paint, gradients and the drawing envelope: required somewhere in the file,
    # since they are handled by shared helpers rather than per-branch.
    for label, fields, holder in (
        ("Paint", model["paint"], "shape"),
        ("Gradient", model["gradient"], "gradient"),
        ("GradientStop", model["stop"], "stop"),
        ("Drawing", model["drawing"], "drawing"),
    ):
        for field in fields:
            if f"{holder}.{field}" not in code:
                findings.append(
                    Finding(
                        prop,
                        rel(IOS_ART),
                        f"never reads `{holder}.{field}`, which art.ts declares on {label}",
                    )
                )

    # A gradient reference is not a colour. Handing `grad:mm-cindik-body` to SVG
    # unresolved renders every creature black.
    if "GRADIENT_REF" not in code or "url(#" not in code:
        findings.append(
            Finding(
                prop,
                rel(IOS_ART),
                "does not resolve GRADIENT_REF fills into `url(#...)` references",
            )
        )

    # The geometry belongs to the engine; a path literal here means it has
    # started to fork again.
    for match in re.finditer(r'd="M[\d\s.]', code):
        findings.append(
            Finding(
                prop,
                at(IOS_ART, code, match.start()),
                "contains a hardcoded path; the geometry lives in art.ts",
            )
        )

    return findings


# ---------------------------------------------------------------------------
# P3 - screen and feature parity
# ---------------------------------------------------------------------------
#
# Routes are derived from `src/app/**/page.tsx` and screens from
# `mobile/src/screens/`. The mapping between them cannot be derived - `/start`
# is `Onboarding` and `/play` is two screens - so it is declared, and then
# checked in both directions: a route with no entry fails, and an entry naming a
# screen that does not exist or is never rendered fails too. A stale mapping is
# therefore loud rather than silently permissive.
ROUTE_SCREENS: dict[str, tuple[str, ...]] = {
    "/": ("Home",),
    "/album": ("Album",),
    "/login": ("SignIn",),
    "/play": ("PickOpponent", "BattleScreen"),
    "/progress": ("ProgressScreen",),
    "/settings": ("Settings",),
    "/start": ("Onboarding",),
}

# A feature is a pair of probes over real source, one per client. Both halves
# are checked: if the *web* probe stops matching, the row is reported as stale
# rather than passing quietly, which is the rule `audit_docs.py` learned the
# hard way - a claim that can no longer match can never fail.
@dataclass(frozen=True)
class Feature:
    name: str
    web: str
    ios: str
    note: str = ""


FEATURES: tuple[Feature, ...] = (
    Feature("PIN sign-in", r"/api/auth/pin", r"/auth/pin"),
    Feature("Google sign-in", r"/api/auth/google", r"auth/google|signInWithGoogle"),
    Feature(
        # The same pattern on both sides, deliberately. `clearProfile()` exists
        # in this client's GameContext, so probing for *that* would report the
        # feature as present because the plumbing is there - while no screen
        # offers it and no child can reach it. A capability nobody can tap is
        # not a feature.
        "delete the save and start over",
        r"setProfile\(null\)",
        r"setProfile\(null\)",
        note="The web Settings screen can wipe the save and begin again.",
    ),
    Feature("the element wheel, in full", r"strongAgainst\(", r"strongAgainst\("),
    Feature("the draining speed meter", r"speed-meter", r"speed-meter"),
    Feature("per-skill maths breakdown", r"SKILL_META", r"SKILL_META"),
    Feature("badges named on the result screen", r"badgeById\(", r"badgeById\("),
    Feature("silhouettes for un-caught creatures", r"silhouette", r"silhouette"),
    Feature("the language toggle", r"lang-\$\{|lang-en", r"lang-\$\{|lang-en"),
    Feature("catching a beaten creature", r"catchPrompt", r"catchPrompt"),
    Feature("cross-device profile sync", r"/api/profile", r"/profile"),
)


def not_yet_here() -> str:
    """The 'Not yet here' paragraph of mobile/README.md - the documented gaps."""
    readme = read(MOBILE_README)
    match = re.search(r"Not yet here:([\s\S]*?)(?:\n#{1,6}\s|\Z)", readme)
    if match is None:
        broke(
            f"{rel(MOBILE_README)} has no 'Not yet here:' paragraph; "
            "P3 has nowhere to look up a deliberate absence"
        )
    return match.group(1)


def documented_absent(text: str, name: str) -> bool:
    """True if the gap paragraph mentions this feature.

    Matched on the significant words of the name rather than the whole string,
    so the paragraph can read as English ("Google sign-in (the web client offers
    it...)") instead of having to quote a checker.
    """
    words = [w for w in re.findall(r"[a-zA-Z]{4,}", name.lower())]
    if not words:
        return False
    lowered = text.lower()
    return all(word in lowered for word in words)


def check_screens() -> list[Finding]:
    prop = "P3"
    findings: list[Finding] = []
    gaps = not_yet_here()

    if not WEB_APP.is_dir():
        broke(f"{rel(WEB_APP)} is missing")
    routes = sorted(
        "/" + str(page.parent.relative_to(WEB_APP)).replace("\\", "/").replace(".", "")
        for page in WEB_APP.rglob("page.tsx")
        if "api" not in page.parts
    )
    routes = [r if r != "/" else "/" for r in routes]
    if not routes:
        broke(f"no page.tsx under {rel(WEB_APP)}")

    app_source = strip_comments(read(MOBILE_APP))
    screen_files = {path.stem for path in mobile_screens()}

    for route in routes:
        expected = ROUTE_SCREENS.get(route)
        if expected is None:
            findings.append(
                Finding(
                    prop,
                    f"src/app{'' if route == '/' else route}/page.tsx",
                    f"the web route {route!r} has no iOS counterpart declared",
                    note=(
                        "Add it to ROUTE_SCREENS with the screen that covers it, or "
                        "record the absence in mobile/README.md's 'Not yet here'."
                    ),
                )
            )
            continue
        for screen in expected:
            if screen not in screen_files:
                findings.append(
                    Finding(
                        prop,
                        "mobile/src/screens/",
                        f"{route!r} maps to {screen}, but there is no {screen}.tsx",
                    )
                )
            elif not re.search(rf"<{screen}[\s/>]", app_source):
                findings.append(
                    Finding(
                        prop,
                        rel(MOBILE_APP),
                        f"{screen} exists but the router never renders it, "
                        f"so the web route {route!r} has no way in",
                    )
                )

    mapped = {screen for screens in ROUTE_SCREENS.values() for screen in screens}
    for screen in sorted(screen_files - mapped):
        findings.append(
            Finding(
                prop,
                f"mobile/src/screens/{screen}.tsx",
                f"{screen} is an iOS screen with no web route mapped to it",
                note="Drift runs both ways; add it to ROUTE_SCREENS or remove it.",
            )
        )

    # --- features -----------------------------------------------------------
    web_text = "\n".join(p.read_text(encoding="utf-8") for p in web_sources())
    ios_text = "\n".join(p.read_text(encoding="utf-8") for p in mobile_sources())

    for feature in FEATURES:
        on_web = re.search(feature.web, web_text) is not None
        on_ios = re.search(feature.ios, ios_text) is not None
        if not on_web:
            findings.append(
                Finding(
                    prop,
                    "src/app, src/components",
                    f"the probe for {feature.name!r} no longer matches the web client",
                    note=(
                        "A feature probe that matches nothing can never fail. Fix the "
                        "pattern if the code moved, or drop the row if the feature is gone."
                    ),
                )
            )
            continue
        if not on_ios and not documented_absent(gaps, feature.name):
            findings.append(
                Finding(
                    prop,
                    "mobile/src",
                    f"the web client offers {feature.name!r} and this one does not",
                    note=(
                        (feature.note + " ") if feature.note else ""
                    )
                    + "Either build it, or say so in mobile/README.md's 'Not yet here'.",
                )
            )

    return findings


# ---------------------------------------------------------------------------
# P4 - both languages on both clients
# ---------------------------------------------------------------------------
# Props whose string value a child actually reads. A literal here is an English
# string the Chinese half of a bilingual player never gets a translation of.
USER_FACING_PROPS = (
    "label",
    "submitLabel",
    "clearLabel",
    "placeholder",
    "accessibilityLabel",
    "accessibilityHint",
    "title",
    "message",
    "subtitle",
)

# Two or more ASCII words: an English phrase. One word is deliberately not
# enough - "MAX", "Lv" and the language endonym "English" are all legitimately
# untranslated, and both clients print them identically today.
PHRASE_RE = re.compile(r"[A-Za-z]{2,}[ ][A-Za-z]{2,}")


def i18n_keys() -> set[str]:
    source = strip_comments(read(I18N))
    block = re.search(r"export const STRINGS\s*=\s*\{([\s\S]*)\n\}", source)
    if block is None:
        broke(f"no `export const STRINGS = {{...}}` in {rel(I18N)}")
    keys = set(re.findall(r"^  (\w+):", block.group(1), re.M))
    if not keys:
        broke(f"the STRINGS table in {rel(I18N)} parsed to no keys")
    return keys


def check_language(keys: set[str]) -> list[Finding]:
    prop = "P4"
    findings: list[Finding] = []

    for path in mobile_sources():
        raw = path.read_text(encoding="utf-8")
        source = strip_comments(raw)

        # Every key this client asks for must exist in the shared table. A typo
        # renders the key itself, in one language, in front of a child.
        for match in re.finditer(r"\btr\(\s*'(\w+)'\s*\)", source):
            if match.group(1) not in keys:
                findings.append(
                    Finding(
                        prop,
                        at(path, source, match.start()),
                        f"tr({match.group(1)!r}) is not a key in src/lib/i18n.ts",
                    )
                )
        for match in re.finditer(r"\bSTRINGS\.(\w+)", source):
            if match.group(1) not in keys:
                findings.append(
                    Finding(
                        prop,
                        at(path, source, match.start()),
                        f"STRINGS.{match.group(1)} is not a key in src/lib/i18n.ts",
                    )
                )

        if path.suffix != ".tsx":
            continue

        # Text sitting directly between JSX tags, e.g. `<Text>Hello</Text>`.
        #
        # Scanned with string bodies blanked out, and required to run up to a
        # *closing* tag. Without the first, `throw new Error('useGame must be
        # used inside <GameProvider>')` reads as rendered text; without the
        # second, `Promise<{ ok: true }>` and `{name.length > 0 && <Text` do.
        bare = strip_literals(source)
        for match in re.finditer(r">([^<>{}\n]*[A-Za-z]{4,}[^<>{}\n]*)</", bare):
            text = match.group(1).strip()
            if not text or not re.search(r"[A-Za-z]{4,}", text):
                continue
            findings.append(
                Finding(
                    prop,
                    at(path, bare, match.start(1)),
                    f"renders the English literal {text!r} instead of a shared string",
                    note="Both languages are first-class; put it in src/lib/i18n.ts and use tr().",
                )
            )

        # An English phrase inside a JSX expression container: either one
        # sitting between tags (`>{cond ? 'Well done' : 'Try again'}`) or the
        # value of a prop (`label={'Play again'}`). `style={...}` is skipped -
        # it holds layout keywords, never anything a child reads.
        containers = [
            m.span(1) for m in re.finditer(r">\s*\{([^{}]*)\}", source)
        ] + [
            m.span(2)
            for m in re.finditer(r"\b(\w+)=\{([^{}]*)\}", source)
            if m.group(1) != "style"
        ]
        for start, end in sorted(set(containers)):
            for literal in re.finditer(r"'([^'\n]{4,})'", source[start:end]):
                if PHRASE_RE.search(literal.group(1)):
                    findings.append(
                        Finding(
                            prop,
                            at(path, source, start + literal.start(1)),
                            f"renders the English phrase {literal.group(1)!r} inline",
                        )
                    )
        for prop_name in USER_FACING_PROPS:
            for match in re.finditer(rf'\b{prop_name}="([^"\n]+)"', source):
                if re.search(r"[A-Za-z]{4,}", match.group(1)):
                    findings.append(
                        Finding(
                            prop,
                            at(path, source, match.start(1)),
                            f"{prop_name}={match.group(1)!r} is an untranslated literal",
                        )
                    )

        # A translation table forked into a component: the web login page does
        # this, and it is how a string ends up correct in one client only.
        for match in re.finditer(
            r"\blanguage\s*===\s*'(?:en|zh)'\s*\?[^;\n]*'[^'\n]*'[^;\n]*:[^;\n]*'[^'\n]*'",
            source,
        ):
            findings.append(
                Finding(
                    prop,
                    at(path, source, match.start()),
                    "picks a translation inline instead of going through STRINGS",
                )
            )

    return findings


# ---------------------------------------------------------------------------
# P5 - the platform-substitution table is honest
# ---------------------------------------------------------------------------
#
# Three substitutions are documented, and each is a stand-in for a platform API
# rather than for a rule. Two directions are checked:
#
#   documented -> present   a row nobody implements is a lie in the README.
#   present -> documented   any *other* platform dependency is a fourth
#                           divergence, and the whole argument for this client
#                           being a port rather than a fork rests on there being
#                           exactly three.
#
# Packages that are pure rendering or layout are not divergences and are listed
# with the reason. Everything else has to be in the table.
BENIGN_PACKAGES = {
    "react": "the framework both clients already share",
    "react-native": "the framework itself; its named imports are checked below",
    "react-native-svg": "the drawing surface the shared art model is mapped onto",
    "react-native-safe-area-context": "layout insets; no rule and no web equivalent",
    "expo-status-bar": "status-bar styling, presentation only",
}

# react-native named imports that reach a device capability. These are where a
# fourth substitution would actually appear - a screen quietly gaining
# `Vibration`, `Platform.OS` branching, or its own `AppState` refresh.
PLATFORM_APIS = (
    "AccessibilityInfo",
    "AppState",
    "Appearance",
    "Clipboard",
    "Linking",
    "NativeModules",
    "PermissionsAndroid",
    "Platform",
    "PushNotificationIOS",
    "Share",
    "Vibration",
)


def substitution_table() -> list[tuple[str, str]]:
    """The (web, iOS) cells of the platform-substitution table."""
    readme = read(MOBILE_README)
    rows: list[tuple[str, str]] = []
    in_table = False
    for line in readme.splitlines():
        if line.startswith("|"):
            cells = [c.strip() for c in line.strip("|").split("|")]
            if len(cells) < 3:
                continue
            if re.match(r"^:?-+:?$", cells[0]):
                continue
            if cells[0].lower() == "web" and cells[1].lower() == "ios":
                in_table = True
                continue
            if in_table:
                rows.append((cells[0], cells[1]))
        elif in_table and not line.strip():
            in_table = False
    if not rows:
        broke(
            f"could not find the Web/iOS substitution table in {rel(MOBILE_README)}; "
            "P5 has nothing to check against"
        )
    return rows


def tokens_in(cell: str) -> tuple[list[str], list[str]]:
    """(modules, identifiers) named in one table cell."""
    modules = [t for t in re.findall(r"`([^`]+)`", cell) if re.search(r"[-/]", t)]
    identifiers = [t for t in re.findall(r"`([^`]+)`", cell) if not re.search(r"[-/]", t)]
    identifiers += re.findall(r"\b([A-Z][a-zA-Z]{3,})\b", re.sub(r"`[^`]*`", " ", cell))
    return sorted(set(modules)), sorted(set(identifiers))


def check_platform() -> list[Finding]:
    prop = "P5"
    findings: list[Finding] = []
    rows = substitution_table()

    sources = {path: path.read_text(encoding="utf-8") for path in mobile_sources()}
    code = "\n".join(strip_comments(text) for _, text in sorted(sources.items()))

    documented_modules: set[str] = set()
    documented_identifiers: set[str] = set()

    for web_cell, ios_cell in rows:
        modules, identifiers = tokens_in(ios_cell)
        documented_modules |= set(modules)
        documented_identifiers |= set(identifiers)

        present = any(f"'{module}'" in code for module in modules) or any(
            re.search(rf"\b{name}\b", code) for name in identifiers
        )
        if not present:
            findings.append(
                Finding(
                    prop,
                    rel(MOBILE_README),
                    f"the table documents {ios_cell!r} as the iOS substitution for "
                    f"{web_cell!r}, but nothing in mobile/src uses it",
                    note="A documented substitution nobody implements is a false claim.",
                )
            )

        # The web side of the row must not appear on this client: if it did, the
        # row would be describing a substitution that never happened.
        for name in re.findall(r"`([A-Za-z][\w-]+)`", web_cell):
            if re.search(rf"\b{re.escape(name)}\b", code):
                findings.append(
                    Finding(
                        prop,
                        "mobile/src",
                        f"uses the web-side API {name!r}, which the table says is "
                        f"substituted here by {ios_cell!r}",
                    )
                )

    # --- has a fourth divergence crept in? ----------------------------------
    def documented_package(module: str) -> bool:
        """Is this package named by the table, as a module or as its API?

        The AsyncStorage row names the *API*, not the npm package, which is the
        honest way to write it - the table is about what replaces what, not
        about a dependency list. So a package also counts as documented when its
        name spells out an identifier the table gives, ignoring case and dashes:
        `@react-native-async-storage/async-storage` covers `AsyncStorage`.
        """
        root = "/".join(module.split("/")[:2]) if module.startswith("@") else module.split("/")[0]
        if root in BENIGN_PACKAGES or root in documented_modules or module in documented_modules:
            return True
        flat = re.sub(r"[^a-z]", "", module.lower())
        return any(
            len(name) >= 6 and re.sub(r"[^a-z]", "", name.lower()) in flat
            for name in documented_identifiers
        )

    for path in sorted(sources, key=lambda p: str(p)):
        source = strip_comments(sources[path])
        for match in re.finditer(r"from\s*'([^.'][^']*)'", source):
            module = match.group(1)
            if documented_package(module):
                continue
            findings.append(
                Finding(
                    prop,
                    at(path, source, match.start()),
                    f"imports {module!r}, a platform dependency the substitution "
                    f"table does not mention",
                    note=(
                        "Three substitutions are documented and the port's whole "
                        "argument rests on there being exactly three. Add a row, or "
                        "drop the dependency."
                    ),
                )
            )

        for match in re.finditer(r"import\s*\{([^}]*)\}\s*from\s*'react-native'", source):
            for raw in match.group(1).split(","):
                name = re.sub(r"^type\s+", "", raw.strip())
                if name in PLATFORM_APIS and name not in documented_identifiers:
                    findings.append(
                        Finding(
                            prop,
                            at(path, source, match.start()),
                            f"reaches the platform API {name!r}, which the "
                            f"substitution table does not document",
                        )
                    )

    return findings


# ---------------------------------------------------------------------------
# Client-side validation must mirror the server's, which both clients talk to.
# Folded into P1: these bounds are a rule, and the server owns them.
# ---------------------------------------------------------------------------
def check_account_limits(seam: set[str]) -> list[Finding]:
    prop = "P1"
    findings: list[Finding] = []
    server = strip_comments(read(ACCOUNTS))
    sign_in = MOBILE / "src" / "screens" / "SignIn.tsx"
    client = strip_comments(read(sign_in))

    name_rule = re.search(
        r"trimmed\.length\s*>=\s*(\d+)\s*&&\s*trimmed\.length\s*<=\s*(\d+)", server
    )
    pin_rule = re.search(r"/\^\\d\{(\d+)\}\$/", server)
    if name_rule is None or pin_rule is None:
        broke(
            f"could not read the name/PIN bounds out of {rel(ACCOUNTS)}; "
            "the client-side mirror cannot be checked"
        )

    expected = {
        "NAME_MIN": int(name_rule.group(1)),
        "NAME_MAX": int(name_rule.group(2)),
        "PIN_LENGTH": int(pin_rule.group(1)),
    }
    for constant, want in sorted(expected.items()):
        found = re.search(rf"export const {constant}\s*=\s*(\d+)", client)
        if found is None:
            findings.append(
                Finding(
                    prop,
                    rel(sign_in),
                    f"declares no {constant}; the server's own limit is {want}",
                )
            )
        elif int(found.group(1)) != want:
            findings.append(
                Finding(
                    prop,
                    rel(sign_in),
                    f"{constant} is {found.group(1)}, but src/lib/server/accounts.ts "
                    f"enforces {want}",
                    note=(
                        "The client check exists so a child hears about a typo before "
                        "a round trip. One that disagrees with the server is worse "
                        "than none."
                    ),
                )
            )
    return findings


# ---------------------------------------------------------------------------
# What this deliberately does not check
# ---------------------------------------------------------------------------
LIMITATIONS = [
    (
        "P1",
        "Arithmetic inlined into JSX rather than assigned to a name.",
        "D3 keys off `const <game quantity> = ...`. "
        "`{Math.round((summary.correct / summary.total) * 100)}%` written straight "
        "into a tag is invisible to it. Both clients do exactly that for the "
        "post-battle accuracy today, identically, which is why it is a limitation "
        "and not a finding: naming every arithmetic expression in JSX would be a "
        "style rule wearing a correctness rule's clothes.",
    ),
    (
        "P1",
        "A rule forked into *both* clients at once.",
        "Everything here compares iOS against the web client and the engine. Two "
        "clients that agree with each other and disagree with the engine look "
        "identical to this script. `src/lib/game/`'s own tests are what cover that.",
    ),
    (
        "P1",
        "Magic numbers that are not the value of a named engine constant.",
        "The trainer-name bounds in Onboarding.tsx (2 and 16) are literals on both "
        "clients, matching each other and the server, but no engine constant holds "
        "them - so D2 cannot see them. The account form's copies *are* checked, "
        "against src/lib/server/accounts.ts, because it declares them as named "
        "constants.",
    ),
    (
        "P2",
        "Whether a branch draws the primitive *correctly*.",
        "This checks that a branch exists and reads every field art.ts declares. A "
        "branch that reads `shape.rx` and passes it as `ry` is a wrong picture, not "
        "a missing one, and only an eye or a snapshot catches that. "
        "`mobile/src/ui/CreatureArt.test.ts` covers the runtime half.",
    ),
    (
        "P3",
        "Feature parity below the level of a probe.",
        "FEATURES names eleven things and checks both halves of each. A web screen "
        "that grows a fourth stat tile the iOS one lacks is not in that list and "
        "will not be found. The probes are for features a child would notice was "
        "missing, not for every element on a screen.",
    ),
    (
        "P4",
        "Single English words, and the quality of a translation.",
        "'MAX', 'Lv' and the language endonym 'English' are one word each and are "
        "deliberately identical on both clients, so the phrase detector needs two "
        "words. A one-word English literal added to a screen therefore slips "
        "through. Nothing here can judge whether a zh string is *good*, either - "
        "only that one exists.",
    ),
    (
        "P5",
        "Whether a substitution behaves like the API it replaces.",
        "That AsyncStorage is used is checkable here; that it stores the same key "
        "and repairs the same way is `audit_docs.py`'s shared-save-key claim and "
        "`mobile/src/storage.test.ts`. This script only checks the table is not "
        "lying about what exists.",
    ),
]


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------
def print_limitations() -> None:
    print("What this audit deliberately does not check")
    print("-" * 78)
    for prop, what, why in LIMITATIONS:
        print(f"  {prop}  {what}")
        for line in wrap(why, 70):
            print(f"        {line}")
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
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json", action="store_true", help="print findings as JSON")
    parser.add_argument(
        "--limitations", action="store_true", help="print what this audit cannot catch"
    )
    args = parser.parse_args()

    if args.limitations:
        print_limitations()
        return 0

    seam = seam_exports()
    constants = engine_numeric_constants()
    keys = i18n_keys()
    model = art_model()

    findings = (
        check_rules(seam, constants)
        + check_account_limits(seam)
        + check_art(model)
        + check_screens()
        + check_language(keys)
        + check_platform()
    )
    findings = sorted(set(findings), key=Finding.sort_key)

    if args.json:
        print(
            json.dumps(
                {
                    "properties": PROPERTIES,
                    "violations": [
                        {
                            "property": f.prop,
                            "title": PROPERTIES[f.prop],
                            "where": f.where,
                            "detail": f.detail,
                            "note": f.note,
                        }
                        for f in findings
                    ],
                },
                indent=1,
                sort_keys=True,
            )
        )
        return 1 if findings else 0

    scanned = len(mobile_sources())
    print("Mathmon cross-client parity audit")
    print("=================================")
    print(f"engine surface: {len(seam)} names re-exported by mobile/src/engine.ts")
    print(f"iOS sources scanned: {scanned}   web sources scanned: {len(web_sources())}")
    print(f"primitives in the drawing model: {len(model['variants'])}")
    print(f"shared strings: {len(keys)}   features probed: {len(FEATURES)}")
    print(f"not machine-checked (see --limitations): {len(LIMITATIONS)}")
    print()

    broken = {f.prop for f in findings}
    for key in sorted(PROPERTIES):
        count = sum(1 for f in findings if f.prop == key)
        mark = "FAIL" if key in broken else "ok  "
        detail = f"{count} violation{'' if count == 1 else 's'}" if count else ""
        print(f"  {mark}  {key}  {PROPERTIES[key]:<44} {detail}")

    print()
    if findings:
        print(f"FAIL: {len(findings)} violation(s) of the cross-client contract")
        print()
        for finding in findings:
            print(finding.render())
            print()
        print("One engine, two clients. A rule change belongs in src/lib/game/ and")
        print("lands on both at once; never fork a rule into a client.")
        return 1

    print("OK: the two clients still play the same game.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
