import type { BattleSummary } from './battle';
import { CREATURES, evolutionLine, findCreature, getCreature } from './creatures';
import {
  PATIENCE_WINDOW,
  type Attempt,
  MIN_TIER,
  SKILLS,
  type Skill,
  type SkillStats,
  clampTier,
  mergeSkillStats,
  nextTier,
  summariseAttempts,
} from './math';

/**
 * The player profile and everything that changes it.
 *
 * The profile is the single save object: it round-trips through JSON, through
 * localStorage, and through a Postgres jsonb column unchanged. `level` is
 * always derived from `xp` rather than stored, so the two can never disagree.
 */

export const PROFILE_VERSION = 1;

export type Language = 'en' | 'zh';

export type Streak = {
  current: number;
  best: number;
  /** ISO date (YYYY-MM-DD) of the last day the player battled. */
  lastPlayed: string | null;
};

export type Profile = {
  version: number;
  trainerName: string;
  /** The stage-1 creature chosen at sign-up. Defines the partner's line. */
  starterId: string;
  xp: number;
  /** Creature ids in the album, in the order they were caught. */
  caught: string[];
  badges: string[];
  battlesWon: number;
  battlesLost: number;
  problemsCorrect: number;
  problemsTotal: number;
  bestCombo: number;
  /** Current adaptive maths tier. */
  tier: number;
  /** Rolling window feeding the difficulty adapter. */
  recentAttempts: Attempt[];
  skillStats: SkillStats;
  streak: Streak;
  settings: { language: Language; sound: boolean };
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

export const MAX_LEVEL = 30;

/** XP needed to go from `level` to `level + 1`. Gentle, predictable growth. */
export function xpForNextLevel(level: number): number {
  return 60 + Math.max(0, level - 1) * 40;
}

/** Total XP required to have reached `level`. */
export function xpToReachLevel(level: number): number {
  let total = 0;
  for (let l = 1; l < Math.min(level, MAX_LEVEL); l++) total += xpForNextLevel(l);
  return total;
}

export function levelFromXp(xp: number): number {
  const safe = Number.isFinite(xp) ? Math.max(0, xp) : 0;
  let level = 1;
  while (level < MAX_LEVEL && safe >= xpToReachLevel(level + 1)) level++;
  return level;
}

export type LevelProgress = {
  level: number;
  /** XP earned inside the current level. */
  into: number;
  /** XP the current level spans. 0 once MAX_LEVEL is reached. */
  span: number;
  /** 0..1 for the progress bar. 1 at max level. */
  ratio: number;
  atMax: boolean;
};

export function levelProgress(xp: number): LevelProgress {
  const level = levelFromXp(xp);
  if (level >= MAX_LEVEL) {
    return { level: MAX_LEVEL, into: 0, span: 0, ratio: 1, atMax: true };
  }
  const floor = xpToReachLevel(level);
  const span = xpForNextLevel(level);
  const into = Math.max(0, Math.min(span, xp - floor));
  return { level, into, span, ratio: span === 0 ? 1 : into / span, atMax: false };
}

// ---------------------------------------------------------------------------
// Partner and evolution
// ---------------------------------------------------------------------------

/** Trainer level at which the partner reaches each stage. */
export const EVOLVE_AT = { 2: 4, 3: 8 } as const;

/**
 * The partner's current form.
 *
 * The partner is always the player's starter line, evolved to match trainer
 * level. Tying evolution to level rather than to an item means the reward is
 * legible: the creature visibly grows as the player does.
 */
export function partnerFor(profile: Profile): string {
  const line = evolutionLine(profile.starterId);
  const level = levelFromXp(profile.xp);
  if (level >= EVOLVE_AT[3] && line[2]) return line[2].id;
  if (level >= EVOLVE_AT[2] && line[1]) return line[1].id;
  return line[0]!.id;
}

/** Trainer level at which the partner next changes form, or null at final stage. */
export function nextEvolutionLevel(profile: Profile): number | null {
  const stage = getCreature(partnerFor(profile)).stage;
  if (stage === 1) return EVOLVE_AT[2];
  if (stage === 2) return EVOLVE_AT[3];
  return null;
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export type Badge = {
  id: string;
  name: { en: string; zh: string };
  description: { en: string; zh: string };
  icon: string;
  earned: (p: Profile) => boolean;
};

export const BADGES: readonly Badge[] = [
  {
    id: 'first-win',
    name: { en: 'First Victory', zh: '首胜' },
    description: { en: 'Win your first battle.', zh: '赢得第一场战斗。' },
    icon: '🥇',
    earned: (p) => p.battlesWon >= 1,
  },
  {
    id: 'combo-5',
    name: { en: 'On a Roll', zh: '连击达人' },
    description: { en: 'Get 5 answers right in a row.', zh: '连续答对5题。' },
    icon: '🔥',
    earned: (p) => p.bestCombo >= 5,
  },
  {
    id: 'combo-10',
    name: { en: 'Unstoppable', zh: '势不可挡' },
    description: { en: 'Get 10 answers right in a row.', zh: '连续答对10题。' },
    icon: '⚡',
    earned: (p) => p.bestCombo >= 10,
  },
  {
    id: 'collector-6',
    name: { en: 'Collector', zh: '收藏家' },
    description: { en: 'Catch 6 different creatures.', zh: '捕捉6种不同的伙伴。' },
    icon: '📗',
    earned: (p) => new Set(p.caught).size >= 6,
  },
  {
    id: 'collector-all',
    name: { en: 'Album Master', zh: '图鉴大师' },
    description: { en: 'Catch every creature.', zh: '收集全部伙伴。' },
    icon: '👑',
    earned: (p) => new Set(p.caught).size >= CREATURES.length,
  },
  {
    id: 'ten-wins',
    name: { en: 'Gym Regular', zh: '道馆常客' },
    description: { en: 'Win 10 battles.', zh: '赢得10场战斗。' },
    icon: '🏅',
    earned: (p) => p.battlesWon >= 10,
  },
  {
    id: 'century',
    name: { en: 'Century', zh: '百题达成' },
    description: { en: 'Answer 100 questions correctly.', zh: '答对100道题。' },
    icon: '💯',
    earned: (p) => p.problemsCorrect >= 100,
  },
  {
    id: 'tier-5',
    name: { en: 'Times Tables', zh: '乘法口诀' },
    description: { en: 'Reach maths level 5.', zh: '达到数学等级5。' },
    icon: '✖️',
    earned: (p) => p.tier >= 5,
  },
  {
    id: 'tier-10',
    name: { en: 'Math Champion', zh: '数学冠军' },
    description: { en: 'Reach maths level 10.', zh: '达到数学等级10。' },
    icon: '🧠',
    earned: (p) => p.tier >= 10,
  },
  {
    id: 'streak-3',
    name: { en: 'Three Day Streak', zh: '连续三天' },
    description: { en: 'Play three days in a row.', zh: '连续三天游戏。' },
    icon: '📅',
    earned: (p) => p.streak.best >= 3,
  },
  {
    id: 'streak-7',
    name: { en: 'Week Warrior', zh: '一周勇士' },
    description: { en: 'Play seven days in a row.', zh: '连续七天游戏。' },
    icon: '🗓️',
    earned: (p) => p.streak.best >= 7,
  },
  {
    id: 'evolved',
    name: { en: 'Evolution', zh: '进化' },
    description: { en: 'Evolve your partner.', zh: '让伙伴进化。' },
    icon: '🌟',
    earned: (p) => levelFromXp(p.xp) >= EVOLVE_AT[2],
  },
] as const;

export function badgeById(id: string): Badge | undefined {
  return BADGES.find((b) => b.id === id);
}

/** Recomputes earned badges. Badges are never revoked once earned. */
export function evaluateBadges(profile: Profile): string[] {
  const earned = new Set(profile.badges);
  for (const badge of BADGES) {
    if (badge.earned(profile)) earned.add(badge.id);
  }
  return BADGES.filter((b) => earned.has(b.id)).map((b) => b.id);
}

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

export const XP_WIN = 40;
export const XP_LOSS = 10;
export const XP_PER_STAGE = 20;
export const XP_PER_COMBO = 3;
export const XP_CATCH = 25;

export function xpForBattle(summary: BattleSummary): number {
  const foe = findCreature(summary.creatureId);
  const stageBonus = foe ? (foe.stage - 1) * XP_PER_STAGE : 0;

  if (!summary.won) {
    // Losing still pays. A seven-year-old who gets nothing for trying stops
    // trying.
    return XP_LOSS + Math.floor(summary.correct * 2);
  }
  return XP_WIN + stageBonus + summary.bestCombo * XP_PER_COMBO + (summary.caught ? XP_CATCH : 0);
}

// ---------------------------------------------------------------------------
// Streaks
// ---------------------------------------------------------------------------

/** Days between two YYYY-MM-DD dates. Returns null if either is malformed. */
export function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

export function updateStreak(streak: Streak, today: string): Streak {
  if (streak.lastPlayed === today) return streak;

  const gap = streak.lastPlayed ? daysBetween(streak.lastPlayed, today) : null;
  // gap === 1 continues the streak; anything else (including a clock that went
  // backwards) starts a fresh one.
  const current = gap === 1 ? streak.current + 1 : 1;

  return {
    current,
    best: Math.max(streak.best, current),
    lastPlayed: today,
  };
}

// ---------------------------------------------------------------------------
// Profile lifecycle
// ---------------------------------------------------------------------------

export function createProfile(params: {
  trainerName: string;
  starterId: string;
  now?: string;
  language?: Language;
}): Profile {
  const now = params.now ?? new Date().toISOString();
  // Fail loudly on a bad starter rather than writing a corrupt save.
  const starter = getCreature(params.starterId);
  if (starter.stage !== 1) throw new Error(`Starter must be a stage-1 creature: ${starter.id}`);

  return {
    version: PROFILE_VERSION,
    trainerName: params.trainerName,
    starterId: starter.id,
    xp: 0,
    caught: [starter.id],
    badges: [],
    battlesWon: 0,
    battlesLost: 0,
    problemsCorrect: 0,
    problemsTotal: 0,
    bestCombo: 0,
    tier: 1,
    recentAttempts: [],
    skillStats: {},
    streak: { current: 0, best: 0, lastPlayed: null },
    settings: { language: params.language ?? 'en', sound: true },
    createdAt: now,
    updatedAt: now,
  };
}

export type BattleOutcome = {
  profile: Profile;
  xpGained: number;
  leveledUp: boolean;
  newLevel: number;
  evolved: boolean;
  newBadges: string[];
  tierChanged: number;
};

/**
 * Folds a finished battle into the profile.
 *
 * Pure: returns a new profile and a description of what changed, so the UI can
 * celebrate the specific things that happened rather than diffing state.
 */
export function applyBattleResult(
  profile: Profile,
  summary: BattleSummary,
  attempts: readonly Attempt[],
  options: { today?: string; now?: string } = {},
): BattleOutcome {
  const now = options.now ?? new Date().toISOString();
  const today = options.today ?? now.slice(0, 10);

  const beforeLevel = levelFromXp(profile.xp);
  const beforePartner = partnerFor(profile);

  const xpGained = xpForBattle(summary);
  // Kept to the *patient* window, not the adapt window: `nextTier` reads the
  // last eight for its normal decision and the last sixteen for the accuracy-
  // only route up, so trimming to eight here would silently make that route
  // unreachable and pin a slow, accurate child at tier 1 forever.
  const observed = [...profile.recentAttempts, ...attempts].slice(-PATIENCE_WINDOW);
  const tier = nextTier(profile.tier, observed);

  /**
   * A tier change makes the window stale: every attempt in it was answered at
   * the *previous* difficulty, so carrying it forward promotes again on the
   * very next question. That is how a perfect run could climb from adding-to-20
   * to two-step expressions in sixteen questions, which is the opposite of the
   * gentle one-tier-at-a-time behaviour this adapter is supposed to have.
   * Clearing it means each new tier has to be earned on its own evidence.
   */
  const recentAttempts = tier === profile.tier ? observed : [];

  const caught = [...profile.caught];
  if (summary.caught && !caught.includes(summary.creatureId)) caught.push(summary.creatureId);

  const next: Profile = {
    ...profile,
    xp: profile.xp + xpGained,
    caught,
    battlesWon: profile.battlesWon + (summary.won ? 1 : 0),
    battlesLost: profile.battlesLost + (summary.won ? 0 : 1),
    problemsCorrect: profile.problemsCorrect + summary.correct,
    problemsTotal: profile.problemsTotal + summary.total,
    bestCombo: Math.max(profile.bestCombo, summary.bestCombo),
    tier,
    recentAttempts,
    skillStats: mergeSkillStats(profile.skillStats, summariseAttempts(attempts)),
    streak: updateStreak(profile.streak, today),
    updatedAt: now,
  };

  const badgesBefore = new Set(next.badges);
  next.badges = evaluateBadges(next);

  const newLevel = levelFromXp(next.xp);
  return {
    profile: next,
    xpGained,
    leveledUp: newLevel > beforeLevel,
    newLevel,
    evolved: partnerFor(next) !== beforePartner,
    newBadges: next.badges.filter((b) => !badgesBefore.has(b)),
    tierChanged: tier - profile.tier,
  };
}

// ---------------------------------------------------------------------------
// Persistence hygiene
// ---------------------------------------------------------------------------

/**
 * The longest trainer name kept. A name is a child's nickname, not a document.
 *
 * This is a bound, not a style rule: `normaliseProfile` runs on the server for
 * every `PUT /api/profile`, and without a cap a single request can park an
 * arbitrarily large string in the database forever.
 */
export const MAX_TRAINER_NAME = 40;

/** Longest string still considered a timestamp. Every ISO 8601 form fits. */
const MAX_DATE_LENGTH = 40;

/** The only shape `streak.lastPlayed` is ever written in. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const SKILL_IDS = new Set<string>(SKILLS);

/** A finite, non-negative number, or the fallback. */
function num(value: unknown, fallback: number): number {
  // `value + 0` turns -0 into 0 and leaves every other number alone. -0
  // survives JSON.parse but not JSON.stringify, so leaving it in the profile
  // means the value the server stores differs from the one it validated.
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value + 0 : fallback;
}

/**
 * Keeps a timestamp only if it really is one.
 *
 * `reconcile` picks the cross-device winner with `Date.parse(updatedAt)`, so an
 * unparseable timestamp does not fail loudly - it silently makes every
 * comparison false and quietly stops the newer save from winning.
 */
function date(value: unknown, fallback: string): string {
  return typeof value === 'string' &&
    value.length <= MAX_DATE_LENGTH &&
    Number.isFinite(Date.parse(value))
    ? value
    : fallback;
}

/**
 * Rebuilds the rolling attempt window, keeping only attempts that describe a
 * real question.
 *
 * Only `correct` used to be checked, so everything else in an attempt was
 * whatever the caller sent: an unknown skill, a NaN tier, a 50KB string where
 * the elapsed time goes. Those ride into storage and then into the stats
 * screen, and NaN renders as "NaN" rather than crashing, which is worse - it is
 * a bug nobody can see.
 */
function normaliseAttempts(input: unknown): Attempt[] {
  if (!Array.isArray(input)) return [];
  const out: Attempt[] = [];
  for (const entry of input) {
    if (typeof entry !== 'object' || entry === null) continue;
    const a = entry as Record<string, unknown>;
    if (typeof a.correct !== 'boolean') continue;
    // A skill that no longer exists cannot be repaired into a real one, and
    // inventing one would put words in the child's mouth. Drop it.
    if (typeof a.skill !== 'string' || !SKILL_IDS.has(a.skill)) continue;
    out.push({
      skill: a.skill as Skill,
      tier: clampTier(num(a.tier, MIN_TIER)),
      correct: a.correct,
      elapsedMs: num(a.elapsedMs, 0),
    });
  }
  return out.slice(-PATIENCE_WINDOW);
}

/**
 * Rebuilds the per-skill stats from known skills and finite counters.
 *
 * This used to pass through whatever object arrived. That is a hole in the one
 * function the server trusts: a hostile `PUT /api/profile` body could park
 * arbitrary JSON in the saved profile - a `__proto__` key, a 10,000-deep tree
 * that `JSON.stringify` cannot even serialise (so the save that comes back is
 * unwritable to localStorage), or megabytes of string. Rebuilding from a fixed
 * key list bounds the profile's shape *and* its size by construction.
 */
function normaliseSkillStats(input: unknown): SkillStats {
  const out: SkillStats = {};
  if (typeof input !== 'object' || input === null) return out;
  const raw = input as Record<string, unknown>;
  for (const skill of SKILLS) {
    // hasOwnProperty, so a value inherited from a polluted prototype is not
    // mistaken for saved data.
    if (!Object.prototype.hasOwnProperty.call(raw, skill)) continue;
    const stat = raw[skill];
    if (typeof stat !== 'object' || stat === null) continue;
    const s = stat as Record<string, unknown>;
    out[skill] = {
      attempts: num(s.attempts, 0),
      correct: num(s.correct, 0),
      totalMs: num(s.totalMs, 0),
    };
  }
  return out;
}

/**
 * Repairs a profile loaded from storage.
 *
 * Save data outlives code. Anything missing, out of range or of the wrong type
 * is replaced with a sane default rather than allowed to crash the game - a
 * child losing his album to a schema change is not an acceptable failure.
 *
 * Three callers rely on this: localStorage on the web, AsyncStorage on iOS, and
 * `PUT /api/profile`, where it is the only thing between a hostile request body
 * and the database. So it is written as a rebuild, not a patch-up: every field
 * of the returned profile is constructed here from a checked value, which is
 * what makes it total (never throws), idempotent, and bounded in size.
 * `progress.fuzz.test.ts` asserts those three properties over thousands of
 * seeded hostile inputs.
 */
export function normaliseProfile(input: unknown): Profile | null {
  if (typeof input !== 'object' || input === null) return null;
  const raw = input as Partial<Profile>;

  const starterId =
    typeof raw.starterId === 'string' && findCreature(raw.starterId)?.stage === 1
      ? raw.starterId
      : 'cindik';

  const caught = Array.isArray(raw.caught)
    ? raw.caught.filter((id): id is string => typeof id === 'string' && !!findCreature(id))
    : [];
  if (!caught.includes(starterId)) caught.unshift(starterId);

  const knownBadges = new Set(BADGES.map((b) => b.id));
  const streak = (raw.streak ?? {}) as Partial<Streak>;
  const settings = (raw.settings ?? {}) as Partial<Profile['settings']>;
  const now = new Date().toISOString();

  return {
    version: PROFILE_VERSION,
    trainerName:
      typeof raw.trainerName === 'string' && raw.trainerName.trim()
        ? raw.trainerName.slice(0, MAX_TRAINER_NAME)
        : 'Trainer',
    starterId,
    xp: num(raw.xp, 0),
    caught: [...new Set(caught)],
    badges: Array.isArray(raw.badges)
      ? [
          ...new Set(
            raw.badges.filter((b): b is string => typeof b === 'string' && knownBadges.has(b)),
          ),
        ]
      : [],
    battlesWon: num(raw.battlesWon, 0),
    battlesLost: num(raw.battlesLost, 0),
    problemsCorrect: num(raw.problemsCorrect, 0),
    problemsTotal: num(raw.problemsTotal, 0),
    bestCombo: num(raw.bestCombo, 0),
    tier: clampTier(num(raw.tier, 1)),
    recentAttempts: normaliseAttempts(raw.recentAttempts),
    skillStats: normaliseSkillStats(raw.skillStats),
    streak: {
      current: num(streak.current, 0),
      best: num(streak.best, 0),
      // A corrupt date is a missing date: `updateStreak` starts a fresh streak
      // rather than trusting a day it cannot parse.
      lastPlayed:
        typeof streak.lastPlayed === 'string' &&
        ISO_DAY.test(streak.lastPlayed) &&
        Number.isFinite(Date.parse(`${streak.lastPlayed}T00:00:00Z`))
          ? streak.lastPlayed
          : null,
    },
    settings: {
      language: settings.language === 'zh' ? 'zh' : 'en',
      sound: settings.sound !== false,
    },
    createdAt: date(raw.createdAt, now),
    updatedAt: date(raw.updatedAt, now),
  };
}

/** Union of two id lists, keeping `base` order and appending what only `other` has. */
function unionIds(base: readonly string[], other: readonly string[]): string[] {
  const seen = new Set(base);
  const out = [...base];
  for (const id of other) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** The earlier of two timestamps, ignoring one that will not parse. */
function earlierOf(a: string, b: string): string {
  const pa = Date.parse(a);
  const pb = Date.parse(b);
  if (!Number.isFinite(pb)) return a;
  if (!Number.isFinite(pa)) return b;
  return pb < pa ? b : a;
}

/**
 * Which save has more of the child's life in it.
 *
 * Only consulted when the timestamps cannot decide - identical to the
 * millisecond, or both unreadable. Without it the answer would be "whichever
 * one the caller happened to pass first", which makes the merge depend on which
 * device opened the app first and is exactly the randomness a child experiences
 * as loss.
 */
function furtherAlong(a: Profile, b: Profile): boolean {
  const keys: number[] = [
    a.xp - b.xp,
    a.problemsTotal - b.problemsTotal,
    a.problemsCorrect - b.problemsCorrect,
    a.battlesWon + a.battlesLost - (b.battlesWon + b.battlesLost),
    new Set(a.caught).size - new Set(b.caught).size,
    new Set(a.badges).size - new Set(b.badges).size,
  ];
  for (const delta of keys) {
    if (delta !== 0) return delta > 0;
  }
  return false;
}

/**
 * Folds everything earned on `other` into `base`.
 *
 * Returns `base` itself when there is nothing to add, so a no-op sync is
 * identity: the client compares the winner by reference to decide whether the
 * server needs the result pushed back.
 */
function mergeEarned(base: Profile, other: Profile): Profile {
  const caught = unionIds(base.caught, other.caught);
  const badges = unionIds(base.badges, other.badges);
  const xp = Math.max(base.xp, other.xp);
  const battlesWon = Math.max(base.battlesWon, other.battlesWon);
  const battlesLost = Math.max(base.battlesLost, other.battlesLost);
  const problemsCorrect = Math.max(base.problemsCorrect, other.problemsCorrect);
  const problemsTotal = Math.max(base.problemsTotal, other.problemsTotal);
  const bestCombo = Math.max(base.bestCombo, other.bestCombo);
  const streakBest = Math.max(base.streak.best, other.streak.best);
  const createdAt = earlierOf(base.createdAt, other.createdAt);

  if (
    caught.length === base.caught.length &&
    badges.length === base.badges.length &&
    xp === base.xp &&
    battlesWon === base.battlesWon &&
    battlesLost === base.battlesLost &&
    problemsCorrect === base.problemsCorrect &&
    problemsTotal === base.problemsTotal &&
    bestCombo === base.bestCombo &&
    streakBest === base.streak.best &&
    createdAt === base.createdAt
  ) {
    return base;
  }

  return {
    ...base,
    caught,
    badges,
    xp,
    battlesWon,
    battlesLost,
    problemsCorrect,
    problemsTotal,
    bestCombo,
    streak: { ...base.streak, best: streakBest },
    createdAt,
  };
}

/**
 * Reconciles a device's save with the server's.
 *
 * Last write wins on `updatedAt` - but only for the fields where one answer
 * has to be picked: the trainer name, the starter, the maths tier, the rolling
 * attempt window, the per-skill stats, the current streak and the settings.
 * Everything a child *earned* is merged instead: the album and the badges are
 * unioned, and the lifetime counters and records (XP, battles, questions, best
 * combo, best streak) take the larger of the two. `createdAt` takes the
 * earlier, so a sync never restarts the album's history.
 *
 * It used to be one line - return whichever side parsed to the later
 * `updatedAt` - and that quietly deleted things a seven-year-old had earned.
 * `scripts/audit_sync.py` found two ways in, neither of them exotic:
 *
 *   - Toggling the language on the laptop bumps `updatedAt` (see
 *     `src/app/settings/page.tsx`) without earning anything. The stale laptop
 *     then beat an afternoon of offline play on the tablet, and every creature
 *     caught, every badge and 481 XP went with it. No wrong clock required.
 *   - `updatedAt` comes from a device clock. A tablet an hour fast wins every
 *     comparison forever, so each laptop session is deleted on contact,
 *     round after round, and nobody can see why.
 *
 * Merging the earned half removes the clock from the part of the save that
 * matters: whichever device is "newer", the album is the union of both. A
 * merge is also commutative and idempotent, so the answer no longer depends on
 * which device happened to sync first.
 *
 * This lives in the engine rather than in either client's storage layer
 * because it is a rule, and both clients have to answer it the same way. A
 * phone and a browser that disagreed about which save is newer would lose a
 * child's album between them.
 */
export function reconcile(local: Profile | null, remote: Profile | null): Profile | null {
  if (!local) return remote;
  if (!remote) return local;

  const remoteAt = Date.parse(remote.updatedAt);
  const localAt = Date.parse(local.updatedAt);
  const remoteReadable = Number.isFinite(remoteAt);
  const localReadable = Number.isFinite(localAt);

  let remoteWins: boolean;
  if (remoteReadable && localReadable && remoteAt !== localAt) {
    remoteWins = remoteAt > localAt;
  } else if (remoteReadable !== localReadable) {
    // An unreadable timestamp cannot be compared, so it cannot win the tie.
    remoteWins = remoteReadable;
  } else {
    remoteWins = furtherAlong(remote, local);
  }

  return remoteWins ? mergeEarned(remote, local) : mergeEarned(local, remote);
}

/** Overall answer accuracy, 0..1. */
export function overallAccuracy(profile: Profile): number {
  return profile.problemsTotal === 0 ? 0 : profile.problemsCorrect / profile.problemsTotal;
}

/** Album completion, 0..1. */
export function completion(profile: Profile): number {
  return new Set(profile.caught).size / CREATURES.length;
}
