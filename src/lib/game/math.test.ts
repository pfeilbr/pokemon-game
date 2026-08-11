import { describe, expect, it } from 'vitest';
import {
  ADAPT_WINDOW,
  MAX_TIER,
  MIN_TIER,
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

  it('does not promote when accurate but slow', () => {
    const slow = parTimeForTier(5) * 1000 + 5000;
    const window = Array.from({ length: ADAPT_WINDOW }, () => attempt(true, slow));
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
