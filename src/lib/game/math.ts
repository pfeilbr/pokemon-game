import { createRng, type Rng } from './rng';

/**
 * Problem generation and adaptive difficulty.
 *
 * Every attack in a battle is gated behind a maths problem, so this module is
 * really the curriculum. Design rules:
 *
 *  - Answers are always non-negative whole numbers. A seven-year-old types on
 *    an on-screen keypad; negatives and decimals would be a UX tax, not a
 *    lesson.
 *  - Generation is seeded and pure, so a battle replays identically in tests.
 *  - Difficulty adapts on a rolling window of recent answers rather than a
 *    lifetime average, so a good day moves him up quickly and a bad day eases
 *    off just as fast.
 */

export const SKILLS = [
  'add1',
  'doubles',
  'sub1',
  'add2',
  'sub2',
  'missingAdd',
  'mul1',
  'mul2',
  'div1',
  'missingMul',
  'add3',
  'fraction',
  'twoStep',
] as const;

export type Skill = (typeof SKILLS)[number];

export const MIN_TIER = 1;
export const MAX_TIER = 10;

export type Problem = {
  /** Stable within a battle; used as a React key and for de-duping. */
  id: string;
  skill: Skill;
  tier: number;
  /** Display string, e.g. "7 × 8". Rendered as-is. */
  prompt: string;
  answer: number;
  /** Seconds a fluent solver should need. Drives the speed bonus. */
  parTime: number;
};

export type SkillMeta = {
  skill: Skill;
  label: { en: string; zh: string };
  /** Lowest difficulty tier at which this skill can appear. */
  minTier: number;
  /** Highest tier at which it still appears (beyond this it is too easy). */
  maxTier: number;
  generate: (rng: Rng, tier: number) => { prompt: string; answer: number };
};

/**
 * Picks two single-digit addends whose sum lands in [lo, hi].
 *
 * Two digits of 1..9 can only reach 18, so the requested range is clamped
 * rather than trusted - otherwise a total of 19 or 20 would leave no legal
 * first addend and the generator would throw mid-battle.
 */
function addPair(rng: Rng, lo: number, hi: number): [number, number] {
  const low = Math.min(Math.max(2, Math.round(lo)), 18);
  const high = Math.min(Math.max(low, Math.round(hi)), 18);
  const total = rng.int(low, high);
  const a = rng.int(Math.max(1, total - 9), Math.min(9, total - 1));
  return [a, total - a];
}

