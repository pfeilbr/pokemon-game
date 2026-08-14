import { describe, expect, it } from 'vitest';
import {
  ADAPT_WINDOW,
  MAX_TIER,
  MIN_TIER,
  PATIENCE_WINDOW,
  SKILLS,
  SKILL_META,
  type Attempt,
  accuracyOf,
  averageSeconds,
  clampTier,
  generateProblem,
  mergeSkillStats,
  nextTier,
  parTimeForTier,
  skillsForTier,
  summariseAttempts,
} from './math';
import { createRng } from './rng';

const TIERS = Array.from({ length: MAX_TIER }, (_, i) => i + 1);

describe('generateProblem', () => {
  it('is deterministic for a given seed and tier', () => {
    for (const tier of TIERS) {
      const a = generateProblem('seed-1', tier);
      const b = generateProblem('seed-1', tier);
      expect(a).toEqual(b);
    }
  });

  it('produces different problems for different seeds', () => {
    const prompts = new Set(Array.from({ length: 40 }, (_, i) => generateProblem(i, 5).prompt));
    expect(prompts.size).toBeGreaterThan(20);
  });

  /**
   * The important one. Every tier, many seeds: the generator must never throw
   * and must never produce an answer a child cannot type on a numeric keypad.
   */
  it('never throws and always yields a non-negative integer answer', () => {
    for (const tier of TIERS) {
      for (let seed = 0; seed < 400; seed++) {
        const p = generateProblem(seed, tier);
        expect(Number.isInteger(p.answer)).toBe(true);
        expect(p.answer).toBeGreaterThanOrEqual(0);
        expect(p.answer).toBeLessThanOrEqual(999);
        expect(p.prompt).toMatch(/\S/);
        expect(p.tier).toBe(tier);
        expect(p.parTime).toBeGreaterThan(0);
      }
    }
  });

  it('yields a prompt whose arithmetic actually matches the answer', () => {
    // Re-evaluates each prompt independently of the generator that made it.
    const evaluate = (prompt: string): number | null => {
      // Chess prompts print each piece's value beside it, so they are added up
      // from what is on the screen. Whether the printed value is the piece's
      // real value is a separate question, asked further down.
      if (/[♔-♟]/.test(prompt)) {
        const squad = (text: string): number[] | null => {
          const values: number[] = [];
          for (const term of text.split(' + ')) {
            const piece = term.match(/^[♟♞♝♜♛](\d+)$/);
            if (!piece) return null;
            values.push(Number(piece[1]));
          }
          return values;
        };
        const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

        const lead = prompt.match(/^\((.+)\) − \((.+)\)$/);
        if (lead) {
          const ahead = squad(lead[1] ?? '');
          const behind = squad(lead[2] ?? '');
          return ahead && behind ? sum(ahead) - sum(behind) : null;
        }
        const swap = prompt.match(/^(.+) \+ \? = (.+)$/);
        if (swap) {
          const held = squad(swap[1] ?? '');
          const target = squad(swap[2] ?? '');
          return held && target ? sum(target) - sum(held) : null;
        }
        const pieces = squad(prompt);
        return pieces ? sum(pieces) : null;
      }

      const fraction = prompt.match(/^([½⅓¼]) of (\d+)$/);
      if (fraction) {
        const d = { '½': 2, '⅓': 3, '¼': 4 }[fraction[1]!]!;
        return Number(fraction[2]) / d;
      }
      const twoStep = prompt.match(/^\((\d+) × (\d+)\) \+ (\d+)$/);
      if (twoStep) return Number(twoStep[1]) * Number(twoStep[2]) + Number(twoStep[3]);

      const missing = prompt.match(/^(\d+) ([+×]) \? = (\d+)$/);
      if (missing) {
        const [, a, op, total] = missing;
        return op === '+' ? Number(total) - Number(a) : Number(total) / Number(a);
      }
      const binary = prompt.match(/^(\d+) ([+−×÷]) (\d+)$/);
      if (binary) {
        const [, a, op, b] = binary;
        const x = Number(a);
        const y = Number(b);
        if (op === '+') return x + y;
        if (op === '−') return x - y;
        if (op === '×') return x * y;
        return x / y;
      }
      return null;
    };

    for (const tier of TIERS) {
      for (let seed = 0; seed < 200; seed++) {
        const p = generateProblem(seed, tier);
        const evaluated = evaluate(p.prompt);
        expect(evaluated, `unparsed prompt: ${p.prompt}`).not.toBeNull();
        expect(evaluated, `wrong answer for ${p.prompt}`).toBe(p.answer);
      }
    }
  });

  it('only draws skills legal for the tier', () => {
    for (const tier of TIERS) {
      const legal = new Set(skillsForTier(tier).map((m) => m.skill));
      for (let seed = 0; seed < 120; seed++) {
        expect(legal.has(generateProblem(seed, tier).skill)).toBe(true);
      }
    }
  });

  it('gets harder on average as the tier climbs', () => {
    const meanAnswer = (tier: number) => {
      let total = 0;
      for (let seed = 0; seed < 300; seed++) total += generateProblem(seed, tier).answer;
      return total / 300;
    };
    expect(meanAnswer(1)).toBeLessThan(meanAnswer(5));
    expect(meanAnswer(5)).toBeLessThan(meanAnswer(10));
  });

  it('avoids repeating the problem it was told to avoid', () => {
    let avoided = 0;
    for (let seed = 0; seed < 200; seed++) {
      const first = generateProblem(seed, 3);
      const second = generateProblem(seed, 3, first.prompt);
      if (second.prompt !== first.prompt) avoided++;
    }
    // The retry loop is best-effort, but it should work nearly every time.
    expect(avoided).toBeGreaterThan(190);
  });

  it('clamps out-of-range tiers instead of failing', () => {
    expect(generateProblem(1, -5).tier).toBe(MIN_TIER);
    expect(generateProblem(1, 99).tier).toBe(MAX_TIER);
    expect(generateProblem(1, Number.NaN).tier).toBe(MIN_TIER);
  });
});

