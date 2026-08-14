#!/usr/bin/env python3
"""
Verify that the bilingual promise in CLAUDE.md is actually kept by the source.

Why this exists
---------------
`CLAUDE.md` says it plainly: "Both languages are first-class. Any new
user-facing string goes in `src/lib/i18n.ts` with `en` and `zh`, and any new
creature or badge needs both names. The types enforce this."

The types enforce the *shape*. `Phrase = { en: string; zh: string }` makes a
missing key a compile error, and that is where the guarantee stops. Three
things it cannot see:

  * `{ en: 'Take your time', zh: 'Take your time' }` type-checks perfectly. So
    does `zh: ''`. An untranslated string is a well-typed string.
  * `<button aria-label="Backspace">` type-checks, renders, and ships an
    English word to a child playing in Chinese. Nothing routes it through
    `t()`, and nothing complains.
  * A `StringKey` nobody references still type-checks. It is a translation that
    is never shown, so nobody ever notices when it goes stale, and the next
    person to read the table believes it is live.

The player is seven and bilingual. A screen that half-translates is worse than
one that does not translate at all: he can read both, so a stray English word
in a Chinese sentence is just a thing that looks broken.

What it checks
--------------
  translation-complete   every `{ en, zh }` pair - in `STRINGS` and in the game
                         data (creatures, badges, moves, skills, elements) -
                         has both halves, and neither is blank.
  translation-distinct   the two halves differ. `zh` equal to `en` is the exact
                         shape an untranslated string takes: it type-checks, it
                         renders, and it is invisible in review.
  hardcoded-text         no JSX text node in the scanned clients is a bare
                         literal with words in it.
  hardcoded-attribute    no user-visible attribute (`aria-label`, `placeholder`,
                         `title`, `alt`, `label`, `accessibilityLabel`, …) is a
                         bare literal with words in it - including a literal
                         hiding inside the expression, as in the
                         `aria-label={label ?? 'Health'}` this found.
  fixed-language-read    no client component reads a `Phrase` through `.en` or
                         `.zh`. `creature.name.en` is not a missing
                         translation - it is a present one, deliberately not
                         used. Four of these were live, all on accessible
                         names, so a child using the app in Chinese with a
                         screen reader heard English creature names.
  inline-translation     no pair of literals is translated at the call site
                         (`language === 'zh' ? '…' : '…'`) instead of in
                         `STRINGS`. Both languages are present, so nothing looks
                         broken on screen - which is why this one rots quietly:
                         the string is real, shipped, and outside the one table
                         a translator reads.
  unused-key             every `StringKey` is referenced by non-test source.
  missing-key            everything referenced as a key exists in `STRINGS`.

Where the facts come from
-------------------------
The phrases are *executed*, not parsed: the harness below imports `STRINGS` and
the game data and walks them, exactly as `scripts/audit_docs.py` runs the
engine. That matters because several phrase tables are computed - `movesFor()`
builds a kit per element rather than writing one out - and a regex over the
source would silently check only the ones that happen to be literals.

Everything else is read as plain text. In particular the iOS screens are only
ever *read*: the root CI job does not install `mobile/node_modules`, so a root
script that bundles anything under `mobile/` passes on a developer machine and
fails in CI. That trap has been sprung twice in this repository already.

What static analysis can and cannot prove
-----------------------------------------
Same discipline as `scripts/audit_a11y.py`. A bare literal in a text node or a
user-visible attribute is a provable violation and fails the build. A string
assembled at runtime, or handed down as a prop, is not judged - guessing would
produce false alarms, and an audit people learn to ignore enforces nothing.

The allowlist is deliberately narrow and is spelled out in `is_wordy()`: text
with no two-letter run of alphabetic characters is not translatable material.
That covers the keypad's digits, `⌫`, `→`, `−`/`+`, `×2`, `·`, `%` and every
emoji in the UI. It does *not* cover "Lv", "MAX" or "Backspace", all of which
this script found on its first run. Widening it is how a checker stops
checking, so anything skipped on purpose belongs in UNCHECKED below, with the
reason, where `--unchecked` prints it.

Usage
-----
    python3 scripts/audit_i18n.py              # verify
    python3 scripts/audit_i18n.py --phrases    # dump every phrase it derived
    python3 scripts/audit_i18n.py --unchecked  # list what this does not check

Exit status
-----------
0  every property holds.
1  at least one property is violated; each finding names the property it broke.
2  the audit itself could not run (no esbuild, no node, missing file). A
   failure to measure is never reported as a pass.

Determinism
-----------
Standard library only. No clock, no randomness, no environment lookups beyond
locating node. Findings are sorted, so two runs on the same tree print
byte-identical output.

The JSX scanner is imported from `audit_a11y.py` rather than copied. It is the
same problem - "where does this tag end, and what are its direct children" -
and a second copy would drift from the one that is already exercised daily.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from audit_a11y import attr_raw, direct_children, find_close, find_tag_end
except ImportError as error:  # pragma: no cover - only when a file is missing
    print(f"audit_i18n: cannot import the JSX scanner from audit_a11y.py: {error}", file=sys.stderr)
    raise SystemExit(2)

REPO = Path(__file__).resolve().parent.parent
ESBUILD = REPO / "node_modules" / ".bin" / "esbuild"
I18N = REPO / "src" / "lib" / "i18n.ts"


def broke(message: str) -> None:
    print(f"audit_i18n: could not run the audit: {message}", file=sys.stderr)
    raise SystemExit(2)


# --------------------------------------------------------------------------
# Which files are scanned.
#
# The web client is the subject of the CLAUDE.md rule. The iOS screens are
# included because they render the same STRINGS table through the same `tr`,
# so a literal there is the identical bug - and reading a .tsx file as text
# costs nothing and touches no mobile dependency.
# --------------------------------------------------------------------------
SCAN_ROOTS = (
    ("web", Path("src") / "components"),
    ("web", Path("src") / "app"),
    ("ios", Path("mobile") / "src" / "screens"),
    ("ios", Path("mobile") / "src" / "ui"),
)
SCAN_FILES = (("ios", Path("mobile") / "App.tsx"),)

# Files searched for key references. Tests are excluded on purpose: a key that
# only a test mentions is still a string no child ever sees.
REFERENCE_ROOTS = (Path("src"), Path("mobile") / "src")
REFERENCE_FILES = (Path("mobile") / "App.tsx",)

# Attributes whose value a player reads or hears. `title` and `alt` are here
# even though the app currently uses neither with a literal - the point of an
# audit is to be waiting when someone does.
#
# `label`, `submitLabel` and `clearLabel` are props of this repository's own
# components (`Stat`, `ElementChip`, `Keypad`, the iOS `Button`), and every one
# of them ends up as visible text. `testID`/`data-testid` deliberately are not
# here: a test hook is not user-facing, and demanding a translation for one
# would be the checker inventing a rule nobody wrote.
VISIBLE_ATTRS = (
    "aria-label",
    "accessibilityLabel",
    "accessibilityHint",
    "alt",
    "clearLabel",
    "label",
    "placeholder",
    "submitLabel",
    "title",
)


# --------------------------------------------------------------------------
# Route 1: execute the real tables.
# --------------------------------------------------------------------------
# Nothing here restates a phrase. The harness walks whatever the modules
# actually export, so a new creature, badge, move or skill is covered the day
# it lands rather than the day someone remembers to add it to a list.
HARNESS = r"""
import { STRINGS } from '@/lib/i18n';
import { CREATURES } from '@engine/creatures';
import { ELEMENTS, ELEMENT_STYLE, NOT_VERY_EFFECTIVE, NEUTRAL, SUPER_EFFECTIVE, effectivenessLabel } from '@engine/elements';
import { SKILL_META } from '@engine/math';
import { movesFor } from '@engine/moves';
import { BADGES } from '@engine/progress';