export const SKILL_META: Record<Skill, SkillMeta> = {
  add1: {
    skill: 'add1',
    label: { en: 'Adding to 20', zh: '20以内加法' },
    minTier: 1,
    maxTier: 4,
    generate: (rng, tier) => {
      const [a, b] = addPair(rng, tier <= 1 ? 3 : 6, tier <= 1 ? 10 : 20);
      return { prompt: `${a} + ${b}`, answer: a + b };
    },
  },
  doubles: {
    skill: 'doubles',
    label: { en: 'Doubles', zh: '加倍' },
    minTier: 1,
    maxTier: 3,
    generate: (rng, tier) => {
      const a = rng.int(2, tier <= 1 ? 6 : 12);
      return { prompt: `${a} + ${a}`, answer: a * 2 };
    },
  },
  sub1: {
    skill: 'sub1',
    label: { en: 'Subtracting to 20', zh: '20以内减法' },
    minTier: 2,
    maxTier: 5,
    generate: (rng, tier) => {
      const a = rng.int(5, tier <= 2 ? 12 : 20);
      const b = rng.int(1, a - 1);
      return { prompt: `${a} − ${b}`, answer: a - b };
    },
  },
  add2: {
    skill: 'add2',
    label: { en: 'Two-digit adding', zh: '两位数加法' },
    minTier: 3,
    maxTier: 7,
    generate: (rng) => {
      const a = rng.int(11, 89);
      const b = rng.int(2, 9);
      return { prompt: `${a} + ${b}`, answer: a + b };
    },
  },
  sub2: {
    skill: 'sub2',
    label: { en: 'Two-digit subtracting', zh: '两位数减法' },
    minTier: 4,
    maxTier: 8,
    generate: (rng) => {
      const a = rng.int(21, 99);
      const b = rng.int(2, 9);
      return { prompt: `${a} − ${b}`, answer: a - b };
    },
  },
  missingAdd: {
    skill: 'missingAdd',
    label: { en: 'Missing number', zh: '填空加法' },
    minTier: 3,
    maxTier: 7,
    generate: (rng, tier) => {
      const [a, b] = addPair(rng, 6, tier <= 4 ? 15 : 20);
      return { prompt: `${a} + ? = ${a + b}`, answer: b };
    },
  },
  mul1: {
    skill: 'mul1',
    label: { en: 'Times tables', zh: '乘法口诀' },
    minTier: 5,
    maxTier: 9,
    generate: (rng, tier) => {
      const cap = tier <= 5 ? 5 : tier <= 7 ? 8 : 10;
      const a = rng.int(2, cap);
      const b = rng.int(2, cap);
      return { prompt: `${a} × ${b}`, answer: a * b };
    },
  },
  div1: {
    skill: 'div1',
    label: { en: 'Division facts', zh: '除法' },
    minTier: 6,
    maxTier: 10,
    generate: (rng, tier) => {
      const cap = tier <= 7 ? 6 : 10;
      const b = rng.int(2, cap);
      const answer = rng.int(2, cap);
      return { prompt: `${b * answer} ÷ ${b}`, answer };
    },
  },
  add3: {
    skill: 'add3',
    label: { en: 'Big adding', zh: '进位加法' },
    minTier: 6,
    maxTier: 10,
    generate: (rng) => {
      const a = rng.int(14, 79);
      const b = rng.int(14, 79);
      return { prompt: `${a} + ${b}`, answer: a + b };
    },
  },
  mul2: {
    skill: 'mul2',
    label: { en: 'Bigger multiplying', zh: '两位数乘法' },
    minTier: 8,
    maxTier: 10,
    generate: (rng) => {
      const a = rng.int(11, 29);
      const b = rng.int(3, 9);
      return { prompt: `${a} × ${b}`, answer: a * b };
    },
  },
  missingMul: {
    skill: 'missingMul',
    label: { en: 'Missing factor', zh: '填空乘法' },
    minTier: 7,
    maxTier: 10,
    generate: (rng) => {
      const a = rng.int(2, 9);
      const answer = rng.int(2, 9);
      return { prompt: `${a} × ? = ${a * answer}`, answer };
    },
  },
  fraction: {
    skill: 'fraction',
    label: { en: 'Fractions', zh: '分数' },
    minTier: 8,
    maxTier: 10,
    generate: (rng) => {
      const denominator = rng.pick([2, 3, 4] as const);
      const glyph = { 2: '½', 3: '⅓', 4: '¼' }[denominator];
      const answer = rng.int(2, 12);
      return { prompt: `${glyph} of ${denominator * answer}`, answer };
    },
  },
  twoStep: {
    skill: 'twoStep',
    label: { en: 'Two-step', zh: '两步计算' },
    minTier: 9,
    maxTier: 10,
    generate: (rng) => {
      const a = rng.int(2, 9);
      const b = rng.int(2, 9);
      const c = rng.int(2, 20);
      // Parenthesised on purpose: teaches grouping without relying on the
      // player already knowing operator precedence.
      return { prompt: `(${a} × ${b}) + ${c}`, answer: a * b + c };
    },
  },
};

export function clampTier(tier: number): number {
  if (!Number.isFinite(tier)) return MIN_TIER;
  return Math.min(MAX_TIER, Math.max(MIN_TIER, Math.round(tier)));
}

/** Skills that can appear at a tier. Never empty for tiers 1..10. */
export function skillsForTier(tier: number): SkillMeta[] {
  const t = clampTier(tier);
  const pool = SKILLS.map((s) => SKILL_META[s]).filter((m) => t >= m.minTier && t <= m.maxTier);
  // Belt and braces: if a future edit leaves a gap, fall back to the easiest skill.
  return pool.length > 0 ? pool : [SKILL_META.add1];
}

/** Seconds allowed before the speed bonus is fully gone. */
export function parTimeForTier(tier: number): number {
  return 4 + clampTier(tier) * 1.1;
}

/**
 * Generates one problem.
 *
 * `avoidPrompt` stops the generator handing out the identical problem twice in
 * a row, which feels broken to a player even though it is statistically fine.
 */
export function generateProblem(
  seed: number | string,
  tier: number,
  avoidPrompt?: string,
): Problem {
  const t = clampTier(tier);
  const rng = createRng(seed);
  const pool = skillsForTier(t);

  let chosen = rng.pick(pool);
  let result = chosen.generate(rng, t);

  for (let attempt = 0; attempt < 8 && result.prompt === avoidPrompt; attempt++) {
    chosen = rng.pick(pool);
    result = chosen.generate(rng, t);
  }

  return {
    id: `${String(seed)}:${chosen.skill}:${result.prompt}`,
    skill: chosen.skill,
    tier: t,
    prompt: result.prompt,
    answer: result.answer,
    parTime: parTimeForTier(t),
  };
}

// ---------------------------------------------------------------------------
// Adaptive difficulty
// ---------------------------------------------------------------------------

export type Attempt = {
  skill: Skill;
  tier: number;
  correct: boolean;
  /** Milliseconds from problem shown to answer submitted. */
  elapsedMs: number;
};

