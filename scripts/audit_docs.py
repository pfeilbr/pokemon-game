#!/usr/bin/env python3
"""
Verify the checkable factual claims in README.md, CLAUDE.md and mobile/README.md
against the actual source.

Why this exists
---------------
These documents are full of concrete numbers - "36 creatures", "twelve
evolution lines", "six-element wheel", "a rolling 8-attempt window" - and
numbers drift. The roster doubled from 18 creatures to 36 in a single change,
and the stale "18 creatures" / "six evolution lines" claims had to be chased
across three files by hand. One was missed and only caught later by a reviewer.
`CLAUDE.md` is the contributor contract, so a false claim there is not cosmetic:
it has already contained a statement that was outright wrong at the time it was
written.

So the claims are now machine-checked. Every number below is *derived from the
source* on each run. Nothing here restates a value the code already owns - a
second copy of "36" in this file would just move the drift somewhere new and
make the audit lie in a fresh way.

Where the actual values come from
---------------------------------
Three routes, chosen per value by what the value actually is:

1. **Executed TypeScript** (`CREATURES`, `ELEMENTS`, `effectiveness`,
   `movesFor`, `MAX_TIER`, `ADAPT_WINDOW`, `MAX_LEVEL`, `EVOLVE_AT`, `BADGES`,
   both `STORAGE_KEY`s, `TAP`). These are the game's own definitions, and
   several are *computed* rather than written down - the roster is built by
   `buildRoster()`, so the creature count exists nowhere as a literal, and the
   element multiplier sum only exists as the output of `effectiveness`. A
   regex could not read either. The engine is deliberately pure - no React, no
   DOM, no Node APIs - so it bundles with the repo's own esbuild and runs under
   plain node, exactly as `scripts/balance_report.py` and
   `mobile/scripts/album_cost.py` already do. No test runner, no network.

2. **Parsed source** (`@utility tap` in `globals.css`, the `Screen` union and
   the screen components in `mobile/App.tsx`). CSS is not TypeScript, and
   `App.tsx` is a React Native component tree that cannot be executed under
   node without a renderer. Both are read with a narrow regex over the real
   file, never a copy of the value.

3. **Parsed JSON** (`package.json` scripts and dependency versions). No
   execution needed.

What "verified" means here
--------------------------
A claim fails if its number disagrees with the source. A claim *also* fails if
its pattern no longer matches anything in the documents it is declared for.
That second rule is the important one: a doc audit whose claims can quietly
stop matching is a test that can never fail. If you reword a sentence, update
the pattern; if you delete the sentence, delete the claim.

Claims that are deliberately NOT checked here are listed in `UNCHECKED` and
printed by `--unchecked`, with the reason for each. An audit that silently
checks only the easy claims is the same failure mode.

Usage
-----
    python3 scripts/audit_docs.py              # verify; non-zero on mismatch
    python3 scripts/audit_docs.py --values     # dump every derived value
    python3 scripts/audit_docs.py --unchecked  # list what this does not check

Exit status
-----------
0  every claim matches the source.
1  at least one claim is wrong, or a claim's pattern no longer matches.
2  the audit itself could not run (no esbuild, no node, missing file). A
   failure to measure is never reported as a pass.

Determinism
-----------
Standard library only. No clock, no randomness, no environment lookups beyond
locating node. Findings are sorted by (file, line, claim), so two runs on the
same tree print byte-identical output.

Note on shelling out: every subprocess is an explicit argv list whose return
code is checked on its own. Nothing is piped through `head`/`tail` - a pipeline
reports the exit status of its *last* command, and that has already produced a
false all-clear in this repository once.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

REPO = Path(__file__).resolve().parent.parent
ESBUILD = REPO / "node_modules" / ".bin" / "esbuild"

DOCS = ("README.md", "CLAUDE.md", "mobile/README.md")

GLOBALS_CSS = REPO / "src" / "app" / "globals.css"
MOBILE_APP = REPO / "mobile" / "App.tsx"
ROOT_PKG = REPO / "package.json"
MOBILE_PKG = REPO / "mobile" / "package.json"


# --------------------------------------------------------------------------
# Number words. The documents write small counts out ("twelve evolution
# lines") and large ones as digits ("36 creatures"), so a claim pattern has to
# accept both. Only these spellings are recognised, which means a pattern
# cannot silently match a non-number and be skipped - it just does not match,
# and the missing-claim rule then fails the run.
# --------------------------------------------------------------------------
WORDS = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "thirteen": 13,
    "fourteen": 14,
    "fifteen": 15,
    "sixteen": 16,
    "eighteen": 18,
    "twenty": 20,
    "thirty": 30,
    "thirty-six": 36,
    "forty": 40,
    "fifty": 50,
    "sixty": 60,
}

# Longest-first so "thirty-six" wins over "thirty".
NUM = r"(?:\d+|" + "|".join(sorted(WORDS, key=len, reverse=True)) + r")"


def as_number(text: str) -> int | None:
    """`"36"` -> 36, `"Twelve"` -> 12, anything else -> None."""
    stripped = text.strip()
    if stripped.isdigit():
        return int(stripped)
    return WORDS.get(stripped.lower())


# --------------------------------------------------------------------------
# Route 1: run the real engine.
# --------------------------------------------------------------------------
# Everything this harness prints is *derived*, never restated. The creature
# count comes from the length of the roster the engine builds; the element
# multiplier sum is the actual output of `effectiveness` summed over the wheel;
# the move count is the length of what `movesFor` returns. If a rule changes,
# this number changes with it, which is the whole point.
HARNESS = r"""
import { CREATURES, LINES_PER_ELEMENT, starters } from '@engine/creatures';
import { ELEMENTS, effectiveness } from '@engine/elements';
import { movesFor } from '@engine/moves';
import { ADAPT_WINDOW, MAX_TIER, MIN_TIER, SKILLS } from '@engine/math';
import { BADGES, EVOLVE_AT, MAX_LEVEL } from '@engine/progress';
import { STORAGE_KEY as WEB_STORAGE_KEY } from '@/lib/storage/client';