/**
 * Collect every `{ en, zh }` pair reachable from a value, with the path that
 * leads to it. Recursive rather than hand-listed, so a phrase nested inside a
 * new field is found without this file being touched.
 */
function collect(value, path, out) {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collect(item, `${path}[${index}]`, out));
    return;
  }
  const keys = Object.keys(value).sort();
  if (keys.length === 2 && keys[0] === 'en' && keys[1] === 'zh') {
    out.push({ path, en: value.en, zh: value.zh });
    return;
  }
  for (const key of keys) collect(value[key], `${path}.${key}`, out);
}

const strings = {};
for (const key of Object.keys(STRINGS)) strings[key] = STRINGS[key];

const phrases = [];
collect(CREATURES, 'CREATURES', phrases);
collect(BADGES, 'BADGES', phrases);
collect(ELEMENT_STYLE, 'ELEMENT_STYLE', phrases);
collect(SKILL_META, 'SKILL_META', phrases);
for (const element of ELEMENTS) collect(movesFor(element), `movesFor('${element}')`, phrases);
// Not a table: three branches of a function, one of which returns null.
for (const multiplier of [SUPER_EFFECTIVE, NEUTRAL, NOT_VERY_EFFECTIVE]) {
  collect(effectivenessLabel(multiplier), `effectivenessLabel(${multiplier})`, phrases);
}