/** How many recent attempts feed the difficulty decision. */
export const ADAPT_WINDOW = 8;

/**
 * The longer window that promotes on accuracy alone.
 *
 * Deliberately twice `ADAPT_WINDOW`, so being quick is always the faster route
 * up and the clock keeps its meaning as a bonus.
 */
export const PATIENCE_WINDOW = ADAPT_WINDOW * 2;

const LEVEL_UP_ACCURACY = 0.85;
const LEVEL_DOWN_ACCURACY = 0.6;
/** Near-perfect: 15 of 16. Patience is not a lower bar, it is a longer one. */
const PATIENCE_ACCURACY = 0.9;

/**
 * Suggests the next difficulty tier from recent performance.
 *
 * Deliberately gentle: it moves one tier at a time and needs a full window
 * before it will promote, so a lucky streak of easy questions cannot fling a
 * child into fractions.
 *
 * There are two ways up, and the second one exists because the first was a
 * trap. Requiring accuracy *and* an average inside par sounds reasonable until
 * you notice par at tier 1 is 5.1 seconds and a seven-year-old hunting for
 * digits on an on-screen keypad takes seven. He answers four hundred questions
 * without a single mistake and stays on "adding to 20" forever, because the
 * adapter cannot tell slow hands from weak maths. That is the exact opposite of
 * this game's rule that slowness is never punished - a permanent difficulty cap
 * is the harshest punishment it has.
 *
 * So speed is a shortcut, not a gate: it buys the promotion in eight questions.
 * Sustained near-perfect accuracy buys the same promotion in sixteen, at any
 * pace at all. If he is getting essentially everything right, the questions are
 * too easy, and how fast he taps is not evidence about whether he understands.
 */
export function nextTier(currentTier: number, recent: readonly Attempt[]): number {
  const current = clampTier(currentTier);
  const sample = recent.slice(-ADAPT_WINDOW);
  if (sample.length < ADAPT_WINDOW) {
    // Not enough evidence to promote, but bail out early if he is clearly lost.
    const wrong = sample.filter((a) => !a.correct).length;
    if (sample.length >= 3 && wrong === sample.length) return clampTier(current - 1);
    return current;
  }

  const accuracy = sample.filter((a) => a.correct).length / sample.length;
  if (accuracy >= LEVEL_UP_ACCURACY) {
    const avgMs = sample.reduce((s, a) => s + a.elapsedMs, 0) / sample.length;
    const par = parTimeForTier(current) * 1000;
    // Accurate *and* comfortable within par - ready for harder, straight away.
    if (avgMs <= par) return clampTier(current + 1);

    // The patient route. Note this asks a *higher* accuracy bar over a longer
    // run, so it cannot be reached by the merely-good player the middle band is
    // meant to hold steady.
    const patient = recent.slice(-PATIENCE_WINDOW);
    if (patient.length >= PATIENCE_WINDOW) {
      const patientAccuracy = patient.filter((a) => a.correct).length / patient.length;
      if (patientAccuracy >= PATIENCE_ACCURACY) return clampTier(current + 1);
    }
    return current;
  }
  if (accuracy < LEVEL_DOWN_ACCURACY) return clampTier(current - 1);
  return current;
}

export type SkillStat = { attempts: number; correct: number; totalMs: number };
export type SkillStats = Partial<Record<Skill, SkillStat>>;

/** Folds attempts into per-skill totals for the parent-facing stats screen. */
export function summariseAttempts(attempts: readonly Attempt[]): SkillStats {
  const out: SkillStats = {};
  for (const a of attempts) {
    const entry = out[a.skill] ?? { attempts: 0, correct: 0, totalMs: 0 };
    entry.attempts += 1;
    if (a.correct) entry.correct += 1;
    entry.totalMs += a.elapsedMs;
    out[a.skill] = entry;
  }
  return out;
}

export function mergeSkillStats(base: SkillStats, incoming: SkillStats): SkillStats {
  const out: SkillStats = { ...base };
  for (const skill of Object.keys(incoming) as Skill[]) {
    const add = incoming[skill];
    if (!add) continue;
    const existing = out[skill] ?? { attempts: 0, correct: 0, totalMs: 0 };
    out[skill] = {
      attempts: existing.attempts + add.attempts,
      correct: existing.correct + add.correct,
      totalMs: existing.totalMs + add.totalMs,
    };
  }
  return out;
}

export function accuracyOf(stat: SkillStat | undefined): number {
  if (!stat || stat.attempts === 0) return 0;
  return stat.correct / stat.attempts;
}

export function averageSeconds(stat: SkillStat | undefined): number {
  if (!stat || stat.attempts === 0) return 0;
  return stat.totalMs / stat.attempts / 1000;
}