/** Lines are grouped by lineId, exactly as `evolutionLine` walks them. */
const byLine = new Map();
for (const creature of CREATURES) {
  const bucket = byLine.get(creature.lineId) ?? [];
  bucket.push(creature);
  byLine.set(creature.lineId, bucket);
}

const lineDepths = [...new Set([...byLine.values()].map((line) => line.length))].sort(
  (a, b) => a - b,
);

/** Lines per element, derived rather than read from LINES_PER_ELEMENT. */
const linesPerElement = [
  ...new Set(
    ELEMENTS.map(
      (element) =>
        new Set(
          CREATURES.filter((c) => c.element === element).map((c) => c.lineId),
        ).size,
    ),
  ),
].sort((a, b) => a - b);

/** Every element's outgoing (and incoming) multipliers, summed over the wheel. */
const outgoingSums = [
  ...new Set(
    ELEMENTS.map((a) => ELEMENTS.reduce((t, d) => t + effectiveness(a, d), 0)),
  ),
].sort((a, b) => a - b);
const incomingSums = [
  ...new Set(
    ELEMENTS.map((d) => ELEMENTS.reduce((t, a) => t + effectiveness(a, d), 0)),
  ),
].sort((a, b) => a - b);

/** Move-kit size per element; a single distinct value means "every creature". */
const moveCounts = [...new Set(ELEMENTS.map((e) => movesFor(e).length))].sort(
  (a, b) => a - b,
);