describe('skill coverage', () => {
  it('leaves no tier without skills', () => {
    for (const tier of TIERS) {
      expect(skillsForTier(tier).length).toBeGreaterThan(0);
    }
  });

  it('uses every declared skill at some tier', () => {
    const used = new Set(TIERS.flatMap((t) => skillsForTier(t).map((m) => m.skill)));
    expect([...used].sort()).toEqual([...SKILLS].sort());
  });

  it('gives every skill a coherent tier band and both labels', () => {
    for (const skill of SKILLS) {
      const meta = SKILL_META[skill];
      expect(meta.minTier).toBeLessThanOrEqual(meta.maxTier);
      expect(meta.minTier).toBeGreaterThanOrEqual(MIN_TIER);
      expect(meta.maxTier).toBeLessThanOrEqual(MAX_TIER);
      expect(meta.label.en).toMatch(/\S/);
      expect(meta.label.zh).toMatch(/\S/);
    }
  });

  it('gives more time at higher tiers', () => {
    expect(parTimeForTier(1)).toBeLessThan(parTimeForTier(10));
  });
});

/**
 * The chess strand.
 *
 * These are properties about the *chess*, not about the arithmetic - the sweep
 * above already re-derives every answer. What they protect is the reason the
 * chess skills are allowed to exist at all: the prompt has to be answerable by a
 * child who has never seen a board, and it has to be true for the one who has.
 */
