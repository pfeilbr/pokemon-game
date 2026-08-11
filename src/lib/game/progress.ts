import type { BattleSummary } from './battle';
import { CREATURES, evolutionLine, findCreature, getCreature } from './creatures';
import {
  ADAPT_WINDOW,
  type Attempt,
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
  return (
    XP_WIN +
    stageBonus +
    summary.bestCombo * XP_PER_COMBO +
    (summary.caught ? XP_CATCH : 0)
  );
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
  const recentAttempts = [...profile.recentAttempts, ...attempts].slice(-ADAPT_WINDOW);
  const tier = nextTier(profile.tier, recentAttempts);

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
 * Repairs a profile loaded from storage.
 *
 * Save data outlives code. Anything missing, out of range or of the wrong type
 * is replaced with a sane default rather than allowed to crash the game - a
 * child losing his album to a schema change is not an acceptable failure.
 */
export function normaliseProfile(input: unknown): Profile | null {
  if (typeof input !== 'object' || input === null) return null;
  const raw = input as Partial<Profile>;

  const starterId =
    typeof raw.starterId === 'string' && findCreature(raw.starterId)?.stage === 1
      ? raw.starterId
      : 'cindik';

  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;

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
    trainerName: typeof raw.trainerName === 'string' && raw.trainerName.trim() ? raw.trainerName : 'Trainer',
    starterId,
    xp: num(raw.xp, 0),
    caught: [...new Set(caught)],
    badges: Array.isArray(raw.badges)
      ? [...new Set(raw.badges.filter((b): b is string => typeof b === 'string' && knownBadges.has(b)))]
      : [],
    battlesWon: num(raw.battlesWon, 0),
    battlesLost: num(raw.battlesLost, 0),
    problemsCorrect: num(raw.problemsCorrect, 0),
    problemsTotal: num(raw.problemsTotal, 0),
    bestCombo: num(raw.bestCombo, 0),
    tier: clampTier(num(raw.tier, 1)),
    recentAttempts: Array.isArray(raw.recentAttempts)
      ? (raw.recentAttempts.filter(
          (a) => typeof a === 'object' && a !== null && typeof (a as Attempt).correct === 'boolean',
        ) as Attempt[]).slice(-ADAPT_WINDOW)
      : [],
    skillStats: typeof raw.skillStats === 'object' && raw.skillStats !== null ? raw.skillStats : {},
    streak: {
      current: num(streak.current, 0),
      best: num(streak.best, 0),
      lastPlayed: typeof streak.lastPlayed === 'string' ? streak.lastPlayed : null,
    },
    settings: {
      language: settings.language === 'zh' ? 'zh' : 'en',
      sound: settings.sound !== false,
    },
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
  };
}

/** Overall answer accuracy, 0..1. */
export function overallAccuracy(profile: Profile): number {
  return profile.problemsTotal === 0 ? 0 : profile.problemsCorrect / profile.problemsTotal;
}

/** Album completion, 0..1. */
export function completion(profile: Profile): number {
  return new Set(profile.caught).size / CREATURES.length;
}