process.stdout.write(
  JSON.stringify({
    creatures: CREATURES.length,
    lines: byLine.size,
    lineDepths,
    linesPerElement,
    linesPerElementConstant: LINES_PER_ELEMENT,
    starters: starters().length,
    elements: ELEMENTS.length,
    outgoingSums,
    incomingSums,
    moveCounts,
    minTier: MIN_TIER,
    maxTier: MAX_TIER,
    skills: SKILLS.length,
    adaptWindow: ADAPT_WINDOW,
    maxLevel: MAX_LEVEL,
    evolveAt: [EVOLVE_AT[2], EVOLVE_AT[3]],
    badges: BADGES.length,
    webStorageKey: WEB_STORAGE_KEY,
  }),
);
"""


# The two iOS values below are read from source rather than executed.
#
# Both are plain literals, and running them meant bundling `mobile/src/*`,
# which transitively imports `@react-native-async-storage/async-storage`. That
# resolves on a developer machine and fails in CI, where the root job installs
# only the root's dependencies - the same trap that had the web typecheck
# compiling React Native for sixteen red runs. A literal does not need a
# bundler.
IOS_STORAGE = REPO / "mobile" / "src" / "storage.ts"
IOS_THEME = REPO / "mobile" / "src" / "theme.ts"


def literal(path: "Path", pattern: str, what: str) -> str:
    if not path.is_file():
        broke(f"{path.relative_to(REPO)} is missing, so {what} cannot be read")
    match = re.search(pattern, path.read_text(encoding="utf-8"))
    if match is None:
        broke(f"could not find {what} in {path.relative_to(REPO)}")
    return match.group(1)


def ios_values() -> dict:
    return {
        "iosStorageKey": literal(
            IOS_STORAGE,
            r"export const STORAGE_KEY\s*=\s*['\"]([^'\"]+)['\"]",
            "STORAGE_KEY",
        ),
        "iosTap": int(
            literal(IOS_THEME, r"export const TAP\s*=\s*(\d+)", "TAP")
        ),
    }


def broke(message: str) -> "None":
    print(f"audit_docs: could not run the audit: {message}", file=sys.stderr)
    raise SystemExit(2)


def run_engine() -> dict:
    """Bundle the pure engine with esbuild and execute it under node."""
    if not ESBUILD.is_file():
        broke(f"esbuild not found at {ESBUILD} - run `npm install` first")
    node = shutil.which("node")
    if node is None:
        broke("`node` is not on PATH")

    with tempfile.TemporaryDirectory(prefix="mathmon-audit-docs-") as tmp:
        work = Path(tmp)
        entry = work / "harness.mjs"
        bundle = work / "bundle.mjs"
        entry.write_text(HARNESS, encoding="utf-8")

        build = subprocess.run(
            [
                str(ESBUILD),
                str(entry),
                "--bundle",
                "--platform=node",
                "--format=esm",
                "--log-level=warning",
                f"--alias:@engine={REPO / 'src' / 'lib' / 'game'}",
                f"--alias:@={REPO / 'src'}",
                f"--outfile={bundle}",
            ],
            cwd=str(REPO),
            capture_output=True,
            text=True,
        )
        if build.returncode != 0:
            broke(f"esbuild exited {build.returncode}\n{build.stderr.strip()}")

        run = subprocess.run(
            [node, str(bundle)], cwd=str(REPO), capture_output=True, text=True
        )
        if run.returncode != 0:
            broke(f"engine harness exited {run.returncode}\n{run.stderr.strip()}")

        try:
            return {**json.loads(run.stdout), **ios_values()}
        except json.JSONDecodeError as error:
            broke(f"harness printed something that is not JSON: {error}")
            raise


# --------------------------------------------------------------------------
# Route 2: parse source that cannot be executed here.
# --------------------------------------------------------------------------
def read(path: Path) -> str:
    if not path.is_file():
        broke(f"{path.relative_to(REPO)} is missing")
    return path.read_text(encoding="utf-8")


def web_tap_px() -> float:
    """The `tap` utility's floor, in px, read out of globals.css.

    Tailwind v4 `@utility` blocks are plain CSS, so this is a regex rather than
    a bundle. `min-height` and `min-width` must agree - a 56px-tall button that
    is 32px wide is still a miss for a seven-year-old.
    """
    css = read(GLOBALS_CSS)
    block = re.search(r"@utility\s+tap\s*\{(?P<body>[^}]*)\}", css)
    if block is None:
        broke(f"no `@utility tap` block in {GLOBALS_CSS.relative_to(REPO)}")

    sizes = {}
    for prop in ("min-height", "min-width"):
        found = re.search(
            rf"{prop}\s*:\s*(?P<value>[\d.]+)(?P<unit>rem|px)\s*;", block.group("body")
        )
        if found is None:
            broke(f"`@utility tap` has no {prop}")
        value = float(found.group("value"))
        # 1rem = 16px is the browser default and what Tailwind's scale assumes.
        sizes[prop] = value * 16 if found.group("unit") == "rem" else value

    if sizes["min-height"] != sizes["min-width"]:
        broke(
            "`@utility tap` is not square: "
            f"min-height {sizes['min-height']}px vs min-width {sizes['min-width']}px"
        )
    return sizes["min-height"]


def ios_screens() -> tuple[int, int, list[str]]:
    """(screens the router can show, arms in the `Screen` union, their names).

    The two numbers differ by one on purpose and both are reported. `Screen` is
    the union the `switch` dispatches on, but `Onboarding` is returned *before*
    the switch - it is what the app shows when there is no save, so it is a
    screen the router renders without being a routable destination. Counting
    only the union would report six and force "Seven screens" to be rewritten
    into something less true than it is now.
    """
    source = read(MOBILE_APP)

    union = re.search(r"type\s+Screen\s*=\s*(?P<body>(?:\s*\|\s*\{[^}]*\})+)\s*;", source)
    if union is None:
        broke(f"no `type Screen = ...` union in {MOBILE_APP.relative_to(REPO)}")
    arms = sorted(re.findall(r"name:\s*'([^']+)'", union.group("body")))
    if not arms:
        broke("the `Screen` union has no `name:` arms")

    # Screen components imported from ./src/screens/ and actually rendered as
    # JSX in this file. An import that is never rendered is not a screen.
    imported = re.findall(
        r"import\s*\{\s*(?P<name>\w+)\s*\}\s*from\s*'\./src/screens/[^']+'", source
    )
    rendered = sorted({name for name in imported if re.search(rf"<{name}[\s/>]", source)})
    if not rendered:
        broke("no screen component from ./src/screens/ is rendered in App.tsx")

    return len(rendered), len(arms), rendered


def package_scripts(path: Path) -> dict[str, str]:
    try:
        return dict(json.loads(read(path)).get("scripts", {}))
    except json.JSONDecodeError as error:
        broke(f"{path.relative_to(REPO)} is not valid JSON: {error}")
        raise


def package_major(path: Path, name: str) -> int | None:
    """Major version of a dependency, e.g. `^16.3.0` -> 16."""
    data = json.loads(read(path))
    for section in ("dependencies", "devDependencies"):
        spec = data.get(section, {}).get(name)
        if spec:
            found = re.search(r"(\d+)", spec)
            if found:
                return int(found.group(1))
    return None


# --------------------------------------------------------------------------
# Claims.
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class Finding:
    doc: str
    line: int
    claim: str
    expected: str
    actual: str
    note: str = ""

    def sort_key(self) -> tuple:
        return (self.doc, self.line, self.claim)

    def render(self) -> str:
        where = f"{self.doc}:{self.line}"
        text = f"  {where:<22} {self.claim:<34} expected {self.expected}  vs  {self.actual}"
        if self.note:
            text += f"\n  {'':<22} {self.note}"
        return text


@dataclass(frozen=True)
class Claim:
    """One documented fact, and how to find it and what it must equal.

    `patterns` are searched in every document named by `docs`. Each pattern
    must contain named groups; every named group's captured number is compared
    against the same-named entry in `expect`. `{NUM}` expands to the
    digits-or-number-word alternation.

    `min_matches` defaults to 1: a claim whose patterns match nothing anywhere
    is itself a failure, because a claim that cannot be found can never fail.
    Set it to 0 only for a claim that is genuinely optional in prose - and then
    say why in `note`.
    """

    key: str
    source: str
    patterns: tuple[str, ...]
    docs: tuple[str, ...] = DOCS
    min_matches: int = 1
    note: str = ""


def build_claims(v: dict, web_tap: float, screens: int, arms: int) -> list[Claim]:
    """Every claim, with its expected value derived from `v` and friends."""
    return [
        Claim(
            key="creature roster size",
            source="len(CREATURES) in src/lib/game/creatures.ts",
            patterns=(
                rf"(?P<n>{NUM})[-\s]creature\b",
                rf"\b(?P<n>{NUM}) creatures?\b",
            ),
        ),
        Claim(
            key="evolution lines",
            source="distinct lineId in src/lib/game/creatures.ts",
            patterns=(
                rf"(?P<n>{NUM}) evolution lines\b",
                rf"\((?P<n>{NUM}) lines\)",
            ),
        ),
        Claim(
            key="lines per element",
            source="lineIds per element in src/lib/game/creatures.ts",
            patterns=(
                rf"\b(?P<n>{NUM}) per element\b",
                rf"\b(?P<n>{NUM}) lines share each element\b",
            ),
        ),
        Claim(
            key="elements on the wheel",
            source="len(ELEMENTS) in src/lib/game/elements.ts",
            patterns=(rf"(?P<n>{NUM})[-\s]element wheel\b",),
        ),
        Claim(
            key="starters",
            source="starters() in src/lib/game/creatures.ts",
            patterns=(rf"\b(?P<n>{NUM}) starters\b",),
        ),
        Claim(
            key="starter matchups swept",
            source="starters() squared, per src/lib/game/battle.test.ts",
            patterns=(
                rf"\b(?P<n>{NUM}) starter matchups\b",
                rf"sweeps all (?P<n>{NUM}) matchups\b",
            ),
        ),
        Claim(
            key="moves per creature",
            source="len(movesFor(element)) in src/lib/game/moves.ts",
            patterns=(
                rf"\b(?P<n>{NUM}) moves every turn\b",
                rf"\b(?P<n>{NUM})[-\s]slot move kit\b",
                rf"\b(?P<n>{NUM})[-\s]move kit\b",
            ),
        ),
        Claim(
            key="maths tiers",
            source="MAX_TIER in src/lib/game/math.ts",
            patterns=(rf"\b(?P<n>{NUM}) tiers\b",),
        ),
        Claim(
            key="adaptive window",
            source="ADAPT_WINDOW in src/lib/game/math.ts",
            patterns=(
                rf"last (?P<n>{NUM}) answers\b",
                rf"\b(?P<n>{NUM})-attempt window\b",
            ),
        ),
        Claim(
            key="badges",
            source="len(BADGES) in src/lib/game/progress.ts",
            patterns=(rf"\b(?P<n>{NUM}) badges\b",),
        ),
        Claim(
            key="evolution levels",
            source="EVOLVE_AT in src/lib/game/progress.ts",
            patterns=(rf"evolution at levels (?P<a>{NUM}) and (?P<b>{NUM})\b",),
        ),
        Claim(
            key="max trainer level",
            source="MAX_LEVEL in src/lib/game/progress.ts",
            patterns=(
                rf"max(?:imum)? (?:trainer )?level (?:of |is )?(?P<n>{NUM})\b",
                rf"level cap (?:of |is )?(?P<n>{NUM})\b",
                rf"levels? 1(?:-|–|—| to )(?P<n>{NUM})\b",
            ),
            min_matches=0,
            note=(
                "no document states a level cap today; the pattern is here so that "
                "one added later is checked from the first day rather than the "
                "first time it drifts."
            ),
        ),
        Claim(
            key="evolution line depth",
            source="creatures per lineId in src/lib/game/creatures.ts",
            patterns=(
                rf"\b(?P<n>{NUM}) stages per line\b",
                rf"\b(?P<n>{NUM})-stage lines?\b",
            ),
            min_matches=0,
            note=(
                "the depth is not written as a number in prose; it is still "
                "verified as a code invariant (every line has the same depth)."
            ),
        ),
        Claim(
            key="element multiplier sum",
            source="effectiveness() summed over ELEMENTS",
            patterns=(rf"sum to exactly (?P<n>{NUM})\b",),
        ),
        Claim(
            key="minimum tap target",
            source="@utility tap in globals.css and TAP in mobile/src/theme.ts",
            patterns=(rf"at least (?P<n>{NUM})px\b",),
        ),
        Claim(
            key="iOS screens",
            source="mobile/App.tsx router",
            patterns=(rf"\b(?P<n>{NUM}) screens\b",),
        ),
        Claim(
            key="Expo SDK major",
            source="expo in mobile/package.json",
            patterns=(r"Expo SDK (?P<n>\d+)",),
        ),
        Claim(
            key="Next.js major",
            source="next in package.json",
            patterns=(r"Next\.js (?P<n>\d+)",),
        ),
        Claim(
            key="React major",
            source="react in package.json",
            patterns=(r"React (?P<n>\d+)",),
        ),
    ]


def expectations(v: dict, web_tap: float, screens: int, arms: int) -> dict[str, dict]:
    """Expected value per claim key, per named group. All derived, none typed."""
    return {
        "creature roster size": {"n": v["creatures"]},
        "evolution lines": {"n": v["lines"]},
        "lines per element": {"n": single(v["linesPerElement"], "lines per element")},
        "elements on the wheel": {"n": v["elements"]},
        "starters": {"n": v["starters"]},
        "starter matchups swept": {"n": v["starters"] ** 2},
        "moves per creature": {"n": single(v["moveCounts"], "moves per element")},
        "maths tiers": {"n": v["maxTier"]},
        "adaptive window": {"n": v["adaptWindow"]},
        "badges": {"n": v["badges"]},
        "evolution levels": {"a": v["evolveAt"][0], "b": v["evolveAt"][1]},
        "max trainer level": {"n": v["maxLevel"]},
        "evolution line depth": {"n": single(v["lineDepths"], "line depth")},
        "element multiplier sum": {
            "n": int(single(v["outgoingSums"], "outgoing multiplier sum"))
        },
        "minimum tap target": {"n": int(web_tap)},
        "iOS screens": {"n": screens},
        "Expo SDK major": {"n": package_major(MOBILE_PKG, "expo")},
        "Next.js major": {"n": package_major(ROOT_PKG, "next")},
        "React major": {"n": package_major(ROOT_PKG, "react")},
    }


def single(values: list, what: str):
    """Collapse a derived set that must have exactly one member.

    A roster where one line has four stages, or an element whose kit has three
    moves, makes the documented singular number meaningless. That is a finding
    about the code, not the docs, so it stops the audit rather than being
    rounded away.
    """
    if len(values) != 1:
        broke(f"{what} is not uniform across the roster: {values}")
    return values[0]


# --------------------------------------------------------------------------
# npm scripts named in the documents.
# --------------------------------------------------------------------------
HEADING = re.compile(r"^#{1,6}\s+(?P<text>.+)$")
FENCE = re.compile(r"^\s*```")
NPM_RUN = re.compile(r"\bnpm run (?P<script>[a-z][a-z0-9:_-]*)")
NPM_TEST = re.compile(r"\bnpm test\b")


def documented_scripts(doc: str, text: str) -> list[tuple[int, str, str]]:
    """(line, script, which package.json it should exist in) for every mention.

    Which package a mention belongs to is decided by context, deterministically:
    everything in mobile/README.md is the mobile package; elsewhere, a `cd
    mobile` earlier in the same fenced block, or a heading mentioning iOS or
    mobile, switches the target. `CLAUDE.md` relies on both - its iOS block
    lives under an "### iOS" heading and opens with `cd mobile`.
    """
    found: list[tuple[int, str, str]] = []
    heading_is_mobile = False
    in_fence = False
    fence_is_mobile = False

    for number, line in enumerate(text.splitlines(), start=1):
        if FENCE.match(line):
            in_fence = not in_fence
            if in_fence:
                fence_is_mobile = False
            continue
        if not in_fence:
            head = HEADING.match(line)
            if head:
                heading_is_mobile = bool(
                    re.search(r"\bios\b|\bmobile\b", head.group("text"), re.IGNORECASE)
                )
        if re.search(r"\bcd\s+mobile\b", line):
            fence_is_mobile = True

        mobile = doc == "mobile/README.md" or heading_is_mobile or fence_is_mobile
        target = "mobile/package.json" if mobile else "package.json"

        for match in NPM_RUN.finditer(line):
            found.append((number, match.group("script"), target))
        if NPM_TEST.search(line):
            found.append((number, "test", target))

    return found


# --------------------------------------------------------------------------
# Claims this script deliberately does not check.
# --------------------------------------------------------------------------
UNCHECKED = [
    (
        "README.md",
        '"192 unit tests", "44 E2E tests", "+18 Postgres", "+8 signed-in"',
        "Counting these statically is wrong: battle.test.ts generates cases in "
        "loops, so `it(` occurrences are not test cases. Counting them "
        "dynamically means running the suites, which makes the audit slow and - "
        "for the Postgres and signed-in counts - dependent on whether a database "
        "is attached. A number that changes with the environment cannot be a "
        "deterministic assertion. CI runs the suites themselves.",
    ),
    (
        "CLAUDE.md",
        '"finishes at roughly 39% health versus 85%"',
        "This is a balance measurement, not a constant. It is already produced "
        "and enforced by scripts/balance_report.py, which fails if any matchup "
        "stops being winnable. Duplicating the simulation here would double the "
        "runtime to re-derive a number another script owns.",
    ),
    (
        "README.md",
        '"about 60 KB of TypeScript"',
        "scripts/audit_assets.py already prints the size census this sentence "
        "quotes. Asserting an 'about' figure would need a tolerance this script "
        "would have to invent, and inventing the spec is how an audit starts "
        "lying.",
    ),
    (
        "CLAUDE.md / mobile/README.md",
        '"~40-line renderer" / "the same forty lines"',
        "src/components/CreatureArt.tsx is 142 lines and "
        "mobile/src/ui/CreatureArt.tsx is 130, so the claim is about the "
        "shape-mapping switch rather than the file. Where that boundary falls is "
        "a judgement, and encoding one here would assert a spec nobody wrote. "
        "Flagged for a human, not machine-checked.",
    ),
    (
        "mobile/README.md",
        '"swift-tools-version 6.2", "Xcode 26", "macos-26"',
        "These describe Apple and GitHub runner images, not this repository. "
        "Nothing in the tree can be the source of truth for them; the ios.yml "
        "job is where they are actually exercised.",
    ),
    (
        "all three",
        "prose properties: 'a wrong answer deals flat chip damage', 'the "
        "opponent never attacks on turn one', 'losing still awards XP', "
        "'normaliseProfile repairs anything'",
        "These are behavioural claims, and each is already guarded by a unit "
        "test that would fail if it stopped holding. Re-asserting behaviour from "
        "a doc-audit script would be a worse copy of battle.test.ts and "
        "progress.test.ts.",
    ),
]


# --------------------------------------------------------------------------
# Verification.
# --------------------------------------------------------------------------
def line_of(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def check_claims(
    claims: list[Claim], expect: dict[str, dict], sources: dict[str, str]
) -> tuple[list[Finding], dict[str, int]]:
    findings: list[Finding] = []
    counts: dict[str, int] = {}

    for claim in claims:
        wanted = expect[claim.key]
        matched = 0
        for doc in claim.docs:
            text = sources[doc]
            for pattern in claim.patterns:
                for match in re.finditer(pattern, text, re.IGNORECASE):
                    matched += 1
                    line = line_of(text, match.start())
                    for group, value in wanted.items():
                        if group not in match.groupdict():
                            continue
                        raw = match.group(group)
                        seen = as_number(raw)
                        if value is None:
                            findings.append(
                                Finding(
                                    doc,
                                    line,
                                    claim.key,
                                    "a value from the source",
                                    f"could not read it from {claim.source}",
                                )
                            )
                        elif seen != value:
                            findings.append(
                                Finding(
                                    doc,
                                    line,
                                    claim.key,
                                    f"{value} ({claim.source})",
                                    f"{raw!r} in {match.group(0).strip()!r}",
                                )
                            )
        counts[claim.key] = matched
        if matched < claim.min_matches:
            findings.append(
                Finding(
                    " / ".join(claim.docs),
                    0,
                    claim.key,
                    f"at least {claim.min_matches} mention",
                    "no text matched this claim's patterns",
                    note=(
                        "A claim that matches nothing can never fail. Reword the "
                        "pattern if the sentence moved, or delete the claim if the "
                        "sentence is gone."
                    ),
                )
            )

    return findings, counts


def check_scripts(sources: dict[str, str]) -> list[Finding]:
    scripts = {
        "package.json": package_scripts(ROOT_PKG),
        "mobile/package.json": package_scripts(MOBILE_PKG),
    }
    findings: list[Finding] = []
    for doc in DOCS:
        for line, script, target in documented_scripts(doc, sources[doc]):
            if script not in scripts[target]:
                available = ", ".join(sorted(scripts[target]))
                findings.append(
                    Finding(
                        doc,
                        line,
                        "documented npm script",
                        f"a script named {script!r} in {target}",
                        f"{target} defines: {available}",
                    )
                )
    return findings


def check_storage_key(v: dict, sources: dict[str, str]) -> list[Finding]:
    """Both clients claim to share one save key. Verify they actually do.

    Neither document prints the key itself, and neither should - the value is
    the code's business. What they promise is that the two clients agree, so
    that is what is checked, plus that the promise is still written down.
    """
    findings: list[Finding] = []
    mentions = [
        (doc, line_of(sources[doc], m.start()))
        for doc in DOCS
        for m in re.finditer(r"[Ss]ame key", sources[doc])
    ]
    if not mentions:
        findings.append(
            Finding(
                " / ".join(DOCS),
                0,
                "shared save key",
                "the 'same key' promise to still be documented",
                "no document makes it any more",
            )
        )
    if v["webStorageKey"] != v["iosStorageKey"]:
        for doc, line in mentions or [(DOCS[1], 0)]:
            findings.append(
                Finding(
                    doc,
                    line,
                    "shared save key",
                    f"{v['webStorageKey']!r} (src/lib/storage/client.ts)",
                    f"{v['iosStorageKey']!r} (mobile/src/storage.ts)",
                )
            )
    return findings


def check_tap_parity(v: dict, web_tap: float, sources: dict[str, str]) -> list[Finding]:
    """The two clients must agree on the tap floor the docs quote once."""
    if v["iosTap"] == web_tap:
        return []
    return [
        Finding(
            "CLAUDE.md",
            next(
                (
                    line_of(sources["CLAUDE.md"], m.start())
                    for m in re.finditer(r"at least \d+px", sources["CLAUDE.md"])
                ),
                0,
            ),
            "tap target parity",
            f"{web_tap:g}px (@utility tap in globals.css)",
            f"TAP = {v['iosTap']} in mobile/src/theme.ts",
        )
    ]


def print_values(v: dict, web_tap: float, screens: int, arms: int, names: list[str]) -> None:
    rows = [
        ("creatures", v["creatures"], "len(CREATURES)"),
        ("evolution lines", v["lines"], "distinct lineId"),
        ("stages per line", single(v["lineDepths"], "line depth"), "creatures per lineId"),
        ("lines per element", single(v["linesPerElement"], "lines/element"), "derived"),
        ("LINES_PER_ELEMENT", v["linesPerElementConstant"], "creatures.ts constant"),
        ("starters", v["starters"], "starters()"),
        ("starter matchups", v["starters"] ** 2, "starters squared"),
        ("elements", v["elements"], "len(ELEMENTS)"),
        ("outgoing multiplier sums", v["outgoingSums"], "effectiveness() over the wheel"),
        ("incoming multiplier sums", v["incomingSums"], "effectiveness() over the wheel"),
        ("moves per creature", v["moveCounts"], "movesFor(element)"),
        ("maths tiers", f"{v['minTier']}..{v['maxTier']}", "MIN_TIER..MAX_TIER"),
        ("maths skills", v["skills"], "len(SKILLS)"),
        ("adaptive window", v["adaptWindow"], "ADAPT_WINDOW"),
        ("max trainer level", v["maxLevel"], "MAX_LEVEL"),
        ("evolution levels", v["evolveAt"], "EVOLVE_AT"),
        ("badges", v["badges"], "len(BADGES)"),
        ("web save key", v["webStorageKey"], "src/lib/storage/client.ts"),
        ("iOS save key", v["iosStorageKey"], "mobile/src/storage.ts"),
        ("web tap floor", f"{web_tap:g}px", "@utility tap in globals.css"),
        ("iOS tap floor", f"{v['iosTap']}px", "TAP in mobile/src/theme.ts"),
        ("iOS screens rendered", screens, ", ".join(names)),
        ("iOS Screen union arms", arms, "type Screen in mobile/App.tsx"),
        ("next major", package_major(ROOT_PKG, "next"), "package.json"),
        ("react major", package_major(ROOT_PKG, "react"), "package.json"),
        ("expo major", package_major(MOBILE_PKG, "expo"), "mobile/package.json"),
    ]
    width = max(len(name) for name, _, _ in rows)
    print("Derived values (every one read from the source, none typed here)")
    print("-" * 78)
    for name, value, origin in rows:
        print(f"  {name.ljust(width)}  {str(value):<26}  {origin}")


def print_unchecked() -> None:
    print("Claims this audit deliberately does not check")
    print("-" * 78)
    for where, what, why in UNCHECKED:
        print(f"  {where}")
        print(f"    {what}")
        for line in _wrap(why, 72):
            print(f"      {line}")
        print()


def _wrap(text: str, width: int) -> list[str]:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        if current and len(current) + 1 + len(word) > width:
            lines.append(current)
            current = word
        else:
            current = f"{current} {word}".strip()
    if current:
        lines.append(current)
    return lines


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument(
        "--values", action="store_true", help="print every derived value and exit"
    )
    parser.add_argument(
        "--unchecked", action="store_true", help="print what this audit does not check"
    )
    args = parser.parse_args()

    if args.unchecked:
        print_unchecked()
        return 0

    sources = {doc: read(REPO / doc) for doc in DOCS}
    values = run_engine()
    tap = web_tap_px()
    screens, arms, names = ios_screens()

    if args.values:
        print_values(values, tap, screens, arms, names)
        return 0

    claims = build_claims(values, tap, screens, arms)
    expect = expectations(values, tap, screens, arms)
    findings, counts = check_claims(claims, expect, sources)
    findings += check_scripts(sources)
    findings += check_storage_key(values, sources)
    findings += check_tap_parity(values, tap, sources)

    findings = sorted(set(findings), key=Finding.sort_key)

    checked = sum(counts.values())
    print("Mathmon documentation audit")
    print("===========================")
    print(f"documents: {', '.join(DOCS)}")
    print(f"claims declared: {len(claims)}   mentions found and checked: {checked}")
    print(f"npm script mentions checked: {sum(len(documented_scripts(d, sources[d])) for d in DOCS)}")
    print(f"not machine-checked (see --unchecked): {len(UNCHECKED)} groups")
    print()

    for claim in sorted(claims, key=lambda c: c.key):
        found = counts[claim.key]
        mark = "ok " if found >= claim.min_matches else "MISSING"
        detail = f"{found} mention{'' if found == 1 else 's'}"
        if found == 0 and claim.min_matches == 0:
            detail += " (not stated in prose)"
        print(f"  {mark:<8} {claim.key:<26} {detail:<28} <- {claim.source}")

    print()
    if findings:
        print(f"FAIL: {len(findings)} claim(s) disagree with the source")
        print()
        for finding in findings:
            print(finding.render())
        print()
        print("The code is the source of truth. Fix the document - unless the claim")
        print("describes an intended property the code violates, in which case fix the")
        print("code and say so loudly.")
        return 1

    print("OK: every documented claim matches the source.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