describe('the chess strand', () => {
  const CHESS_SKILLS = ['chessValue', 'chessSwap', 'chessLead'] as const;
  /** Restated on purpose: a test that imported the table could not catch it. */
  const REAL_VALUES: Record<string, number> = { '♟': 1, '♞': 3, '♝': 3, '♜': 5, '♛': 9 };

  /** Every chess problem the generators can produce, swept across their bands. */
  const sweep = (): { skill: string; tier: number; prompt: string; answer: number }[] => {
    const out: { skill: string; tier: number; prompt: string; answer: number }[] = [];
    for (const skill of CHESS_SKILLS) {
      const meta = SKILL_META[skill];
      for (let tier = meta.minTier; tier <= meta.maxTier; tier++) {
        const rng = createRng(`math.test:${skill}:${tier}`);
        for (let i = 0; i < 3000; i++) {
          const { prompt, answer } = meta.generate(rng, tier);
          out.push({ skill, tier, prompt, answer });
        }
      }
    }
    return out;
  };

  // Deterministic, so it is swept once and shared rather than rebuilt per test.
  const PROBLEMS = sweep();

  it('prints every piece at the value it is really worth', () => {
    // The prompt is self-contained *because* of these numbers. Get one wrong
    // and the arithmetic still checks out - the sum agrees with itself - while
    // a seven-year-old is quietly taught that a pawn is worth a rook.
    for (const { prompt } of PROBLEMS) {
      for (const [, glyph, printed] of prompt.matchAll(/([♟♞♝♜♛])(\d+)/g)) {
        expect(Number(printed), `${prompt} prints ${glyph}${printed}`).toBe(REAL_VALUES[glyph!]);
      }
    }
  });

  it('never shows a piece without its value, so the question needs no chess', () => {
    for (const { prompt } of PROBLEMS) {
      // Every chess glyph in the prompt is immediately followed by a digit.
      expect(prompt.replace(/[♟♞♝♜♛]\d/g, ''), prompt).not.toMatch(/[♔-♟]/);
    }
  });

  it('never shows a king, which has no value because it is never traded', () => {
    for (const { prompt } of PROBLEMS) {
      expect(prompt, prompt).not.toMatch(/[♔♚]/);
    }
  });

  it('asks how far ahead, never what the difference is', () => {
    // A lead of zero is not a lead, and a lead below zero cannot be typed on a
    // keypad with no minus key. Both are excluded by construction.
    for (const { skill, prompt, answer } of PROBLEMS) {
      if (skill !== 'chessLead') continue;
      expect(answer, prompt).toBeGreaterThan(0);
    }
  });

  it('never asks a trade that is already even', () => {
    for (const { skill, prompt, answer } of PROBLEMS) {
      if (skill !== 'chessSwap') continue;
      expect(answer, prompt).toBeGreaterThan(0);
    }
  });

  it('always counts at least one piece worth more than a pawn', () => {
    // A row of 1s can be answered without ever looking at which piece is which,
    // which is the one thing this skill is for.
    for (const { skill, prompt } of PROBLEMS) {
      if (skill !== 'chessValue') continue;
      expect(prompt, prompt).toMatch(/[♞♝♜♛]/);
    }
  });

  it('reaches every tier of the ladder', () => {
    // He goes to chess camp every week, not at tier 4. Whatever difficulty the
    // adapter settles on, some of the questions should look like his other
    // hobby.
    for (const tier of TIERS) {
      const chess = skillsForTier(tier).filter((m) => m.skill.startsWith('chess'));
      expect(chess.length, `tier ${tier} has no chess`).toBeGreaterThan(0);
    }
  });

  it('gets harder up the ladder rather than repeating one question', () => {
    const hardest = (skill: (typeof CHESS_SKILLS)[number], tier: number): number =>
      PROBLEMS.filter((p) => p.skill === skill && p.tier === tier)
        .reduce((top, p) => Math.max(top, p.answer), 0);

    expect(hardest('chessValue', 5)).toBeGreaterThan(hardest('chessValue', 1));
    expect(hardest('chessSwap', 8)).toBeGreaterThan(hardest('chessSwap', 4));
    expect(hardest('chessLead', 10)).toBeGreaterThan(hardest('chessLead', 7));
  });
});

describe('clampTier', () => {
  it('keeps tiers inside the legal band', () => {
    expect(clampTier(0)).toBe(MIN_TIER);
    expect(clampTier(-99)).toBe(MIN_TIER);
    expect(clampTier(11)).toBe(MAX_TIER);
    expect(clampTier(5)).toBe(5);
    expect(clampTier(5.4)).toBe(5);
    expect(clampTier(Number.NaN)).toBe(MIN_TIER);
    expect(clampTier(Number.POSITIVE_INFINITY)).toBe(MIN_TIER);
  });
});