process.stdout.write(JSON.stringify({ strings, phrases }));
"""


def run_harness() -> dict:
    """Bundle the pure engine plus `i18n.ts` with esbuild and run it under node."""
    if not ESBUILD.is_file():
        broke(f"esbuild not found at {ESBUILD} - run `npm install` first")
    node = shutil.which("node")
    if node is None:
        broke("`node` is not on PATH")

    with tempfile.TemporaryDirectory(prefix="mathmon-audit-i18n-") as tmp:
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

        run = subprocess.run([node, str(bundle)], cwd=str(REPO), capture_output=True, text=True)
        if run.returncode != 0:
            broke(f"phrase harness exited {run.returncode}\n{run.stderr.strip()}")

        try:
            return json.loads(run.stdout)
        except json.JSONDecodeError as error:
            broke(f"harness printed something that is not JSON: {error}")
            raise


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

    def fail(self, path: str, line: int, check: str, detail: str) -> None:
        self.violations.append(Finding(path, line, check, detail))

    def note(self, path: str, line: int, check: str, detail: str) -> None:
        self.review.append(Finding(path, line, check, detail))


# --------------------------------------------------------------------------
# Property 1 and 2: the phrase tables themselves.
# --------------------------------------------------------------------------
def line_of_key(source: str, key: str) -> int:
    """The line in i18n.ts where a STRINGS key is declared, for the report."""
    match = re.search(rf"^\s*{re.escape(key)}\s*:", source, re.M)
    return source.count("\n", 0, match.start()) + 1 if match else 0


def check_phrases(data: dict, i18n_source: str, report: Report) -> int:
    """Both halves present, non-blank and different, for every pair found."""
    pairs: list[tuple[str, int, str, str, str]] = []

    for key in sorted(data["strings"]):
        phrase = data["strings"][key]
        pairs.append(
            (
                "src/lib/i18n.ts",
                line_of_key(i18n_source, key),
                f"STRINGS.{key}",
                phrase.get("en"),
                phrase.get("zh"),
            )
        )
    for phrase in sorted(data["phrases"], key=lambda p: p["path"]):
        # Game data is spread across several modules and reached through
        # computed paths, so the phrase's path is the useful locator, not a
        # line number this script would have to guess at.
        pairs.append(("src/lib/game/", 0, phrase["path"], phrase.get("en"), phrase.get("zh")))

    for path, line, where, en, zh in pairs:
        for language, text in (("en", en), ("zh", zh)):
            if not isinstance(text, str):
                report.fail(
                    path,
                    line,
                    "translation-complete",
                    f"{where} has no {language} translation at all",
                )
            elif not text.strip():
                report.fail(
                    path, line, "translation-complete", f"{where} has an empty {language} string"
                )
        if isinstance(en, str) and isinstance(zh, str) and en.strip() and zh.strip():
            if en.strip() == zh.strip():
                report.fail(
                    path,
                    line,
                    "translation-distinct",
                    f"{where} has zh identical to en ({en!r}) - an untranslated string",
                )

    return len(pairs)


# --------------------------------------------------------------------------
# Properties 3, 4 and 5: literals in the clients.
# --------------------------------------------------------------------------
def is_wordy(text: str) -> bool:
    """
    True when a literal contains translatable words.

    The whole allowlist lives here, and it is one rule rather than a list of
    exceptions: a run of two or more alphabetic characters. That is what a word
    is, in either language - `unicodedata` treats Han characters as letters, so
    a hardcoded Chinese string is caught by the same rule that catches an
    English one.

    Everything the UI legitimately writes as a literal falls out for free
    rather than being named individually:

      digits `0`-`9` and `?` on the keypad, `⌫`, `→`, `←`, `−`, `+`, `·`, `×2`,
      `%`, `???`, every emoji, and single letters such as the `s` suffix on a
      time. None of them contain two letters in a row.

    It is deliberately not a vocabulary list. "Lv", "MAX", "HP", "ATK" and
    "Backspace" all read as fine to an English speaker and all failed this
    check on the first run, which is the point.
    """
    run = 0
    for char in text:
        if unicodedata.category(char).startswith("L"):
            run += 1
            if run >= 2:
                return True
        else:
            run = 0
    return False


def iter_all_elements(src: str):
    """Yield (tag, attrs, inner, inner_start, line) for every JSX element.

    Tag-shaped text that is really a TypeScript generic (`useState<Profile |
    null>`) has no matching close tag, so `find_close` raises and it is skipped.
    That is the whole reason this walks with the scanner instead of a regex.
    """
    for match in re.finditer(r"<([A-Za-z][A-Za-z0-9_.]*)", src):
        tag = match.group(1)
        try:
            end, self_closing = find_tag_end(src, match.start())
            attrs = src[match.end() : end - (2 if self_closing else 1)]
            if self_closing:
                inner, inner_start = "", end
            else:
                close = find_close(src, tag, end)
                inner, inner_start = src[end:close], end
        except ValueError:
            continue
        yield tag, attrs, inner, inner_start, src.count("\n", 0, match.start()) + 1


def check_literals(rel: str, src: str, report: Report) -> tuple[int, int]:
    """Text nodes and user-visible attributes that never reach `t()`."""
    texts = 0
    attributes = 0
    seen: set[tuple[int, str]] = set()

    for tag, attrs, inner, inner_start, line in iter_all_elements(src):
        for child in direct_children(inner):
            if child.kind != "text":
                continue
            offset = inner.find(child.text)
            absolute = inner_start + (offset if offset >= 0 else 0)
            if (absolute, child.text) in seen:
                continue
            seen.add((absolute, child.text))
            texts += 1
            if is_wordy(child.text):
                report.fail(
                    rel,
                    src.count("\n", 0, absolute) + 1,
                    "hardcoded-text",
                    f"<{tag}> renders the literal {child.text!r}; it never reaches t()",
                )

        for name in VISIBLE_ATTRS:
            raw, kind = attr_raw(attrs, name)
            if raw is None:
                continue
            attributes += 1
            if kind == "string" and is_wordy(raw):
                report.fail(
                    rel,
                    line,
                    "hardcoded-attribute",
                    f"<{tag} {name}={raw!r}> is a literal; it never reaches t()",
                )
            elif kind == "expr":
                # A literal inside the braces is still a literal. This is the
                # one place the script looks inside an expression, and it is
                # safe to: whatever an accessible name evaluates to, a player
                # hears it. `aria-label={label ?? 'Health'}` was hiding here.
                for literal in expression_literals(raw):
                    if is_wordy(literal):
                        report.fail(
                            rel,
                            line,
                            "hardcoded-attribute",
                            f"<{tag} {name}={{…}}> can evaluate to the literal "
                            f"{literal!r}; it never reaches t()",
                        )

    return texts, attributes


STRING_LITERAL = re.compile(r"'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\"")

# A StringKey is a string literal too. `label={tr('mathLevel')}` is the
# translated case, not the untranslated one, so the key is removed before
# anything is judged - without this the check reported every correct call site
# in the repository, which is the failure mode where an audit gets muted.
TRANSLATED_CALL = re.compile(r"\b(?:tr|t)\(\s*'[A-Za-z][A-Za-z0-9_]*'")

# A literal being *compared* is a value under test, never text on screen:
# `label={mode === 'register' ? tr('createAccount') : tr('signIn')}` is fully
# translated, and 'register' is a discriminant.
COMPARED_LITERAL = re.compile(r"(?:===|!==|==|!=)\s*(?:'[^'\n]*'|\"[^\"\n]*\")")


def expression_literals(expr: str) -> list[str]:
    """Every static string in a JSX expression, template chunks included."""
    expr = TRANSLATED_CALL.sub("tr(", expr)
    expr = COMPARED_LITERAL.sub("== 0", expr)
    out = [m.group(1) if m.group(1) is not None else m.group(2) for m in STRING_LITERAL.finditer(expr)]
    for m in re.finditer(r"`([^`]*)`", expr):
        out.extend(re.split(r"\$\{[^}]*\}", m.group(1)))
    return out


# Reading one half of a `{ en, zh }` pair by name. The type system is perfectly
# happy: `.en` is a string, and a string is what the attribute wanted.
#
# Only the presentation layer is scanned. The engine and the tests legitimately
# name a language - `progress.ts` normalises `settings.language`, and the art
# gallery harness labels its figures in English on purpose.
FIXED_LANGUAGE = re.compile(r"\.\s*(?P<half>en|zh)(?![A-Za-z0-9_$])")


def check_fixed_language(rel: str, src: str, report: Report) -> None:
    for match in FIXED_LANGUAGE.finditer(src):
        start = max(0, match.start() - 60)
        snippet = src[start : match.end()].splitlines()[-1].strip()
        report.fail(
            rel,
            src.count("\n", 0, match.start()) + 1,
            "fixed-language-read",
            f"{snippet!r} reads the {match.group('half')} half directly; "
            "use the player's language",
        )


# A translation written at the call site. Both halves are present, so nothing
# looks wrong on screen - which is exactly why it survives review. Prettier
# breaks these across lines, hence the tolerant whitespace.
LITERAL = r"'(?:[^'\\\n]|\\.)*'|\"(?:[^\"\\\n]|\\.)*\""
INLINE_TRANSLATION = re.compile(
    rf"(?<![A-Za-z0-9_$.])language\s*===\s*'(?:en|zh)'\s*\?\s*(?P<a>{LITERAL})\s*:\s*(?P<b>{LITERAL})"
)


def check_inline_translation(rel: str, src: str, report: Report) -> int:
    found = 0
    for match in INLINE_TRANSLATION.finditer(src):
        a, b = match.group("a")[1:-1], match.group("b")[1:-1]
        if not (is_wordy(a) or is_wordy(b)):
            continue
        found += 1
        report.fail(
            rel,
            src.count("\n", 0, match.start()) + 1,
            "inline-translation",
            f"{a!r} / {b!r} are translated here instead of in STRINGS",
        )
    return found


# --------------------------------------------------------------------------
# Properties 6 and 7: keys referenced, keys defined.
# --------------------------------------------------------------------------
REFERENCE = re.compile(
    r"(?:\btr\(\s*|\bt\(\s*|\bSTRINGS\[\s*)'(?P<quoted>[A-Za-z][A-Za-z0-9_]*)'"
    r"|\bSTRINGS\.(?P<dotted>[A-Za-z][A-Za-z0-9_]*)"
)


def references(sources: dict[str, str]) -> dict[str, list[tuple[str, int]]]:
    """key -> [(file, line)] for every explicit reference in non-test source."""
    out: dict[str, list[tuple[str, int]]] = {}
    for rel in sorted(sources):
        src = sources[rel]
        for match in REFERENCE.finditer(src):
            key = match.group("quoted") or match.group("dotted")
            out.setdefault(key, []).append((rel, src.count("\n", 0, match.start()) + 1))
    return out


def check_keys(
    keys: list[str], sources: dict[str, str], i18n_source: str, report: Report
) -> dict[str, list[tuple[str, int]]]:
    used = references(sources)
    known = set(keys)

    for key in sorted(known - set(used)):
        # A key can also be reached indirectly - `STRINGS[item.key]` over a
        # table of key names, as the nav bar does. That cannot be resolved
        # statically, so the literal is looked for anywhere in the source
        # before calling the key dead. Being wrong in that direction would
        # have this script demand the deletion of a string the app displays.
        quoted = re.compile(rf"'{re.escape(key)}'")
        indirect = sorted(
            (rel, sources[rel].count("\n", 0, m.start()) + 1)
            for rel in sources
            for m in [quoted.search(sources[rel])]
            if m
        )
        if indirect:
            where = ", ".join(f"{rel}:{line}" for rel, line in indirect)
            report.note(
                "src/lib/i18n.ts",
                line_of_key(i18n_source, key),
                "unused-key",
                f"STRINGS.{key} has no direct t()/tr() call; the name does appear at {where}, "
                "so it may be reached through a table of keys",
            )
            continue
        report.fail(
            "src/lib/i18n.ts",
            line_of_key(i18n_source, key),
            "unused-key",
            f"STRINGS.{key} is never referenced; a translation nobody sees rots unnoticed",
        )

    for key in sorted(set(used) - known):
        for rel, line in used[key]:
            report.fail(
                rel,
                line,
                "missing-key",
                f"{key!r} is used as a StringKey but is not in STRINGS",
            )

    return used


# --------------------------------------------------------------------------
# Deliberately not checked.
# --------------------------------------------------------------------------
UNCHECKED = [
    (
        "quality of a translation",
        "Whether `zh` actually means what `en` means. Nothing in a repository "
        "can know that; the strongest machine-checkable proxy is that the two "
        "differ, which is what translation-distinct asserts. A wrong "
        "translation still needs a human who reads both.",
    ),
    (
        "strings built by concatenation",
        "`{tr('evolvesAt')} {level}` is fine, but a sentence assembled from two "
        "translated fragments can be ungrammatical in one language and not the "
        "other. Detecting that needs the meaning of the fragments, which puts "
        "it in the same box as the previous entry.",
    ),
    (
        "literals inside expression containers",
        "`{span > 0 ? `${into}/${span}` : 'MAX'}` puts a literal in a JSX "
        "expression, not a text node. Flagging every string inside every `{…}` "
        "would sweep up ids, class fragments, route paths and test hooks, and "
        "an audit with false alarms is one people stop reading. The one shape "
        "that is unambiguous - a ternary on `language` with a literal on each "
        "side - is checked, as inline-translation.",
    ),
    (
        "src/lib/server/** and the API routes",
        "The API answers with machine-readable error codes ('taken', "
        "'mismatch', 'locked') which the client turns into text. Those are "
        "protocol, not prose, and translating them would be wrong.",
    ),
    (
        "src/app/layout.tsx metadata",
        "`title`, `description` and `<html lang>` are document metadata read by "
        "the browser and the app-install banner, not UI text. Next.js resolves "
        "them on the server, before any profile - and therefore any language "
        "choice - exists. Making them bilingual is a real question, but it is a "
        "product decision about the install experience, not a bug this script "
        "can assert.",
    ),
    (
        "whether a `Phrase` prop reaches the right language",
        "`localise(phrase, language)` and `phrase[language]` are equivalent, "
        "and both are used. Proving that every call site passes the *active* "
        "language rather than a captured one needs dataflow analysis; the unit "
        "tests cover the components that matter.",
    ),
]


# --------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------
def scan_targets() -> list[tuple[str, Path]]:
    """(client, path) for every file the literal checks read. Sorted."""
    out: list[tuple[str, Path]] = []
    for client, root in SCAN_ROOTS:
        base = REPO / root
        if not base.is_dir():
            broke(f"{root} is missing, so it cannot be scanned")
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = sorted(d for d in dirnames if d not in ("node_modules", ".next"))
            for name in sorted(filenames):
                if name.endswith(".tsx") and ".test." not in name and not name.startswith("__"):
                    out.append((client, Path(dirpath) / name))
    for client, path in SCAN_FILES:
        if (REPO / path).is_file():
            out.append((client, REPO / path))
    return sorted(out, key=lambda pair: str(pair[1]))


def reference_sources() -> dict[str, str]:
    """Non-test .ts/.tsx source, keyed by repo-relative path."""
    out: dict[str, str] = {}
    for root in REFERENCE_ROOTS:
        base = REPO / root
        if not base.is_dir():
            broke(f"{root} is missing, so key references cannot be counted")
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = sorted(d for d in dirnames if d not in ("node_modules", ".next"))
            for name in sorted(filenames):
                if not name.endswith((".ts", ".tsx")) or ".test." in name:
                    continue
                path = Path(dirpath) / name
                if path == I18N:
                    continue  # the table itself is a definition, not a use
                out[str(path.relative_to(REPO))] = path.read_text(encoding="utf-8")
    for path in REFERENCE_FILES:
        full = REPO / path
        if full.is_file():
            out[str(path)] = full.read_text(encoding="utf-8")
    return out


def print_phrases(data: dict) -> None:
    rows = [(f"STRINGS.{key}", data["strings"][key]) for key in sorted(data["strings"])]
    rows += [(p["path"], p) for p in sorted(data["phrases"], key=lambda p: p["path"])]
    width = min(max(len(name) for name, _ in rows), 46)
    print(f"Phrases derived by executing the real tables ({len(rows)})")
    print("-" * 78)
    for name, phrase in rows:
        print(f"  {name.ljust(width)}  {phrase.get('en')!r}  /  {phrase.get('zh')!r}")


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
    parser = argparse.ArgumentParser(description="Audit the bilingual promise.")
    parser.add_argument("--phrases", action="store_true", help="dump every derived phrase and exit")
    parser.add_argument(
        "--unchecked", action="store_true", help="print what this audit does not check"
    )
    args = parser.parse_args()

    if args.unchecked:
        print_unchecked()
        return 0

    if not I18N.is_file():
        broke("src/lib/i18n.ts is missing")
    i18n_source = I18N.read_text(encoding="utf-8")

    data = run_harness()
    if args.phrases:
        print_phrases(data)
        return 0

    report = Report()
    pairs = check_phrases(data, i18n_source, report)

    targets = scan_targets()
    texts = attributes = inline = 0
    for client, path in targets:
        rel = str(path.relative_to(REPO))
        src = path.read_text(encoding="utf-8")
        found_texts, found_attrs = check_literals(rel, src, report)
        texts += found_texts
        attributes += found_attrs
        inline += check_inline_translation(rel, src, report)
        check_fixed_language(rel, src, report)

    sources = reference_sources()
    used = check_keys(sorted(data["strings"]), sources, i18n_source, report)

    report.violations.sort()
    report.review.sort()

    web = sum(1 for client, _ in targets if client == "web")
    print("Mathmon bilingual audit")
    print("=======================")
    print(f"phrase pairs checked: {pairs}   ({len(data['strings'])} in STRINGS, "
          f"{len(data['phrases'])} in game data)")
    print(f"files scanned for literals: {len(targets)} ({web} web, {len(targets) - web} iOS)")
    print(f"JSX text nodes: {texts}   user-visible attributes: {attributes}")
    print(f"StringKeys: {len(data['strings'])}   referenced: {len(set(used) & set(data['strings']))}")
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
        print("Both languages are first-class (CLAUDE.md). A string the player can read")
        print("belongs in src/lib/i18n.ts with `en` and `zh`, reached through t().")
        return 1

    print("PASS: every string the player can read goes through the i18n layer.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
