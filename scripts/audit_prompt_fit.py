#!/usr/bin/env python3
"""Audit that every maths prompt fits on one line, on both clients.

Why this exists
---------------
A battle asks a question and starts a meter draining under it. If the question
wraps, the child is not reading the question the engine asked: `(♛9 + ♜5) −` on
one line and `(♝3 + ♟1)` on the next is two half-sums with an operator dangling
off the end of the first, and he has to reassemble it while the speed bonus
runs out. If it overflows instead, the end of it is simply not on the screen.

That was theoretical while the longest prompt in the game was `(9 × 9) + 20` at
twelve characters. The chess strand made the longest `(♛9 + ♜5) − (♝3 + ♟1)` -
21 characters, four of them chess glyphs, which are nearly twice the advance of
a digit. It wrapped onto two lines at every phone width, including a roomy one,
on both clients.

So the size is now derived from the prompt itself by `src/lib/game/prompt.ts`,
and this script is what keeps that honest. It is deliberately not a test of the
chess strand: it enumerates every prompt shape the generator can produce, at
every tier, and checks all of them. The next skill somebody adds will have a
length and a set of glyphs nobody thought about here, and it will be checked on
the run after it lands rather than when a child meets it.

What it checks
--------------
P1  prompt-fits-on-one-line     Every prompt, drawn at the size each client's
                                own rule gives it, is no wider than the
                                narrowest line box that client can hand it.
P2  shrinking-stays-legible     ...and is still at least LEGIBLE_MIN units
                                tall. Shrinking to fit is worthless if the
                                result is too small for a seven-year-old.
P3  the-floor-never-binds       The `min` floor is a backstop, not the thing
                                producing the fit. If a real prompt reaches it,
                                the floor has stopped protecting legibility and
                                started causing the overflow it exists to
                                prevent, so it must be reported before it can.
P4  both-clients-share-the-rule Each client imports and calls `promptFontSize`,
                                and neither pins the prompt to a fixed size of
                                its own. A rule forked into a client is the bug
                                `CLAUDE.md` names outright.
P5  the-rule-is-not-skill-aware The shared module names no skill. A size table
                                keyed by skill would be correct today and
                                silently wrong the moment `SKILLS` grows.
P6  every-glyph-is-measured     No character in any real prompt falls through
                                to the model's `other` fallback. The fallback
                                is a runtime backstop; a glyph the curriculum
                                actually uses should be measured, not guessed.

How it runs the engine
----------------------
Exactly as `scripts/audit_curriculum.py` does: `src/lib/game/` is pure
TypeScript with no React, DOM or Node dependency, so it is bundled with the
repo's own esbuild and executed under plain node. No test runner, no network.

Crucially, **the sizing rule itself is never restated here**. Python parses the
two clients' declared numbers out of their source and hands them to the real
`promptFontSize`, then checks the numbers that come back. A Python copy of the
rule would agree with a broken engine forever, which is the failure mode
`audit_curriculum.py` was written to avoid one level down.

Nothing under `mobile/` is bundled or executed - `mobile/src/screens/`
`BattleScreen.tsx` is read as plain text. The root CI job does not install
`mobile/node_modules`, and root tooling that reaches into `mobile/` has broken
this repository's CI twice.

What it cannot check
--------------------
The width model is a model. It sums a per-character advance measured in the
app's own type stack and rounded up, and it ignores kerning, which only ever
pulls a line in. A device whose fallback font is dramatically wider than the one
those advances were measured in could still wrap. That is what
`e2e/prompt-fit.spec.ts` is for: it puts the real longest prompt in a real
browser at the narrowest supported viewport and measures the line boxes that
actually painted. This script proves the rule is right about every prompt; that
spec proves the model is right about the browser.

The iOS half has no equivalent measurement - there is no simulator in the root
job - so its declared numbers are checked for internal consistency here and
against `mobile/src/theme.ts` where they are derived from it.

Determinism
-----------
Standard library only. Every seed is a literal or a loop index, all output is
sorted, and there is no wall-clock read and no unseeded randomness. Two runs on
the same commit print byte-identical output:

    python3 scripts/audit_prompt_fit.py > /tmp/a
    python3 scripts/audit_prompt_fit.py > /tmp/b
    cmp /tmp/a /tmp/b

Exit status
-----------
0  every property holds.
1  at least one property was violated; each violation is printed with the name
   of the property it broke.
2  the harness could not be built or run, or a client's declared numbers could
   not be read. A failure to check is never reported as a pass.

Note on shelling out: every subprocess is invoked with an explicit argv list and
its return code is checked directly. Nothing is piped through `head`/`tail`,
because a pipeline reports the exit status of its *last* command.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ESBUILD = REPO_ROOT / "node_modules" / ".bin" / "esbuild"

WEB_BATTLE = REPO_ROOT / "src" / "components" / "Battle.tsx"
IOS_BATTLE = REPO_ROOT / "mobile" / "src" / "screens" / "BattleScreen.tsx"
IOS_THEME = REPO_ROOT / "mobile" / "src" / "theme.ts"
SHARED_RULE = REPO_ROOT / "src" / "lib" / "game" / "prompt.ts"

# --- sweep sizes -----------------------------------------------------------
# Sized to very nearly exhaust each generator's question space rather than to
# sample it, for the same reason `audit_curriculum.py` is: the property here is
# about the *longest* prompt a skill can produce, and a longest read off a thin
# sample measures luck rather than curriculum. The widest generator is `add3` at
# 66x66 combinations, so 30k draws leave a one-in-a-thousand chance of missing
# any particular one.
SWEEP_PER_SKILL_TIER = 30000
# ...plus this many from a fresh rng each time, because a generator that only
# misbehaves on the first draw of a stream would hide in the sequential sweep.
SWEEP_PER_SKILL_TIER_FRESH = 300
# And the real entry point, which is what a battle actually calls. `battle.ts`
# asks for `state.tier + move.tierOffset` with offsets running -1..+2, so tiers
# 0 and 12 are genuinely requested and clamp.
SWEEP_PER_TIER = 3000
OUT_OF_BAND_TIERS = [0, 11, 12]

# The smallest the prompt may end up, in each client's own units (CSS pixels on
# the web, points on iOS). Below this it is no longer a question a seven-year-old
# can read across a room-lit tablet, and shrinking to fit has stopped being a
# fix. Body text on both clients is 14; this is comfortably above it.
LEGIBLE_MIN = 18.0

# Floating point slack when comparing a width against a line box, in units.
EPSILON = 0.01

HARNESS = r"""
import { MAX_TIER, MIN_TIER, SKILLS, SKILL_META, generateProblem } from '@engine/math';
import { createRng } from '@engine/rng';
import { PROMPT_EM, promptFontSize, promptWidthEm } from '@engine/prompt';