describe('nextTier', () => {
  const attempt = (correct: boolean, elapsedMs = 3000): Attempt => ({
    skill: 'add1',
    tier: 5,
    correct,
    elapsedMs,
  });

  it('holds steady without a full window of evidence', () => {
    expect(nextTier(5, [attempt(true), attempt(true)])).toBe(5);
    expect(nextTier(5, [])).toBe(5);
  });

  it('promotes on a fast, accurate window', () => {
    const window = Array.from({ length: ADAPT_WINDOW }, () => attempt(true, 2000));
    expect(nextTier(5, window)).toBe(6);
  });

  it('does not promote on one window when accurate but slow', () => {
    const slow = parTimeForTier(5) * 1000 + 5000;
    const window = Array.from({ length: ADAPT_WINDOW }, () => attempt(true, slow));
    expect(nextTier(5, window)).toBe(5);
  });

  it('promotes an accurate but slow player once the patient window fills', () => {
    // The whole point of the second window. Speed buys a promotion in eight
    // questions; getting them right buys the same promotion in sixteen. Being
    // slow on the keypad delays the climb, it does not cap it.
    const slow = parTimeForTier(5) * 1000 + 5000;
    const window = Array.from({ length: PATIENCE_WINDOW }, () => attempt(true, slow));
    expect(nextTier(5, window)).toBe(6);
  });

  it('does not let the patient window rescue a player who is not accurate', () => {
    // 14/16 = 0.875: over the promote threshold on any eight of them, under the
    // near-perfect bar the patient path asks for. Patience is for a child who
    // has the maths and is slow on the keypad, not one who is still guessing.
    const slow = parTimeForTier(5) * 1000 + 5000;
    const window = Array.from({ length: PATIENCE_WINDOW }, (_, i) => attempt(i % 8 !== 0, slow));
    expect(nextTier(5, window)).toBe(5);
  });

  it('demotes on a poor window', () => {
    const window = Array.from({ length: ADAPT_WINDOW }, (_, i) => attempt(i < 2));
    expect(nextTier(5, window)).toBe(4);
  });

  it('holds in the middle band rather than oscillating', () => {
    // 6/8 = 0.75, between the down (0.6) and up (0.85) thresholds.
    const window = Array.from({ length: ADAPT_WINDOW }, (_, i) => attempt(i < 6));
    expect(nextTier(5, window)).toBe(5);
  });

  it('rescues a child who is getting everything wrong before the window fills', () => {
    expect(nextTier(5, [attempt(false), attempt(false), attempt(false)])).toBe(4);
  });

  it('never escapes the tier band', () => {
    const perfect = Array.from({ length: ADAPT_WINDOW }, () => attempt(true, 1000));
    const awful = Array.from({ length: ADAPT_WINDOW }, () => attempt(false));
    expect(nextTier(MAX_TIER, perfect)).toBe(MAX_TIER);
    expect(nextTier(MIN_TIER, awful)).toBe(MIN_TIER);
  });

  it('only ever moves one tier at a time', () => {
    const perfect = Array.from({ length: 40 }, () => attempt(true, 1000));
    expect(nextTier(3, perfect)).toBe(4);
  });
});

/**
 * Properties of the ramp, swept rather than sampled.
 *
 * The cases above are hand-written points. These are the properties
 * `scripts/simulate_difficulty.py` checks across a grid of synthetic players,
 * restated here so they run in `npm test` on every change. The one that matters
 * most is `cannot vault`: the claim in CLAUDE.md that a lucky streak cannot
 * fling a child into fractions was *false* when it was first written, because
 * the rolling window was carried across a promotion and every promotion was
 * therefore decided on stale evidence.
 */
