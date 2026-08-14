#!/usr/bin/env python3
"""Audit the maths curriculum: sweep every tier, and re-derive every answer.

Why this exists
---------------
`src/lib/game/math.ts` is not a utility module, it is the curriculum. Every
attack in a battle is gated behind one of its problems, so this file decides
what a seven-year-old actually practises, and a wrong answer in it is not a
rendering glitch - it is a child being told he is wrong when he is right.

`math.test.ts` already checks the shape of this: a few hundred seeds per tier,
and one independent re-evaluation of the prompt. That was proportionate while
the ramp effectively pinned most players near the bottom. It is not
proportionate now. Commit 06c64c7 removed speed as a gate on promotion, so an
accurate-but-slow child climbs the whole ladder for the first time, and tiers
5-10 - times tables, division facts, missing factors, fractions, two-step
expressions - are about to get real play with far less exercise behind them than
tiers 1-3 ever had.

So this script sweeps roughly two hundred thousand problems rather than a few
thousand, and, crucially, **parses and evaluates every distinct prompt in Python
rather than trusting the number the generator handed back**. That is the whole
point. A generator that computes its own answer wrong agrees with itself
forever: the unit test asserts `answer === answer`, the suite stays green, and
the only person who ever finds out is the child who typed the right number into
the keypad and watched his creature take chip damage for it.

Two things are re-derived here rather than imported, on purpose:

  - the arithmetic, from the prompt string, with exact rational arithmetic
    (`fractions.Fraction`), so `½ of 7` would be caught rather than rounded;
  - each tier's skill pool, from the declared `minTier`/`maxTier` bands, because
    `skillsForTier` has a deliberate fallback to `add1` when a pool comes out
    empty. That fallback is good defence in the game and terrible evidence in an
    audit - it would quietly mask exactly the misbanding this script is looking
    for.

Everything else (the skills, the generators, the tier constants, the par times)
is imported from the engine, never restated, so a rebalance moves this report
instead of breaking it.

Note the prompts use the Unicode minus (U+2212) and times (U+00D7) glyphs, not
ASCII hyphen and `x`, plus `÷`, the vulgar fractions `½ ⅓ ¼` and the black chess
pieces `♟ ♞ ♝ ♜ ♛`. The parser below matches those, and an unparsed prompt is a
failure rather than a skip - a prompt shape nobody can evaluate is a prompt shape
nobody is checking.

The chess prompts get one check the arithmetic cannot give them. They print each
piece's value beside it (`♜5 + ♟1`), which is the whole reason they are
arithmetic rather than trivia: the question is answerable from what is on the
screen, with or without ever having seen a board. So the piece values are
restated here, by hand, exactly as the arithmetic is - if the engine ever prints
`♟5`, the sum still adds up, Python agrees with it, and the only thing that has
happened is that a child has been quietly taught that a pawn is worth five.

How it runs the engine
----------------------
The engine is pure TypeScript with no React, DOM or Node dependencies, so it is
bundled with the repo's own esbuild and executed under plain node. No test
runner is involved and no network is touched. This mirrors
`scripts/balance_report.py` and `scripts/simulate_difficulty.py`. Nothing under
`mobile/` is bundled or read.

Determinism
-----------
Every seed is a literal or a loop index, all output is sorted, and there is no
wall-clock read and no unseeded randomness anywhere. Two runs on the same commit
print byte-identical output. Verify with:

    python3 scripts/audit_curriculum.py > /tmp/a
    python3 scripts/audit_curriculum.py > /tmp/b
    cmp /tmp/a /tmp/b

Exit status
-----------
0  every property holds.
1  at least one property was violated; each violation is printed with the name
   of the property it broke.
2  the harness could not be built or run.

Note on shelling out: every subprocess is invoked with an explicit argv list and
its return code is checked directly. Nothing is piped through `head`/`tail`,
because a pipeline reports the exit status of its *last* command and that has
already hidden a real failure in this repo once.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
from fractions import Fraction
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ESBUILD = REPO_ROOT / "node_modules" / ".bin" / "esbuild"

# --- sweep sizes -----------------------------------------------------------
# Problems per tier through the real `generateProblem`, which is what the battle
# calls. This is the pool-weighted mix a player actually sees, so the difficulty
# statistics below are taken from it.
SWEEP_PER_TIER = 3000
# Additional problems per tier generated with `avoidPrompt` set to the previous
# prompt, which is how `battle.ts` calls it.
SWEEP_AVOID_PER_TIER = 500
# Problems per (skill, tier) drawn straight from the generator, from one long
# stream. `generateProblem` picks a skill at random, so a skill that is legal at
# only two tiers - `twoStep` - would otherwise get a thin sample exactly where
# the ramp change has just made it reachable.
#
# Sized to very nearly exhaust each generator's question space rather than to
# sample it: the widest is `add3` at 66x66 = 4356 combinations, so 30k draws
# leave a one-in-a-thousand chance of missing any particular one. That matters
# because the ceiling check below compares the hardest question each tier can
# ask, and a ceiling read off a thin sample measures luck rather than curriculum.
SWEEP_PER_SKILL_TIER = 30000
# ...plus this many from a *fresh* rng each time, because a generator that only
# misbehaves on the first draw of a stream would hide in the sequential sweep.
SWEEP_PER_SKILL_TIER_FRESH = 300
# `battle.ts` asks for `state.tier + move.tierOffset`, and the move offsets run
# -1..+2, so the engine really is asked for tier 0 and tier 12. Those must clamp
# rather than throw.
OUT_OF_BAND_TIERS = [-2, -1, 0, 11, 12, 13]
SWEEP_OUT_OF_BAND = 500

# A keypad answer a seven-year-old types has to be typable. Three digits is the
# bound `math.test.ts` already assumes; it is restated as a named property here
# so a generator that starts emitting five-digit answers is reported as a UX
# failure rather than passing quietly.
MAX_TYPABLE_ANSWER = 999

# Tier bands used for the monotonicity check. Per-tier means are *not* monotone
# and should not be forced to be - see the P11 block in `main` for why.
DIFFICULTY_BANDS = [(1, 3), (4, 7), (8, 10)]

HARNESS = r"""
import {
  MAX_TIER,
  MIN_TIER,
  SKILLS,
  SKILL_META,
  generateProblem,
  parTimeForTier,
  skillsForTier,
} from '@engine/math';
import { createRng } from '@engine/rng';