const config = JSON.parse(process.argv[2]);

const errors = [];
/** prompt -> { p, em, skills:Set, tiers:Set, n } */
const seen = new Map();

function record(tier, skill, prompt) {
  let row = seen.get(prompt);
  if (row === undefined) {
    row = { p: prompt, em: promptWidthEm(prompt), skills: new Set(), tiers: new Set(), n: 0 };
    seen.set(prompt, row);
  }
  row.skills.add(skill);
  row.tiers.add(tier);
  row.n += 1;
}

function fail(phase, where, message) {
  if (errors.length < 100) errors.push({ phase, where, message: String(message) });
}

// Phase A - each generator directly, across its whole declared band.
for (const skill of SKILLS) {
  const m = SKILL_META[skill];
  for (let tier = m.minTier; tier <= m.maxTier; tier++) {
    const rng = createRng(`fit:${skill}:t${tier}`);
    for (let i = 0; i < config.sweepPerSkillTier; i++) {
      try {
        record(tier, skill, m.generate(rng, tier).prompt);
      } catch (e) {
        fail('A', `${skill} tier ${tier} draw ${i}`, (e && e.message) || e);
      }
    }
    for (let i = 0; i < config.sweepPerSkillTierFresh; i++) {
      const seed = `fit-fresh:${skill}:t${tier}:n${i}`;
      try {
        record(tier, skill, m.generate(createRng(seed), tier).prompt);
      } catch (e) {
        fail('A-fresh', seed, (e && e.message) || e);
      }
    }
  }
}