describe('nextTier properties', () => {
  /** `size` attempts, `k` of them correct, all answered at `speedFactor` x par. */
  const windowOf = (k: number, size: number, tier: number, speedFactor: number): Attempt[] =>
    Array.from({ length: size }, (_, i) => ({
      skill: 'add1',
      tier,
      correct: i < k,
      elapsedMs: Math.round(parTimeForTier(tier) * 1000 * speedFactor),
    }));

  // Well inside par, just inside, at par, over, and hopelessly over.
  const SPEEDS = [0.25, 0.6, 1, 1.5, 3];
  // Deliberately includes tiers outside the band: a corrupt save can hand any
  // number to the adapter, and it must land back inside rather than throw.
  const INPUT_TIERS = Array.from({ length: MAX_TIER + 7 }, (_, i) => i + MIN_TIER - 3);

  const sweep = (visit: (tier: number, k: number, size: number, speed: number) => void): void => {
    for (const tier of INPUT_TIERS) {
      for (let size = 0; size <= ADAPT_WINDOW * 2; size++) {
        for (let k = 0; k <= size; k++) {
          for (const speed of SPEEDS) visit(tier, k, size, speed);
        }
      }
    }
  };

  it('never moves more than one tier in a single update, for any window', () => {
    sweep((tier, k, size, speed) => {
      const result = nextTier(tier, windowOf(k, size, clampTier(tier), speed));
      expect(
        Math.abs(result - clampTier(tier)),
        `tier ${tier} -> ${result} on ${k}/${size} at ${speed}x par`,
      ).toBeLessThanOrEqual(1);
    });
  });

  it('never returns a tier outside the band, whatever it is given', () => {
    sweep((tier, k, size, speed) => {
      const result = nextTier(tier, windowOf(k, size, clampTier(tier), speed));
      expect(result, `tier ${tier} on ${k}/${size} at ${speed}x par`).toBeGreaterThanOrEqual(
        MIN_TIER,
      );
      expect(result).toBeLessThanOrEqual(MAX_TIER);
    });
  });

  it('never promotes on less than a full window of evidence', () => {
    sweep((tier, k, size, speed) => {
      if (size >= ADAPT_WINDOW) return;
      const result = nextTier(tier, windowOf(k, size, clampTier(tier), speed));
      expect(
        result,
        `promoted from ${tier} on only ${size} attempts (${k} correct, ${speed}x par)`,
      ).toBeLessThanOrEqual(clampTier(tier));
    });
  });

  it('is monotone in accuracy: more correct answers never lands lower', () => {
    for (const tier of INPUT_TIERS) {
      for (const speed of SPEEDS) {
        for (let k = 0; k < ADAPT_WINDOW; k++) {
          const worse = nextTier(tier, windowOf(k, ADAPT_WINDOW, clampTier(tier), speed));
          const better = nextTier(tier, windowOf(k + 1, ADAPT_WINDOW, clampTier(tier), speed));
          expect(better, `tier ${tier}, ${k} vs ${k + 1} correct`).toBeGreaterThanOrEqual(worse);
        }
      }
    }
  });

  it('is monotone in speed: answering slower never lands higher', () => {
    for (const tier of INPUT_TIERS) {
      for (let k = 0; k <= ADAPT_WINDOW; k++) {
        for (let i = 1; i < SPEEDS.length; i++) {
          const faster = nextTier(tier, windowOf(k, ADAPT_WINDOW, clampTier(tier), SPEEDS[i - 1]!));
          const slower = nextTier(tier, windowOf(k, ADAPT_WINDOW, clampTier(tier), SPEEDS[i]!));
          expect(slower, `tier ${tier}, ${k} correct, ${SPEEDS[i]}x par`).toBeLessThanOrEqual(
            faster,
          );
        }
      }
    }
  });

  it('reads the window as a set, not a sequence', () => {
    // Same score, same average speed, different order: same decision. A child
    // who stumbles early and recovers is in the same place as one who does not.
    for (let k = 0; k <= ADAPT_WINDOW; k++) {
      const front = windowOf(k, ADAPT_WINDOW, 5, 0.5);
      const back = [...front].reverse();
      expect(nextTier(5, back)).toBe(nextTier(5, front));
    }
  });
});