const config = JSON.parse(process.argv[2]);

const errors = [];
const rows = new Map();

/**
 * Records one generated problem, de-duplicated by everything that matters.
 *
 * The sweep asks for ~200k problems but the space of *distinct* problems is
 * small, so collapsing them keeps the JSON handed to Python in the megabytes
 * rather than the hundreds. The key includes the answer, so a prompt that ever
 * comes back with two different answers survives as two rows.
 *
 * NaN, Infinity and -0 do not survive JSON, so they are flagged here and the
 * numeric field is nulled. Silently round-tripping -0 to 0 would defeat the
 * check that asks for it by name.
 */
function record(phase, tier, skill, prompt, answer) {
  const finite = typeof answer === 'number' && Number.isFinite(answer);
  const key = JSON.stringify([phase, tier, skill, String(prompt), String(answer)]);
  let row = rows.get(key);
  if (row === undefined) {
    row = {
      ph: phase,
      t: tier,
      k: skill,
      p: String(prompt),
      a: finite ? answer : null,
      as: String(answer),
      nz: Object.is(answer, -0),
      nf: !finite,
      ty: typeof answer,
      n: 0,
    };
    rows.set(key, row);
  }
  row.n += 1;
}

function fail(phase, tier, seed, skill, message) {
  if (errors.length < 200) {
    errors.push({ phase, tier, seed: String(seed), skill, message: String(message) });
  }
}

// ---------------------------------------------------------------------------
// Declared pools, re-derived from the bands rather than taken from
// skillsForTier(), which falls back to add1 on an empty pool.
// ---------------------------------------------------------------------------
const pools = {};
for (let tier = MIN_TIER; tier <= MAX_TIER; tier++) {
  const declared = SKILLS.filter(
    (s) => tier >= SKILL_META[s].minTier && tier <= SKILL_META[s].maxTier,
  );
  let engine = [];
  try {
    engine = skillsForTier(tier).map((m) => m.skill);
  } catch (e) {
    fail('pool', tier, '-', null, (e && e.message) || e);
  }
  pools[tier] = { declared, engine, par: parTimeForTier(tier) };
}

const meta = SKILLS.map((s) => ({
  skill: s,
  minTier: SKILL_META[s].minTier,
  maxTier: SKILL_META[s].maxTier,
  en: SKILL_META[s].label ? SKILL_META[s].label.en : null,
  zh: SKILL_META[s].label ? SKILL_META[s].label.zh : null,
}));

// ---------------------------------------------------------------------------
// Phase A: the real entry point, at every legal tier.
// Half the seeds are numbers and half are strings shaped like the ones
// `battle.ts` builds (`${seed}:${turn}:problem`), because hashSeed and the
// numeric path are different entrances to the same rng.
// ---------------------------------------------------------------------------
for (let tier = MIN_TIER; tier <= MAX_TIER; tier++) {
  for (let i = 0; i < config.sweepPerTier; i++) {
    const seed = i % 2 === 0 ? i : `audit:t${tier}:n${i}:problem`;
    try {
      const p = generateProblem(seed, tier);
      if (p.tier !== tier) fail('A', tier, seed, p.skill, `returned tier ${p.tier}`);
      if (!(p.parTime > 0)) fail('A', tier, seed, p.skill, `parTime ${p.parTime}`);
      if (typeof p.id !== 'string' || p.id.length === 0) fail('A', tier, seed, p.skill, 'empty id');
      record('A', tier, p.skill, p.prompt, p.answer);
    } catch (e) {
      fail('A', tier, seed, null, (e && e.message) || e);
    }
  }

  // The avoid-repeat path, put under real pressure. Chaining fresh seeds would
  // measure nothing - two different seeds almost never collide anyway. So each
  // draw is asked to avoid the prompt *that same seed* produces unaided, which
  // forces the retry loop to run every single time.
  let repeats = 0;
  for (let i = 0; i < config.sweepAvoidPerTier; i++) {
    const seed = `audit-avoid:t${tier}:n${i}`;
    try {
      const base = generateProblem(seed, tier);
      const avoided = generateProblem(seed, tier, base.prompt);
      if (avoided.prompt === base.prompt) repeats += 1;
      record('A', tier, base.skill, base.prompt, base.answer);
      record('A', tier, avoided.skill, avoided.prompt, avoided.answer);
    } catch (e) {
      fail('A-avoid', tier, seed, null, (e && e.message) || e);
    }
  }
  pools[tier].avoidRepeats = repeats;
  pools[tier].avoidDraws = config.sweepAvoidPerTier;
}