// Phase B - the entry point a battle really calls, including the tiers the move
// offsets push it outside the legal band.
const tiers = [];
for (let tier = MIN_TIER; tier <= MAX_TIER; tier++) tiers.push(tier);
for (const tier of config.outOfBandTiers) tiers.push(tier);
for (const tier of tiers) {
  for (let i = 0; i < config.sweepPerTier; i++) {
    const seed = i % 2 === 0 ? i : `fit:t${tier}:n${i}:problem`;
    try {
      const problem = generateProblem(seed, tier);
      record(problem.tier, problem.skill, problem.prompt);
    } catch (e) {
      fail('B', `tier ${tier} seed ${seed}`, (e && e.message) || e);
    }
  }
}

// Every distinct character the curriculum can print, with the advance the model
// gives it. `other` is the model's fallback; a glyph that lands on it is a glyph
// nobody measured.
const characters = new Map();
for (const row of seen.values()) {
  for (const character of row.p) {
    if (!characters.has(character)) {
      characters.set(character, { c: character, em: promptWidthEm(character) });
    }
  }
}

const rows = [...seen.values()].map((row) => ({
  p: row.p,
  em: row.em,
  n: row.n,
  skills: [...row.skills].sort(),
  tiers: [...row.tiers].sort((a, b) => a - b),
  // The size each client's own numbers give this prompt, from the shared rule
  // itself. Nothing downstream re-derives it.
  sizes: config.clients.map((client) =>
    promptFontSize(row.p, { full: client.full, min: client.min, lineBox: client.lineBox }),
  ),
}));

rows.sort((a, b) => b.em - a.em || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));