describe('the ramp over a whole play session', () => {
  const answer = (tier: number, correct: boolean, speedFactor: number): Attempt => ({
    skill: 'add1',
    tier,
    correct,
    elapsedMs: Math.round(parTimeForTier(tier) * 1000 * speedFactor),
  });

  /**
   * Walks a synthetic player question by question.
   *
   * The window is cleared on a tier change because that is the discipline
   * `applyBattleResult` enforces: every attempt in it was answered at the
   * *previous* difficulty, so carrying it forward would promote again on the
   * very next question. Carrying it is precisely the bug that let a perfect run
   * climb from adding-to-20 to two-step expressions in sixteen questions.
   */
  const play = (questions: number, isCorrect: (i: number) => boolean, speedFactor: number) => {
    let tier = MIN_TIER;
    let window: Attempt[] = [];
    let tierSum = 0;
    let highest = tier;
    const reachedTop: number[] = [];

    for (let i = 0; i < questions; i++) {
      tierSum += tier;
      window = [...window, answer(tier, isCorrect(i), speedFactor)].slice(-PATIENCE_WINDOW);
      const next = nextTier(tier, window);
      expect(
        Math.abs(next - tier),
        `jumped ${tier} -> ${next} at question ${i}`,
      ).toBeLessThanOrEqual(1);
      if (next !== tier) {
        tier = next;
        window = [];
        if (tier > highest) highest = tier;
        if (tier === MAX_TIER && reachedTop.length === 0) reachedTop.push(i + 1);
      }
      expect(tier).toBeGreaterThanOrEqual(MIN_TIER);
      expect(tier).toBeLessThanOrEqual(MAX_TIER);
    }

    return { tier, highest, meanTier: tierSum / questions, questionsToTop: reachedTop[0] ?? null };
  };

  it('cannot be vaulted: every tier costs a full window, even played perfectly', () => {
    const run = play(400, () => true, 0.25);
    expect(run.tier).toBe(MAX_TIER);
    // Nine promotions, eight questions of fresh evidence each. Anything less
    // means a promotion was granted on evidence from an easier tier.
    expect(run.questionsToTop).toBeGreaterThanOrEqual((MAX_TIER - MIN_TIER) * ADAPT_WINDOW);
  });

  /**
   * This pair replaces a test that asserted a slow perfect player never leaves
   * tier 1 at all. That test passed, and it was wrong: 400 correct answers in a
   * row, still on "adding to 20", because a seven-year-old hunting for digits on
   * an on-screen keypad reads as "not fluent" to a clock. CLAUDE.md has always
   * said slowness is not punished; a permanent difficulty cap is the harshest
   * punishment in the game. Speed still buys the faster climb - that is the
   * claim these two now make together.
   */
  it('lets a slow but accurate player reach the top eventually', () => {
    const run = play(900, () => true, 1.5);
    expect(run.tier).toBe(MAX_TIER);
  });

  it('still climbs faster for a fast player than a slow one', () => {
    const fast = play(900, () => true, 0.25);
    const slow = play(900, () => true, 1.5);
    expect(fast.questionsToTop).not.toBeNull();
    expect(slow.questionsToTop).toBeGreaterThan(fast.questionsToTop!);
  });

  it('never promotes a slow player who is merely good rather than accurate', () => {
    // 7/8 correct: enough to promote if he were quick, never enough to be
    // carried by patience alone.
    const run = play(400, (i) => i % 8 !== 0, 1.5);
    expect(run.highest).toBe(MIN_TIER);
  });

  it('does not let a struggling player drift upward', () => {
    // A coin-flip player, answering fast: fast enough to promote whenever the
    // window happens to come up 7/8, which it will a few times in 600
    // questions. That single bump is the rolling window doing its job. What
    // must not happen is a sustained climb, so this asserts the drift.
    const rng = createRng('math.test:struggling');
    const run = play(600, () => rng.next() < 0.5, 0.25);
    expect(run.meanTier).toBeLessThan(MIN_TIER + 1);
    expect(run.highest).toBeLessThanOrEqual(MIN_TIER + 3);
  });

  it('lets a strong player climb the whole ladder', () => {
    // 7 of every 8 correct is exactly the promotion threshold: he should top
    // out, so the ramp is not merely safe but actually reachable.
    const run = play(400, (i) => i % 8 !== 7, 0.5);
    expect(run.tier).toBe(MAX_TIER);
  });
});

describe('stats', () => {
  const attempts: Attempt[] = [
    { skill: 'add1', tier: 1, correct: true, elapsedMs: 2000 },
    { skill: 'add1', tier: 1, correct: false, elapsedMs: 4000 },
    { skill: 'mul1', tier: 5, correct: true, elapsedMs: 3000 },
  ];

  it('summarises per skill', () => {
    const stats = summariseAttempts(attempts);
    expect(stats.add1).toEqual({ attempts: 2, correct: 1, totalMs: 6000 });
    expect(stats.mul1).toEqual({ attempts: 1, correct: 1, totalMs: 3000 });
    expect(stats.div1).toBeUndefined();
  });

  it('summarises an empty list to an empty object', () => {
    expect(summariseAttempts([])).toEqual({});
  });

  it('merges stats additively', () => {
    const merged = mergeSkillStats(summariseAttempts(attempts), summariseAttempts(attempts));
    expect(merged.add1).toEqual({ attempts: 4, correct: 2, totalMs: 12000 });
  });

  it('merges into an empty base', () => {
    expect(mergeSkillStats({}, summariseAttempts(attempts)).mul1?.attempts).toBe(1);
  });

  it('does not mutate its inputs', () => {
    const base = summariseAttempts(attempts);
    const snapshot = JSON.stringify(base);
    mergeSkillStats(base, summariseAttempts(attempts));
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it('reports accuracy and average time, tolerating missing data', () => {
    const stats = summariseAttempts(attempts);
    expect(accuracyOf(stats.add1)).toBe(0.5);
    expect(averageSeconds(stats.add1)).toBe(3);
    expect(accuracyOf(undefined)).toBe(0);
    expect(averageSeconds(undefined)).toBe(0);
    expect(accuracyOf({ attempts: 0, correct: 0, totalMs: 0 })).toBe(0);
  });
});