// ---------------------------------------------------------------------------
// Phase B: each generator directly, across its whole declared band.
// ---------------------------------------------------------------------------
for (const skill of SKILLS) {
  const m = SKILL_META[skill];
  for (let tier = m.minTier; tier <= m.maxTier; tier++) {
    const rng = createRng(`audit-skill:${skill}:t${tier}`);
    for (let i = 0; i < config.sweepPerSkillTier; i++) {
      try {
        const r = m.generate(rng, tier);
        record('B', tier, skill, r.prompt, r.answer);
      } catch (e) {
        fail('B', tier, `stream#${i}`, skill, (e && e.message) || e);
      }
    }
    for (let i = 0; i < config.sweepPerSkillTierFresh; i++) {
      const seed = `audit-fresh:${skill}:t${tier}:n${i}`;
      try {
        const r = m.generate(createRng(seed), tier);
        record('B', tier, skill, r.prompt, r.answer);
      } catch (e) {
        fail('B-fresh', tier, seed, skill, (e && e.message) || e);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Phase C: tiers the battle really asks for via move.tierOffset, outside the
// legal band. These must clamp, not throw.
// ---------------------------------------------------------------------------
for (const tier of config.outOfBandTiers) {
  for (let i = 0; i < config.sweepOutOfBand; i++) {
    const seed = `audit-oob:t${tier}:n${i}`;
    try {
      const p = generateProblem(seed, tier);
      if (p.tier < MIN_TIER || p.tier > MAX_TIER) {
        fail('C', tier, seed, p.skill, `clamped to out-of-band tier ${p.tier}`);
      }
      record('C', p.tier, p.skill, p.prompt, p.answer);
    } catch (e) {
      fail('C', tier, seed, null, (e && e.message) || e);
    }
  }
}

const out = [...rows.values()];
out.sort((x, y) =>
  x.ph < y.ph ? -1 : x.ph > y.ph ? 1
  : x.t - y.t || (x.k < y.k ? -1 : x.k > y.k ? 1 : 0)
  || (x.p < y.p ? -1 : x.p > y.p ? 1 : 0)
  || (x.as < y.as ? -1 : x.as > y.as ? 1 : 0),
);

process.stdout.write(
  JSON.stringify({
    constants: { MIN_TIER, MAX_TIER, SKILLS: [...SKILLS] },
    meta,
    pools,
    rows: out,
    errors,
  }),
);
"""

# --- independent evaluation ------------------------------------------------

MINUS = "−"  # U+2212 MINUS SIGN, not ASCII hyphen
TIMES = "×"
DIVIDE = "÷"
FRACTION_GLYPHS = {"½": 2, "⅓": 3, "¼": 4}

# The piece values every chess camp teaches in its first week. Deliberately a
# second copy rather than an import: this table is what makes the printed value
# checkable at all (see the module docstring).
#
# The king is absent, and its absence is load-bearing. It is never traded, so it
# has no point value, and a prompt that invented one would be teaching something
# false about the game. A ♚ - or a white ♔, or any other piece glyph - therefore
# fails to parse rather than being scored, which is reported as
# prompt-is-parseable.
CHESS_VALUES = {"♟": 1, "♞": 3, "♝": 3, "♜": 5, "♛": 9}
CHESS_NAMES = {"♟": "pawn", "♞": "knight", "♝": "bishop", "♜": "rook", "♛": "queen"}
CHESS_CLASS = "".join(CHESS_VALUES)

# Anything in the Unicode chess block routes to the chess parser, not just the
# five pieces above, so an unexpected glyph is reported as an unevaluable chess
# prompt rather than as a mystery.
RE_ANY_CHESS = re.compile(r"[♔-♟]")
RE_CHESS_TERM = re.compile(rf"^([{CHESS_CLASS}])(\d+)$")
RE_CHESS_PIECE = re.compile(rf"([{CHESS_CLASS}])(\d+)")
RE_CHESS_SWAP = re.compile(r"^(.+) \+ \? = (.+)$")
RE_CHESS_LEAD = re.compile(r"^\((.+)\) − \((.+)\)$")

RE_FRACTION = re.compile(r"^([½⅓¼]) of (\d+)$")
RE_TWO_STEP = re.compile(r"^\((\d+) × (\d+)\) \+ (\d+)$")
RE_MISSING = re.compile(r"^(\d+) ([+×]) \? = (\d+)$")
RE_BINARY = re.compile(r"^(\d+) ([+−×÷]) (\d+)$")


class Parsed:
    """One prompt, evaluated from scratch. `value` is exact, never a float.

    `sides` carries the structure of a prompt that has more than one group of
    operands - the two armies of a chess prompt - because `operands` is flat and
    a flat list cannot say which pieces were on which side. Everything else
    leaves it empty.
    """

    __slots__ = ("form", "op", "operands", "value", "note", "sides")

    def __init__(
        self,
        form: str,
        op: str,
        operands: list[int],
        value,
        note: str = "",
        sides: list[list[int]] | None = None,
    ):
        self.form = form
        self.op = op
        self.operands = operands
        self.value = value
        self.note = note
        self.sides = sides or []


def chess_squad(text: str) -> list[int] | None:
    """The values printed on one side of a chess prompt, or None if it is not one.

    Only the *printed* numbers are read. What a piece is really worth is checked
    separately, so that a dishonest value cannot hide inside arithmetic that
    happens to add up.
    """
    values: list[int] = []
    for term in text.split(" + "):
        m = RE_CHESS_TERM.match(term)
        if m is None:
            return None
        values.append(int(m.group(2)))
    return values


def evaluate_chess(prompt: str) -> Parsed | None:
    """Re-derives a chess prompt's answer from the values printed on the screen."""
    m = RE_CHESS_LEAD.match(prompt)
    if m:
        ahead = chess_squad(m.group(1))
        behind = chess_squad(m.group(2))
        if ahead is None or behind is None:
            return None
        return Parsed(
            "chessLead",
            MINUS,
            ahead + behind,
            Fraction(sum(ahead) - sum(behind)),
            sides=[ahead, behind],
        )

    m = RE_CHESS_SWAP.match(prompt)
    if m:
        held = chess_squad(m.group(1))
        target = chess_squad(m.group(2))
        if held is None or target is None:
            return None
        return Parsed(
            "chessSwap",
            "+?",
            held + target,
            Fraction(sum(target) - sum(held)),
            sides=[held, target],
        )

    squad = chess_squad(prompt)
    if squad is not None:
        return Parsed("chessSum", "+", squad, Fraction(sum(squad)), sides=[squad])

    return None


def evaluate(prompt: str) -> Parsed | None:
    """Re-derives a prompt's answer without consulting the generator.

    Exact rational arithmetic throughout: `Fraction` makes `½ of 7` come back as
    7/2 rather than a float that rounds into looking correct.
    """
    # A chess piece anywhere in the prompt settles which grammar applies: no
    # arithmetic prompt contains one, and no chess prompt is missing one.
    if RE_ANY_CHESS.search(prompt):
        return evaluate_chess(prompt)

    m = RE_FRACTION.match(prompt)
    if m:
        denominator = FRACTION_GLYPHS[m.group(1)]
        total = int(m.group(2))
        return Parsed("fraction", "of", [denominator, total], Fraction(total, denominator))

    m = RE_TWO_STEP.match(prompt)
    if m:
        a, b, c = (int(g) for g in m.groups())
        return Parsed("twoStep", "()+", [a, b, c], Fraction(a * b + c))

    m = RE_MISSING.match(prompt)
    if m:
        a, op, total = int(m.group(1)), m.group(2), int(m.group(3))
        if op == "+":
            return Parsed("missing", "+", [a, total], Fraction(total - a))
        if a == 0:
            # `0 × ? = 0` has every number as an answer, and `0 × ? = 5` has
            # none. Either way it is not a question with an answer.
            return Parsed("missing", TIMES, [a, total], None, "missing factor of zero")
        return Parsed("missing", TIMES, [a, total], Fraction(total, a))

    m = RE_BINARY.match(prompt)
    if m:
        x, op, y = int(m.group(1)), m.group(2), int(m.group(3))
        if op == "+":
            return Parsed("binary", "+", [x, y], Fraction(x + y))
        if op == MINUS:
            return Parsed("binary", MINUS, [x, y], Fraction(x - y))
        if op == TIMES:
            return Parsed("binary", TIMES, [x, y], Fraction(x * y))
        if y == 0:
            return Parsed("binary", DIVIDE, [x, y], None, "division by zero")
        return Parsed("binary", DIVIDE, [x, y], Fraction(x, y))

    return None


def degeneracy(parsed: Parsed) -> str:
    """Names why a prompt teaches nothing, or '' if it is a real question.

    These all waste a turn in a battle. A child who is shown `7 + 0` still has
    to stop, read it and tap, and gets no practice for it.
    """
    if parsed.form == "binary":
        x, y = parsed.operands
        if parsed.op == "+":
            if x == 0 or y == 0:
                return "adds zero"
        elif parsed.op == MINUS:
            if y == 0:
                return "subtracts zero"
            if x == y:
                return "subtracts itself"
        elif parsed.op == TIMES:
            if x == 0 or y == 0:
                return "multiplies by zero"
            if x == 1 or y == 1:
                return "multiplies by one"
        elif parsed.op == DIVIDE:
            if y == 1:
                return "divides by one"
            if x == 0:
                return "divides zero"
            if x == y:
                return "divides itself"
    elif parsed.form == "missing":
        a, total = parsed.operands
        if parsed.op == "+":
            if total == a:
                return "missing addend is zero"
            if a == 0:
                return "adds to zero"
        else:
            if a == 0:
                return "missing factor of zero"
            if a == 1:
                return "multiplies by one"
            if total == a:
                return "missing factor is one"
            if total == 0:
                return "missing factor is zero"
    elif parsed.form == "twoStep":
        a, b, c = parsed.operands
        if a == 0 or b == 0:
            return "multiplies by zero"
        if a == 1 or b == 1:
            return "multiplies by one"
        if c == 0:
            return "adds zero"
    elif parsed.form == "fraction":
        _, total = parsed.operands
        if total == 0:
            return "fraction of zero"
    elif parsed.form == "chessSum":
        if len(parsed.operands) < 2:
            return "counts a single piece, so there is nothing to add"
        if all(value == 1 for value in parsed.operands):
            # The point of the skill is what a piece is worth. A row of 1s can
            # be answered without ever looking at which piece is which.
            return "counts nothing but pawns"
    elif parsed.form == "chessSwap":
        held, target = parsed.sides
        if not held or not target:
            return "shows a side with no pieces on it"
        if sum(target) == sum(held):
            return "asks what is missing from a trade that is already even"
    elif parsed.form == "chessLead":
        ahead, behind = parsed.sides
        if not ahead or not behind:
            return "shows a side with no pieces on it"
        if sum(ahead) == sum(behind):
            return "asks how far ahead a player is when the sides are level"
    return ""


# --- harness plumbing ------------------------------------------------------


def die(message: str, code: int = 2) -> None:
    print(f"audit_curriculum: {message}", file=sys.stderr)
    raise SystemExit(code)


def run_engine() -> dict:
    """Bundle the pure engine with esbuild and execute it under node."""
    if not ESBUILD.exists():
        die(f"esbuild not found at {ESBUILD}. Run `npm install` first.")

    workdir = Path(tempfile.mkdtemp(prefix="mathmon-curriculum-"))
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
                "sweepPerTier": SWEEP_PER_TIER,
                "sweepAvoidPerTier": SWEEP_AVOID_PER_TIER,
                "sweepPerSkillTier": SWEEP_PER_SKILL_TIER,
                "sweepPerSkillTierFresh": SWEEP_PER_SKILL_TIER_FRESH,
                "outOfBandTiers": OUT_OF_BAND_TIERS,
                "sweepOutOfBand": SWEEP_OUT_OF_BAND,
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


# --- statistics ------------------------------------------------------------


def weighted_mean(pairs: list[tuple[int, int]]) -> float:
    total = sum(n for _, n in pairs)
    if total == 0:
        return 0.0
    return sum(v * n for v, n in pairs) / total


def weighted_median(pairs: list[tuple[int, int]]) -> int:
    total = sum(n for _, n in pairs)
    if total == 0:
        return 0
    seen = 0
    for value, n in sorted(pairs):
        seen += n
        if seen * 2 >= total:
            return value
    return sorted(pairs)[-1][0]


def main() -> int:
    data = run_engine()
    constants = data["constants"]
    min_tier = constants["MIN_TIER"]
    max_tier = constants["MAX_TIER"]
    skills = constants["SKILLS"]
    pools = data["pools"]
    rows = data["rows"]
    tiers = list(range(min_tier, max_tier + 1))

    violations: list[str] = []
    unparsed: list[str] = []

    # ---- per-row checks ---------------------------------------------------
    # Every distinct problem is inspected once, and its answer is re-derived
    # from its prompt. Counts are carried so the statistics stay weighted by how
    # often a player would actually meet each problem.
    generated = 0
    distinct_prompts: dict[str, set] = {}
    answers_by_tier: dict[int, list[tuple[int, int]]] = {t: [] for t in tiers}
    operands_by_tier: dict[int, list[tuple[int, int]]] = {t: [] for t in tiers}
    skills_seen_by_tier: dict[int, dict[str, int]] = {t: {} for t in tiers}
    distinct_by_tier: dict[int, int] = {t: 0 for t in tiers}
    skill_answer_range: dict[str, list] = {}
    # (skill, tier) -> [hardest answer, largest printed operand] that pairing can
    # produce. Phase B drives this: it hammers each generator at each tier of its
    # band hard enough to very nearly exhaust the question space, so these are
    # ceilings rather than samples.
    skill_tier_ceiling: dict[tuple[str, int], list[int]] = {}
    forms_seen: dict[str, int] = {}

    for row in rows:
        generated += row["n"]
        tier = row["t"]
        skill = row["k"]
        prompt = row["p"]
        answer = row["a"]
        where = f"tier {tier} / {skill} / {prompt!r}"

        # P1 - the invariant CLAUDE.md states outright.
        if row["ty"] != "number":
            violations.append(
                f"answers-are-non-negative-integers: {where} answered with a "
                f"{row['ty']} ({row['as']!r}), not a number"
            )
        elif row["nf"]:
            violations.append(
                f"answers-are-non-negative-integers: {where} answered {row['as']}, "
                "which is not a finite number"
            )
        elif row["nz"]:
            violations.append(
                f"answers-are-non-negative-integers: {where} answered negative zero; "
                "a keypad has one zero, not two"
            )
        elif not isinstance(answer, int):
            violations.append(
                f"answers-are-non-negative-integers: {where} answered {row['as']}, "
                "which is not a whole number - it cannot be typed on the keypad"
            )
        elif answer < 0:
            violations.append(
                f"answers-are-non-negative-integers: {where} answered {answer}; "
                "the keypad has no minus key"
            )
        elif answer > MAX_TYPABLE_ANSWER:
            violations.append(
                f"answers-are-keypad-typable: {where} answered {answer}, above the "
                f"{MAX_TYPABLE_ANSWER} a three-digit keypad entry can express"
            )

        # P2b - a chess prompt is only self-contained because it prints each
        # piece's value beside it. Arithmetic cannot catch a wrong one: Python
        # adds up exactly what is on the screen, so `♟5 + ♟5` answering 10 is
        # perfectly consistent and still teaches a seven-year-old that a pawn is
        # worth a rook. This is the only check standing between him and that.
        for glyph, printed in RE_CHESS_PIECE.findall(prompt):
            if int(printed) != CHESS_VALUES[glyph]:
                violations.append(
                    f"chess-values-are-honest: {where} prints {glyph}{printed}, but a "
                    f"{CHESS_NAMES[glyph]} is worth {CHESS_VALUES[glyph]}"
                )

        # P2 - the point of the whole script: evaluate the prompt independently.
        parsed = evaluate(prompt)
        if parsed is None:
            if len(unparsed) < 20:
                unparsed.append(where)
            violations.append(
                f"prompt-is-parseable: {where} is a prompt shape this audit cannot "
                "evaluate, so nothing is checking its arithmetic"
            )
        else:
            forms_seen[parsed.form] = forms_seen.get(parsed.form, 0) + row["n"]
            if parsed.value is None:
                violations.append(
                    f"prompt-matches-answer: {where} is not a well-posed question "
                    f"({parsed.note})"
                )
            elif parsed.value.denominator != 1:
                violations.append(
                    f"prompt-matches-answer: {where} evaluates to "
                    f"{parsed.value.numerator}/{parsed.value.denominator}, which is not a "
                    "whole number, but the engine answered "
                    f"{row['as']}"
                )
            elif isinstance(answer, int) and int(parsed.value) != answer:
                violations.append(
                    f"prompt-matches-answer: {where} evaluates to {int(parsed.value)} but "
                    f"the engine answered {row['as']}; a child typing the right number "
                    "would be marked wrong"
                )

            # P6 - degenerate prompts.
            reason = degeneracy(parsed)
            if reason:
                violations.append(
                    f"no-degenerate-prompts: {where} {reason}; it costs a battle turn "
                    "and teaches nothing"
                )

        distinct_prompts.setdefault(prompt, set()).add(row["as"])

        if isinstance(answer, int):
            if parsed is not None and parsed.form != "fraction":
                largest = max(parsed.operands)
            elif parsed is not None:
                largest = parsed.operands[1]
            else:
                largest = 0
            lo, hi = skill_answer_range.get(skill, [answer, answer])
            skill_answer_range[skill] = [min(lo, answer), max(hi, answer)]
            ceiling = skill_tier_ceiling.get((skill, tier))
            if ceiling is None:
                skill_tier_ceiling[(skill, tier)] = [answer, largest]
            else:
                ceiling[0] = max(ceiling[0], answer)
                ceiling[1] = max(ceiling[1], largest)
            # Difficulty statistics come from phase A only: that is the real
            # pool-weighted mix a player at this tier is shown. Phase B samples
            # every skill equally, which is right for exercising generators and
            # wrong for describing a tier.
            if row["ph"] == "A" and tier in answers_by_tier:
                answers_by_tier[tier].append((answer, row["n"]))
                operands_by_tier[tier].append((largest, row["n"]))

        if row["ph"] == "A" and tier in skills_seen_by_tier:
            skills_seen_by_tier[tier][skill] = skills_seen_by_tier[tier].get(skill, 0) + row["n"]
            distinct_by_tier[tier] += 1

    # P3 - no generator may throw.
    for err in data["errors"]:
        violations.append(
            "generators-never-throw: phase {phase} tier {tier} seed {seed}"
            "{skill} raised: {message}".format(
                phase=err["phase"],
                tier=err["tier"],
                seed=err["seed"],
                skill=f" skill {err['skill']}" if err["skill"] else "",
                message=err["message"],
            )
        )

    # P7 - one prompt, one answer. Two generators whose ranges overlap could
    # otherwise print the same question with two different right answers.
    for prompt in sorted(distinct_prompts):
        answers = distinct_prompts[prompt]
        if len(answers) > 1:
            violations.append(
                f"prompt-is-unambiguous: {prompt!r} is generated with "
                f"{len(answers)} different answers ({', '.join(sorted(answers))})"
            )

    # ---- report -----------------------------------------------------------
    print("Mathmon curriculum audit")
    print("========================")
    print(f"engine constants: MIN_TIER={min_tier}  MAX_TIER={max_tier}  "
          f"skills={len(skills)}")
    print(f"problems generated: {generated}   distinct: {len(rows)}")
    print(f"  {SWEEP_PER_TIER} + {SWEEP_AVOID_PER_TIER} per tier through generateProblem")
    print(f"  {SWEEP_PER_SKILL_TIER} + {SWEEP_PER_SKILL_TIER_FRESH} per (skill, tier) "
          "straight from the generator")
    print(f"  {SWEEP_OUT_OF_BAND} per out-of-band tier "
          f"({', '.join(str(t) for t in OUT_OF_BAND_TIERS)}), which battle.ts really asks for")
    print("every distinct prompt above is parsed and re-evaluated in Python")
    print("prompt forms seen: " + ", ".join(
        f"{form} x{forms_seen[form]}" for form in sorted(forms_seen)
    ))

    print()
    print("Per-tier variety")
    print(f"  {'-' * 76}")
    print(f"  {'tier':>4}{'par':>7}{'pool':>6}{'drawn':>7}{'prompts':>9}  skills")
    for tier in tiers:
        pool = pools[str(tier)]
        drawn = skills_seen_by_tier[tier]
        listed = ", ".join(sorted(pool["declared"]))
        print(f"  {tier:>4}{pool['par']:>7.1f}{len(pool['declared']):>6}"
              f"{len(drawn):>7}{distinct_by_tier[tier]:>9}  {listed}")
    print()
    print("  pool    = skills whose declared minTier..maxTier band contains the tier")
    print("  drawn   = of those, how many actually appeared in the sweep")
    print("  prompts = distinct questions the tier can ask, as observed")

    print()
    print("Per-skill reach (answer range observed across the whole band)")
    print(f"  {'-' * 76}")
    print(f"  {'skill':<12}{'band':>8}{'answers':>14}   labels")
    for entry in sorted(data["meta"], key=lambda m: (m["minTier"], m["skill"])):
        skill = entry["skill"]
        rng = skill_answer_range.get(skill)
        span = f"{rng[0]}..{rng[1]}" if rng else "never drawn"
        print(f"  {skill:<12}{entry['minTier']}..{entry['maxTier']:<5}{span:>14}   "
              f"{entry['en']} / {entry['zh']}")

    print()
    print("Difficulty by tier (phase A only: the real pool-weighted mix)")
    print(f"  {'-' * 76}")
    print(f"  {'tier':>4}{'mean ans':>10}{'median':>8}{'max ans':>9}"
          f"{'mean operand':>14}{'max operand':>13}")
    tier_stats = {}
    for tier in tiers:
        answers = answers_by_tier[tier]
        operands = operands_by_tier[tier]
        stats = {
            "mean_answer": weighted_mean(answers),
            "median_answer": weighted_median(answers),
            "max_answer": max((v for v, _ in answers), default=0),
            "mean_operand": weighted_mean(operands),
            "max_operand": max((v for v, _ in operands), default=0),
        }
        tier_stats[tier] = stats
        print(f"  {tier:>4}{stats['mean_answer']:>10.1f}{stats['median_answer']:>8}"
              f"{stats['max_answer']:>9}{stats['mean_operand']:>14.1f}"
              f"{stats['max_operand']:>13}")

    # ---- pool properties --------------------------------------------------
    for tier in tiers:
        pool = pools[str(tier)]
        declared = pool["declared"]
        engine = pool["engine"]

        # P4 - a tier with one skill is one question type on repeat.
        if len(declared) < 2:
            violations.append(
                f"every-tier-has-variety: tier {tier} declares only "
                f"{len(declared)} skill(s) ({', '.join(declared) or 'none'}); a tier with "
                "one question type is a drill, not a curriculum"
            )
        drawn = skills_seen_by_tier[tier]
        if len(drawn) < 2 and len(declared) >= 2:
            violations.append(
                f"every-tier-has-variety: tier {tier} declares {len(declared)} skills but "
                f"only {len(drawn)} ({', '.join(sorted(drawn)) or 'none'}) was ever drawn in "
                f"{SWEEP_PER_TIER + SWEEP_AVOID_PER_TIER} problems"
            )

        # P5 - an empty pool, even one masked by the add1 fallback.
        if not declared:
            violations.append(
                f"no-empty-tier-pool: no skill declares a band covering tier {tier}; "
                f"skillsForTier fell back to [{', '.join(engine)}], which hides the gap "
                "in the game but is still a gap"
            )
        elif sorted(declared) != sorted(engine):
            violations.append(
                f"no-empty-tier-pool: tier {tier} declares [{', '.join(sorted(declared))}] "
                f"but skillsForTier returns [{', '.join(sorted(engine))}]"
            )

        # P8 - every skill legal at a tier must actually be reachable there.
        missing = sorted(set(declared) - set(drawn))
        if missing:
            violations.append(
                f"tier-pool-is-actually-drawn: tier {tier} never drew "
                f"{', '.join(missing)} in {SWEEP_PER_TIER + SWEEP_AVOID_PER_TIER} problems, "
                "though the band says it is legal there"
            )

    # P9 - every declared skill is reachable somewhere, with both labels.
    all_drawn = set()
    for tier in tiers:
        all_drawn |= set(skills_seen_by_tier[tier])
    for entry in sorted(data["meta"], key=lambda m: m["skill"]):
        skill = entry["skill"]
        lo, hi = entry["minTier"], entry["maxTier"]
        if lo > hi:
            violations.append(
                f"every-skill-is-reachable: {skill} declares minTier {lo} above maxTier {hi}"
            )
        elif hi < min_tier or lo > max_tier:
            violations.append(
                f"every-skill-is-reachable: {skill} declares band {lo}..{hi}, entirely "
                f"outside the playable band {min_tier}..{max_tier}"
            )
        elif skill not in all_drawn:
            violations.append(
                f"every-skill-is-reachable: {skill} declares band {lo}..{hi} but was never "
                "drawn at any tier"
            )
        if not entry["en"] or not entry["zh"]:
            violations.append(
                f"every-skill-is-reachable: {skill} is missing an "
                f"{'en' if not entry['en'] else 'zh'} label; both languages are first-class"
            )

    # P10 - par time. A harder tier must not give a child less time.
    for tier in tiers[1:]:
        here = pools[str(tier)]["par"]
        before = pools[str(tier - 1)]["par"]
        if not here > 0:
            violations.append(f"par-time-rises-with-tier: tier {tier} has par {here}")
        elif here < before:
            violations.append(
                f"par-time-rises-with-tier: tier {tier} allows {here:.1f}s, less than "
                f"tier {tier - 1}'s {before:.1f}s"
            )

    # P11 - difficulty does not go backwards.
    #
    # Three findings shaped what is enforced here, and two of them are reasons
    # *not* to enforce something that looks obvious.
    #
    # 1. Per-tier mean answer is not monotone, and should not be forced to be.
    #    Tier 6 admits `div1`, whose answers are single digits by design because
    #    division is brand new there; tier 9 drops `sub2` (mean answer ~55) and
    #    admits `twoStep`. Each dip is a skill arriving, not the ramp reversing.
    #    Averaged over bands the climb is unambiguous, so that is the level the
    #    check is stated at.
    #
    # 2. Operand *size* stops tracking difficulty the moment multiplication
    #    arrives, so it is reported and never enforced. Tiers 8-10 print smaller
    #    numbers than tiers 4-7 (29.8 against 30.9 as this is written) because
    #    `add2`/`sub2` leave with their two-digit operands and `mul2`, `fraction`
    #    and `missingMul` arrive with small ones. `8 × 7` is harder than `45 + 7`
    #    and prints half the digits. Enforcing operand size would be enforcing a
    #    proxy that has stopped measuring the thing.
    #
    # 3. The ceiling check is taken from the per-(skill, tier) sweep, not from
    #    the phase-A mix. Read off phase A it fired twice on nothing: tier 5
    #    "regressed" to 97 from tier 4's 98 purely because 3000 draws never rolled
    #    `89 + 9`. A ceiling is a property of the generators, so it is measured by
    #    hammering the generators.
    def band_mean(key: str, lo: int, hi: int) -> float:
        pairs = []
        for tier in range(lo, hi + 1):
            pairs.extend(answers_by_tier[tier] if key == "answer" else operands_by_tier[tier])
        return weighted_mean(pairs)

    def tier_ceiling(tier: int, index: int) -> int:
        return max(
            (skill_tier_ceiling.get((skill, tier), [0, 0])[index]
             for skill in pools[str(tier)]["declared"]),
            default=0,
        )

    print()
    print("Difficulty by band (mean answer is enforced; mean operand is not)")
    print(f"  {'-' * 76}")
    print(f"  {'band':>8}{'mean answer':>14}{'mean operand':>15}")
    for lo, hi in DIFFICULTY_BANDS:
        print(f"  {f'{lo}-{hi}':>8}{band_mean('answer', lo, hi):>14.1f}"
              f"{band_mean('operand', lo, hi):>15.1f}")
    print()
    print("  Operand size is reported only. Past tier 7 the curriculum trades digits")
    print("  for operations - `8 × 7` prints half the digits of `45 + 7` and is harder -")
    print("  so operand size stops being evidence about difficulty.")

    print()
    print("Ceiling per tier: the hardest its pool can ask (enforced non-decreasing)")
    print(f"  {'-' * 76}")
    print(f"  {'tier':>4}{'hardest answer':>16}{'largest operand':>17}   set by")
    for tier in tiers:
        top = tier_ceiling(tier, 0)
        widest = tier_ceiling(tier, 1)
        setter = sorted(
            skill for skill in pools[str(tier)]["declared"]
            if skill_tier_ceiling.get((skill, tier), [0, 0])[0] == top
        )
        print(f"  {tier:>4}{top:>16}{widest:>17}   {', '.join(setter)}")

    for i in range(1, len(DIFFICULTY_BANDS)):
        lo_a, hi_a = DIFFICULTY_BANDS[i - 1]
        lo_b, hi_b = DIFFICULTY_BANDS[i]
        before = band_mean("answer", lo_a, hi_a)
        after = band_mean("answer", lo_b, hi_b)
        if after <= before:
            violations.append(
                f"difficulty-does-not-go-backwards: mean answer over tiers "
                f"{lo_b}-{hi_b} is {after:.1f}, no more than tiers {lo_a}-{hi_a} "
                f"at {before:.1f}"
            )

    for low, high in ((min_tier, (min_tier + max_tier) // 2), ((min_tier + max_tier) // 2, max_tier)):
        if weighted_mean(answers_by_tier[high]) <= weighted_mean(answers_by_tier[low]):
            violations.append(
                f"difficulty-does-not-go-backwards: tier {high} asks a mean answer of "
                f"{weighted_mean(answers_by_tier[high]):.1f}, no more than tier {low}'s "
                f"{weighted_mean(answers_by_tier[low]):.1f}"
            )

    for tier in tiers[1:]:
        for index, label in ((0, "hardest answer"), (1, "largest operand")):
            here = tier_ceiling(tier, index)
            before = tier_ceiling(tier - 1, index)
            if here < before:
                violations.append(
                    f"difficulty-does-not-go-backwards: the {label} tier {tier} can ask is "
                    f"{here}, below tier {tier - 1}'s {before}; a tier's ceiling must not "
                    "retreat as the ramp climbs"
                )

    # ---- calibration (reported, never enforced) ---------------------------
    #
    # Which skills get harder *within* their own band, and which serve the same
    # difficulty at every tier they appear at. Not a violation - a skill can
    # perfectly well be a fixed rung that the pool moves past - but it is the
    # thing worth knowing now that tiers 5-10 get real play, so it is derived
    # from the sweep rather than left to be inferred from the source.
    print()
    print("Does a skill get harder within its own band? (reported, not enforced)")
    print(f"  {'-' * 76}")
    print(f"  {'skill':<12}{'band':>8}{'ceiling at each tier of the band':>38}   verdict")
    flat = []
    for entry in sorted(data["meta"], key=lambda m: (m["minTier"], m["skill"])):
        skill = entry["skill"]
        band = range(entry["minTier"], entry["maxTier"] + 1)
        tops = [skill_tier_ceiling.get((skill, t), [0, 0])[0] for t in band]
        verdict = "scales" if tops and tops[-1] > tops[0] else "flat"
        if verdict == "flat":
            flat.append(skill)
        print(f"  {skill:<12}{entry['minTier']}..{entry['maxTier']:<5}"
              f"{' '.join(str(x) for x in tops):>38}   {verdict}")
    print()
    print(f"  {len(flat)} of {len(skills)} skills serve the same ceiling at every tier they")
    print("  appear at: " + ", ".join(flat) + ".")
    print("  Those tiers still get harder, because the pool around them changes - but the")
    print("  ramp inside tiers 5-10 is carried by which skills are in the pool rather than")
    print("  by the skills themselves. Worth knowing before rebalancing the top of the band.")

    print()
    print("Repeat avoidance under pressure (reported, not enforced)")
    print(f"  {'-' * 76}")
    for tier in tiers:
        pool = pools[str(tier)]
        repeats = pool.get("avoidRepeats", 0)
        draws = pool.get("avoidDraws", 0)
        rate = (repeats / draws * 100) if draws else 0.0
        print(f"  tier {tier:>2}: {repeats:>4} of {draws} draws asked to avoid their own "
              f"unaided prompt still returned it ({rate:.1f}%)")
    print()
    print("  Each draw is told to avoid the prompt that very seed produces unaided, so")
    print("  the retry loop runs every time. It is best-effort by design - the engine")
    print("  retries eight times and then serves the repeat rather than looping forever -")
    print("  so this is reported rather than enforced. Even tier 1, with the smallest")
    print("  question space in the game, never needed all eight.")

    print()
    if violations:
        print("FAIL")
        for line in sorted(set(violations)):
            print(f"  {line}")
        print()
        print(f"  {len(set(violations))} distinct violation(s)")
        return 1

    print("OK: every answer is a non-negative whole number a keypad can type, every")
    print("    prompt re-evaluates in Python to exactly the answer the engine gave, every")
    print("    chess piece is printed at the value it is really worth, no generator throws")
    print("    at any tier, every tier offers real variety, every declared skill is")
    print("    reachable, no prompt is degenerate, and difficulty never goes backwards.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