process.stdout.write(
  JSON.stringify({
    skills: [...SKILLS],
    em: PROMPT_EM,
    characters: [...characters.values()].sort((a, b) => (a.c < b.c ? -1 : 1)),
    rows,
    errors,
  }),
);
"""


def die(message: str, code: int = 2) -> None:
    print(f"audit_prompt_fit: {message}", file=sys.stderr)
    raise SystemExit(code)


def read(path: Path) -> str:
    if not path.is_file():
        die(f"{path.relative_to(REPO_ROOT)} is missing")
    return path.read_text(encoding="utf-8")


def strip_comments(source: str) -> str:
    """Blank out comments, keeping offsets and newlines, so scans read code."""
    out = re.sub(r"/\*[\s\S]*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), source)
    return re.sub(r"(^|[^:])(//[^\n]*)", lambda m: m.group(1) + " " * len(m.group(2)), out)


# ---------------------------------------------------------------------------
# The two clients' declared numbers
# ---------------------------------------------------------------------------
#
# Each client declares one `PROMPT_TYPE` record: how big the prompt is normally,
# how small it may ever get, and how wide the narrowest line box it can be given
# is. Those three are platform facts - CSS pixels against points, a phone
# viewport against a scroll view - and they are the only things the clients are
# allowed to own. Everything that turns them into a size is the shared rule.
REQUIRED_KEYS = ("full", "min", "narrowLineBox")


def prompt_type(path: Path, required: tuple[str, ...] = REQUIRED_KEYS) -> dict[str, float]:
    source = strip_comments(read(path))
    match = re.search(r"\bPROMPT_TYPE\s*=\s*\{", source)
    if match is None:
        die(
            f"{path.relative_to(REPO_ROOT)} declares no PROMPT_TYPE record, so this "
            "audit has no numbers to check the prompt against"
        )
    depth = 0
    end = match.end() - 1
    while end < len(source):
        if source[end] == "{":
            depth += 1
        elif source[end] == "}":
            depth -= 1
            if depth == 0:
                break
        end += 1
    body = source[match.end() : end]

    values = {
        key: float(value) for key, value in re.findall(r"(\w+)\s*:\s*(-?\d+(?:\.\d+)?)\s*,", body)
    }
    missing = [key for key in required if key not in values]
    if missing:
        die(
            f"{path.relative_to(REPO_ROOT)}'s PROMPT_TYPE is missing "
            f"{', '.join(missing)}; the fit cannot be checked without it"
        )
    return values


def prompt_element(path: Path, marker: str) -> str:
    """The opening tag of the element that renders the prompt.

    Scoped deliberately. A file-wide search for a hardcoded font size would
    report every one of `BattleScreen.tsx`'s twenty stylesheet entries; the only
    one that matters is the one attached to the question itself.
    """
    source = strip_comments(read(path))
    index = source.find(marker)
    if index == -1:
        die(
            f"{path.relative_to(REPO_ROOT)} has no element marked {marker}, so this "
            "audit cannot tell which element renders the prompt"
        )
    start = source.rfind("<", 0, index)
    depth = 0
    end = index
    while end < len(source):
        if source[end] in "{[(":
            depth += 1
        elif source[end] in "}])":
            depth -= 1
        elif source[end] == ">" and depth == 0:
            break
        end += 1
    return source[start : end + 1]


def ios_space_md() -> int:
    """`space.md` from mobile/src/theme.ts - read, never assumed."""
    match = re.search(r"\bspace\s*=\s*\{[^}]*\bmd\s*:\s*(\d+)", read(IOS_THEME))
    if match is None:
        die("could not read `space.md` out of mobile/src/theme.ts")
    return int(match.group(1))


# ---------------------------------------------------------------------------
# Harness plumbing
# ---------------------------------------------------------------------------
def run_engine(clients: list[dict]) -> dict:
    if not ESBUILD.exists():
        die(f"esbuild not found at {ESBUILD}. Run `npm install` first.")

    workdir = Path(tempfile.mkdtemp(prefix="mathmon-prompt-fit-"))
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

        payload = json.dumps(
            {
                "sweepPerSkillTier": SWEEP_PER_SKILL_TIER,
                "sweepPerSkillTierFresh": SWEEP_PER_SKILL_TIER_FRESH,
                "sweepPerTier": SWEEP_PER_TIER,
                "outOfBandTiers": OUT_OF_BAND_TIERS,
                "clients": clients,
            },
            sort_keys=True,
        )
        run = subprocess.run(
            ["node", str(bundle), payload],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
        )
        if run.returncode != 0:
            die(f"engine harness failed (exit {run.returncode}):\n{run.stderr.strip()}")

        try:
            return json.loads(run.stdout)
        except json.JSONDecodeError as exc:
            die(f"harness produced non-JSON output: {exc}")
            raise
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def main() -> int:
    violations: list[str] = []

    web = prompt_type(WEB_BATTLE)
    ios = prompt_type(IOS_BATTLE, REQUIRED_KEYS + ("narrowest", "gutter"))

    clients = [
        {
            "name": "web",
            "file": str(WEB_BATTLE.relative_to(REPO_ROOT)),
            "unit": "CSS px",
            "marker": 'data-testid="problem"',
            # The largest declared full size, which is the least favourable one
            # for this check: a bigger starting size can only mean more shrinking
            # is needed, never less.
            "full": max(web["full"], web.get("fullWide", web["full"])),
            "min": web["min"],
            "lineBox": web["narrowLineBox"],
        },
        {
            "name": "ios",
            "file": str(IOS_BATTLE.relative_to(REPO_ROOT)),
            "unit": "pt",
            "marker": 'testID="problem"',
            "full": max(ios["full"], ios.get("fullWide", ios["full"])),
            "min": ios["min"],
            "lineBox": ios["narrowLineBox"],
        },
    ]

    data = run_engine(clients)
    rows = data["rows"]
    if not rows:
        die("the sweep produced no prompts at all")

    # --- P4: neither client owns the rule ---------------------------------
    for client in clients:
        element = prompt_element(REPO_ROOT / client["file"], client["marker"])
        if "promptFontSize(" not in element:
            violations.append(
                f"both-clients-share-the-rule: the prompt element in {client['file']} "
                "does not get its size from promptFontSize; a client that sizes the "
                "question itself has forked the rule and the two screens will drift"
            )
        # The shape a fork takes here is not a missing call - it is the call
        # plus something fixed that quietly wins.
        for match in re.finditer(r"fontSize\s*:\s*(\d+(?:\.\d+)?)", element):
            violations.append(
                f"both-clients-share-the-rule: the prompt element in {client['file']} "
                f"pins its font size to the literal {match.group(1)}"
            )
        for match in re.finditer(r"text-\d*xl|text-\[[^\]]+\]", element):
            violations.append(
                f"both-clients-share-the-rule: the prompt element in {client['file']} "
                f"still carries the fixed type class {match.group(0)!r}"
            )

    # The iOS stylesheet is a second place a size could be pinned, and it would
    # not show up in the element above - `styles.problemText` is applied there
    # by name.
    ios_source = strip_comments(read(IOS_BATTLE))
    style = re.search(r"problemText\s*:\s*\{([^}]*)\}", ios_source)
    if style is None:
        die("could not find the `problemText` style in mobile/src/screens/BattleScreen.tsx")
    if "fontSize" in style.group(1):
        violations.append(
            f"both-clients-share-the-rule: {clients[1]['file']}'s `problemText` style "
            "sets a fontSize of its own, which overrides nothing today and will "
            "override the shared rule the day the order changes"
        )

    # --- P5: the rule is length-driven, never skill-driven ------------------
    rule = strip_comments(read(SHARED_RULE))
    for skill in sorted(data["skills"]):
        if re.search(rf"['\"]{re.escape(skill)}['\"]", rule):
            violations.append(
                f"the-rule-is-not-skill-aware: src/lib/game/prompt.ts names the skill "
                f"{skill!r}. A size keyed by skill is right until SKILLS grows, and "
                "nobody will remember this file when it does"
            )

    # --- P6: every glyph the curriculum prints is measured ------------------
    fallback = data["em"]["other"]
    unmeasured = [c["c"] for c in data["characters"] if abs(c["em"] - fallback) < 1e-9]
    for character in sorted(unmeasured):
        violations.append(
            f"every-glyph-is-measured: prompts print {character!r}, which falls "
            f"through to PROMPT_EM.other ({fallback}). The fallback is a runtime "
            "backstop; a glyph the curriculum really uses belongs in the table"
        )

    # --- P1/P2/P3: the fit itself ------------------------------------------
    # Worst case per client, carried so the report can name it rather than
    # merely assert that one exists.
    worst = [{"ratio": -1.0, "row": None} for _ in clients]
    tightest = [{"size": None, "row": None} for _ in clients]

    for row in rows:
        for index, client in enumerate(clients):
            size = row["sizes"][index]
            width = size * row["em"]
            ratio = width / client["lineBox"]
            if ratio > worst[index]["ratio"]:
                worst[index] = {"ratio": ratio, "row": row, "size": size, "width": width}
            if tightest[index]["size"] is None or size < tightest[index]["size"]:
                tightest[index] = {"size": size, "row": row}

            where = f"{client['name']} / {row['p']!r} ({', '.join(row['skills'])})"

            if width > client["lineBox"] + EPSILON:
                violations.append(
                    f"prompt-fits-on-one-line: {where} draws {width:.1f}{client['unit']} "
                    f"wide at {size:.1f}, inside a line box of only "
                    f"{client['lineBox']:.0f}. It wraps or runs off the card"
                )
            if size < LEGIBLE_MIN - EPSILON:
                violations.append(
                    f"shrinking-stays-legible: {where} shrinks to {size:.1f}"
                    f"{client['unit']}, below the {LEGIBLE_MIN:.0f} a seven-year-old "
                    "can read. Fitting is not the only requirement"
                )
            if size <= client["min"] + EPSILON:
                violations.append(
                    f"the-floor-never-binds: {where} is held at the {client['min']:.0f}"
                    f"{client['unit']} floor rather than at the size that fits. The "
                    "floor is a backstop against a pathological prompt, and a real "
                    "one reaching it means the next one overflows"
                )

    # --- generators must not throw -----------------------------------------
    for err in data["errors"]:
        violations.append(
            f"prompt-fits-on-one-line: phase {err['phase']} at {err['where']} raised: "
            f"{err['message']}"
        )

    # ---- report -----------------------------------------------------------
    total = sum(row["n"] for row in rows)
    print("Mathmon prompt-fit audit")
    print("========================")
    print(f"prompts generated: {total}   distinct shapes: {len(rows)}")
    print(f"  {SWEEP_PER_SKILL_TIER} + {SWEEP_PER_SKILL_TIER_FRESH} per (skill, tier) "
          "straight from the generator")
    print(f"  {SWEEP_PER_TIER} per tier through generateProblem, including the "
          f"out-of-band tiers {', '.join(str(t) for t in OUT_OF_BAND_TIERS)} that "
          "move offsets ask for")
    print(f"legibility floor: {LEGIBLE_MIN:.0f} units")

    print()
    print("Character advances the width model uses (ems, from src/lib/game/prompt.ts)")
    print(f"  {'-' * 76}")
    line = "  "
    for entry in data["characters"]:
        cell = f"{entry['c']} {entry['em']:.2f}   "
        if len(line) + len(cell) > 78:
            print(line.rstrip())
            line = "  "
        line += cell
    if line.strip():
        print(line.rstrip())

    print()
    print("Declared by each client (the only numbers a client is allowed to own)")
    print(f"  {'-' * 76}")
    print(f"  {'client':<6}{'full':>7}{'min':>6}{'narrowest line box':>21}   file")
    for client in clients:
        print(f"  {client['name']:<6}{client['full']:>7.0f}{client['min']:>6.0f}"
              f"{client['lineBox']:>21.0f}   {client['file']}")
    md = ios_space_md()
    expected_gutter = 4 * md + 2
    print()
    print(f"  iOS: {ios['narrowest']:.0f}pt phone less {ios['gutter']:.0f}pt of chrome "
          f"= {ios['narrowLineBox']:.0f}pt.")
    print(f"       Chrome is 4 x space.md ({md}) + 2 x the card's 1px border "
          f"= {expected_gutter}.")

    if abs(ios["gutter"] - expected_gutter) > EPSILON:
        violations.append(
            f"prompt-fits-on-one-line: {clients[1]['file']} declares a gutter of "
            f"{ios['gutter']:.0f}pt, but the scroll padding, card padding and border it "
            f"names come to {expected_gutter} from mobile/src/theme.ts"
        )
    if abs(ios["narrowLineBox"] - (ios["narrowest"] - ios["gutter"])) > EPSILON:
        violations.append(
            f"prompt-fits-on-one-line: {clients[1]['file']} declares a narrowest line "
            f"box of {ios['narrowLineBox']:.0f}pt, which is not "
            f"{ios['narrowest']:.0f} - {ios['gutter']:.0f}"
        )

    print()
    print("The ten widest prompts the curriculum can ask")
    print(f"  {'-' * 76}")
    header = f"  {'prompt':<24}{'chars':>6}{'ems':>7}"
    for client in clients:
        header += f"{client['name'] + ' size':>12}{'width':>8}"
    print(header + "   skills")
    for row in rows[:10]:
        line = f"  {row['p']:<24}{len(row['p']):>6}{row['em']:>7.2f}"
        for index, client in enumerate(clients):
            size = row["sizes"][index]
            line += f"{size:>12.1f}{size * row['em']:>8.0f}"
        print(line + f"   {', '.join(row['skills'])}")

    print()
    print("Worst case per client")
    print(f"  {'-' * 76}")
    for index, client in enumerate(clients):
        entry = worst[index]
        row = entry["row"]
        print(f"  {client['name']:<6}{row['p']!r} fills {entry['ratio'] * 100:.1f}% of the "
              f"{client['lineBox']:.0f}{client['unit']} line box")
        print(f"        at {entry['size']:.1f}{client['unit']}, drawn "
              f"{entry['width']:.0f}{client['unit']} wide")
        small = tightest[index]
        print(f"        smallest any prompt is ever drawn: {small['size']:.1f}"
              f"{client['unit']} ({small['row']['p']!r}), floor is "
              f"{client['min']:.0f}")

    print()
    if violations:
        print("FAIL")
        for line in sorted(set(violations)):
            print(f"  {line}")
        print()
        print(f"  {len(set(violations))} distinct violation(s)")
        return 1

    print("OK: every prompt the generator can produce fits its line box on one line on")
    print("    both clients, at a size a seven-year-old can still read, without either")
    print("    client reaching its floor or owning a copy of the rule.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
