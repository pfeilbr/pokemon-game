import { describe, expect, it } from 'vitest';
import type { BattleSummary } from './battle';
import { CREATURES } from './creatures';
import type { Attempt } from './math';
import {
  BADGES,
  EVOLVE_AT,
  MAX_LEVEL,
  PROFILE_VERSION,
  type Profile,
  applyBattleResult,
  badgeById,
  completion,
  createProfile,
  daysBetween,
  evaluateBadges,
  levelFromXp,
  levelProgress,
  nextEvolutionLevel,
  normaliseProfile,
  overallAccuracy,
  partnerFor,
  updateStreak,
  xpForBattle,
  xpForNextLevel,
  xpToReachLevel,
} from './progress';

const NOW = '2026-08-11T12:00:00.000Z';
const TODAY = '2026-08-11';

function profile(overrides: Partial<Profile> = {}): Profile {
  return { ...createProfile({ trainerName: 'Leo', starterId: 'cindik', now: NOW }), ...overrides };
}

function summary(overrides: Partial<BattleSummary> = {}): BattleSummary {
  return {
    won: true,
    caught: false,
    creatureId: 'sproutle',
    turns: 5,
    correct: 5,
    total: 5,
    bestCombo: 3,
    hpRemaining: 40,
    hpRatio: 0.7,
    ...overrides,
  };
}

const attempts: Attempt[] = Array.from({ length: 5 }, () => ({
  skill: 'add1',
  tier: 1,
  correct: true,
  elapsedMs: 1500,
}));

describe('levels', () => {
  it('starts at level 1 with no XP', () => {
    expect(levelFromXp(0)).toBe(1);
    expect(xpToReachLevel(1)).toBe(0);
  });

  it('is self-consistent: the XP to reach a level always yields that level', () => {
    for (let level = 1; level <= MAX_LEVEL; level++) {
      expect(levelFromXp(xpToReachLevel(level))).toBe(level);
      if (level > 1) expect(levelFromXp(xpToReachLevel(level) - 1)).toBe(level - 1);
    }
  });

  it('needs progressively more XP per level', () => {
    for (let level = 1; level < MAX_LEVEL; level++) {
      expect(xpForNextLevel(level + 1)).toBeGreaterThan(xpForNextLevel(level));
    }
  });

  it('caps at MAX_LEVEL', () => {
    expect(levelFromXp(9_999_999)).toBe(MAX_LEVEL);
  });

  it('tolerates junk XP values', () => {
    expect(levelFromXp(-50)).toBe(1);
    expect(levelFromXp(Number.NaN)).toBe(1);
  });

  it('reports progress inside the current level', () => {
    const start = levelProgress(xpToReachLevel(3));
    expect(start.level).toBe(3);
    expect(start.into).toBe(0);
    expect(start.ratio).toBe(0);
    expect(start.atMax).toBe(false);

    const mid = levelProgress(xpToReachLevel(3) + Math.floor(xpForNextLevel(3) / 2));
    expect(mid.ratio).toBeGreaterThan(0.4);
    expect(mid.ratio).toBeLessThan(0.6);
  });

  it('keeps the progress ratio inside 0..1 at every XP value', () => {
    for (let xp = 0; xp < 20_000; xp += 37) {
      const p = levelProgress(xp);
      expect(p.ratio).toBeGreaterThanOrEqual(0);
      expect(p.ratio).toBeLessThanOrEqual(1);
      expect(p.into).toBeLessThanOrEqual(p.span || Number.MAX_SAFE_INTEGER);
    }
  });

  it('reports a full bar at max level', () => {
    const p = levelProgress(9_999_999);
    expect(p.atMax).toBe(true);
    expect(p.ratio).toBe(1);
  });
});

describe('partner and evolution', () => {
  it('starts as the chosen starter', () => {
    expect(partnerFor(profile())).toBe('cindik');
  });

  it('evolves at the level thresholds', () => {
    expect(partnerFor(profile({ xp: xpToReachLevel(EVOLVE_AT[2]) }))).toBe('blazur');
    expect(partnerFor(profile({ xp: xpToReachLevel(EVOLVE_AT[3]) }))).toBe('pyrolith');
  });

  it('stays in its own element line', () => {
    const p = profile({ starterId: 'bublet', caught: ['bublet'], xp: xpToReachLevel(9) });
    expect(partnerFor(p)).toBe('tidalus');
  });

  it('never regresses as XP climbs', () => {
    const seen: string[] = [];
    for (let level = 1; level <= MAX_LEVEL; level++) {
      const id = partnerFor(profile({ xp: xpToReachLevel(level) }));
      if (seen.at(-1) !== id) seen.push(id);
    }
    expect(seen).toEqual(['cindik', 'blazur', 'pyrolith']);
  });

  it('reports the next evolution level, and null at final stage', () => {
    expect(nextEvolutionLevel(profile())).toBe(EVOLVE_AT[2]);
    expect(nextEvolutionLevel(profile({ xp: xpToReachLevel(EVOLVE_AT[2]) }))).toBe(EVOLVE_AT[3]);
    expect(nextEvolutionLevel(profile({ xp: xpToReachLevel(MAX_LEVEL) }))).toBeNull();
  });
});

describe('badges', () => {
  it('has unique ids, icons and both languages', () => {
    const ids = BADGES.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of BADGES) {
      expect(b.icon).toMatch(/\S/);
      expect(b.name.en).toMatch(/\S/);
      expect(b.name.zh).toMatch(/\S/);
      expect(b.description.en).toMatch(/\S/);
      expect(b.description.zh).toMatch(/\S/);
    }
  });

  it('awards none to a brand-new trainer', () => {
    expect(evaluateBadges(profile())).toEqual([]);
  });

  it('awards the ones that have been met', () => {
    const earned = evaluateBadges(profile({ battlesWon: 10, bestCombo: 5 }));
    expect(earned).toContain('first-win');
    expect(earned).toContain('ten-wins');
    expect(earned).toContain('combo-5');
    expect(earned).not.toContain('combo-10');
  });

  it('never revokes a badge already earned', () => {
    const p = profile({ badges: ['first-win'], battlesWon: 0 });
    expect(evaluateBadges(p)).toContain('first-win');
  });

  it('is reachable: every badge can be earned by some profile', () => {
    const maxed = profile({
      xp: xpToReachLevel(MAX_LEVEL),
      battlesWon: 999,
      bestCombo: 99,
      problemsCorrect: 9999,
      tier: 10,
      caught: CREATURES.map((c) => c.id),
      streak: { current: 30, best: 30, lastPlayed: TODAY },
    });
    expect(evaluateBadges(maxed)).toHaveLength(BADGES.length);
  });

  it('looks badges up by id', () => {
    expect(badgeById('first-win')?.icon).toBe('🥇');
    expect(badgeById('nope')).toBeUndefined();
  });
});

describe('xpForBattle', () => {
  it('pays more for a win than a loss', () => {
    expect(xpForBattle(summary({ won: true }))).toBeGreaterThan(xpForBattle(summary({ won: false })));
  });

  it('still pays something for a loss, so trying is never wasted', () => {
    expect(xpForBattle(summary({ won: false, correct: 0 }))).toBeGreaterThan(0);
  });

  it('rewards combos and catches', () => {
    const plain = xpForBattle(summary({ bestCombo: 0 }));
    expect(xpForBattle(summary({ bestCombo: 5 }))).toBeGreaterThan(plain);
    expect(xpForBattle(summary({ caught: true }))).toBeGreaterThan(plain);
  });

  it('rewards beating a tougher opponent', () => {
    const weak = xpForBattle(summary({ creatureId: 'sproutle' }));
    const strong = xpForBattle(summary({ creatureId: 'thornmoss' }));
    expect(strong).toBeGreaterThan(weak);
  });

  it('does not crash on an unknown opponent id', () => {
    expect(xpForBattle(summary({ creatureId: 'ghost' }))).toBeGreaterThan(0);
  });
});

describe('streaks', () => {
  it('starts a streak on the first day played', () => {
    expect(updateStreak({ current: 0, best: 0, lastPlayed: null }, TODAY)).toEqual({
      current: 1,
      best: 1,
      lastPlayed: TODAY,
    });
  });

  it('extends on consecutive days', () => {
    const day1 = updateStreak({ current: 0, best: 0, lastPlayed: null }, '2026-08-10');
    const day2 = updateStreak(day1, '2026-08-11');
    expect(day2.current).toBe(2);
    expect(day2.best).toBe(2);
  });

  it('does not double-count the same day', () => {
    const first = updateStreak({ current: 3, best: 5, lastPlayed: TODAY }, TODAY);
    expect(first.current).toBe(3);
  });

  it('resets after a missed day but keeps the best', () => {
    const broken = updateStreak({ current: 5, best: 5, lastPlayed: '2026-08-01' }, TODAY);
    expect(broken.current).toBe(1);
    expect(broken.best).toBe(5);
  });

  it('handles a clock that went backwards without going negative', () => {
    const back = updateStreak({ current: 4, best: 4, lastPlayed: '2026-08-20' }, TODAY);
    expect(back.current).toBe(1);
    expect(back.best).toBe(4);
  });

  it('survives a corrupt last-played date', () => {
    const bad = updateStreak({ current: 4, best: 4, lastPlayed: 'not-a-date' }, TODAY);
    expect(bad.current).toBe(1);
  });

  it('spans month and year boundaries', () => {
    expect(daysBetween('2026-08-31', '2026-09-01')).toBe(1);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('bad', TODAY)).toBeNull();
  });
});

describe('createProfile', () => {
  it('creates a sensible starting profile that already owns its starter', () => {
    const p = createProfile({ trainerName: 'Leo', starterId: 'zaplet', now: NOW });
    expect(p.version).toBe(PROFILE_VERSION);
    expect(p.caught).toEqual(['zaplet']);
    expect(p.xp).toBe(0);
    expect(p.tier).toBe(1);
    expect(p.settings.language).toBe('en');
  });

  it('honours a language choice', () => {
    expect(createProfile({ trainerName: 'Leo', starterId: 'zaplet', language: 'zh' }).settings.language).toBe('zh');
  });

  it('refuses a starter that is not a stage-1 creature', () => {
    expect(() => createProfile({ trainerName: 'Leo', starterId: 'pyrolith' })).toThrow(/stage-1/);
    expect(() => createProfile({ trainerName: 'Leo', starterId: 'nope' })).toThrow(/Unknown creature/);
  });
});

describe('applyBattleResult', () => {
  const opts = { today: TODAY, now: NOW };

  it('awards XP and records the win', () => {
    const out = applyBattleResult(profile(), summary(), attempts, opts);
    expect(out.xpGained).toBeGreaterThan(0);
    expect(out.profile.xp).toBe(out.xpGained);
    expect(out.profile.battlesWon).toBe(1);
    expect(out.profile.battlesLost).toBe(0);
  });

  it('records a loss without wiping progress', () => {
    const before = profile({ xp: 200 });
    const out = applyBattleResult(before, summary({ won: false }), attempts, opts);
    expect(out.profile.battlesLost).toBe(1);
    expect(out.profile.xp).toBeGreaterThan(before.xp);
  });

  it('adds a caught creature to the album exactly once', () => {
    const first = applyBattleResult(profile(), summary({ caught: true }), attempts, opts);
    expect(first.profile.caught).toContain('sproutle');

    const again = applyBattleResult(first.profile, summary({ caught: true }), attempts, opts);
    expect(again.profile.caught.filter((c) => c === 'sproutle')).toHaveLength(1);
  });

  it('does not add a creature that escaped', () => {
    const out = applyBattleResult(profile(), summary({ caught: false }), attempts, opts);
    expect(out.profile.caught).not.toContain('sproutle');
  });

  it('reports a level-up when one happens', () => {
    const nearly = profile({ xp: xpToReachLevel(2) - 1 });
    const out = applyBattleResult(nearly, summary(), attempts, opts);
    expect(out.leveledUp).toBe(true);
    expect(out.newLevel).toBeGreaterThan(1);
  });

  it('reports an evolution when the partner changes form', () => {
    const nearly = profile({ xp: xpToReachLevel(EVOLVE_AT[2]) - 1 });
    const out = applyBattleResult(nearly, summary(), attempts, opts);
    expect(out.evolved).toBe(true);
    expect(partnerFor(out.profile)).toBe('blazur');
  });

  it('reports newly earned badges only once', () => {
    const first = applyBattleResult(profile(), summary(), attempts, opts);
    expect(first.newBadges).toContain('first-win');

    const second = applyBattleResult(first.profile, summary(), attempts, opts);
    expect(second.newBadges).not.toContain('first-win');
    expect(second.profile.badges).toContain('first-win');
  });

  it('accumulates question counts and best combo', () => {
    let p = profile();
    p = applyBattleResult(p, summary({ correct: 4, total: 5, bestCombo: 3 }), attempts, opts).profile;
    p = applyBattleResult(p, summary({ correct: 5, total: 5, bestCombo: 7 }), attempts, opts).profile;
    expect(p.problemsCorrect).toBe(9);
    expect(p.problemsTotal).toBe(10);
    expect(p.bestCombo).toBe(7);
  });

  it('raises the maths tier after a strong run', () => {
    const fast: Attempt[] = Array.from({ length: 8 }, () => ({
      skill: 'add1',
      tier: 1,
      correct: true,
      elapsedMs: 900,
    }));
    const out = applyBattleResult(profile(), summary(), fast, opts);
    expect(out.profile.tier).toBe(2);
    expect(out.tierChanged).toBe(1);
  });

  it('lowers the tier after a poor run', () => {
    const bad: Attempt[] = Array.from({ length: 8 }, () => ({
      skill: 'mul1',
      tier: 5,
      correct: false,
      elapsedMs: 9000,
    }));
    const out = applyBattleResult(profile({ tier: 5 }), summary({ won: false }), bad, opts);
    expect(out.profile.tier).toBe(4);
  });

  it('keeps only a bounded window of recent attempts', () => {
    let p = profile();
    for (let i = 0; i < 10; i++) p = applyBattleResult(p, summary(), attempts, opts).profile;
    expect(p.recentAttempts.length).toBeLessThanOrEqual(8);
  });

  it('accumulates per-skill stats for the stats screen', () => {
    const out = applyBattleResult(profile(), summary(), attempts, opts);
    expect(out.profile.skillStats.add1).toEqual({ attempts: 5, correct: 5, totalMs: 7500 });
  });

  it('advances the streak', () => {
    const out = applyBattleResult(profile(), summary(), attempts, opts);
    expect(out.profile.streak.current).toBe(1);
    expect(out.profile.streak.lastPlayed).toBe(TODAY);
  });

  it('does not mutate the profile it was given', () => {
    const before = profile();
    const snapshot = JSON.stringify(before);
    applyBattleResult(before, summary({ caught: true }), attempts, opts);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('normaliseProfile', () => {
  it('round-trips a valid profile through JSON unchanged', () => {
    const p = applyBattleResult(profile(), summary({ caught: true }), attempts, {
      today: TODAY,
      now: NOW,
    }).profile;
    const restored = normaliseProfile(JSON.parse(JSON.stringify(p)));
    expect(restored).toEqual(p);
  });

  it('rejects things that are not objects', () => {
    expect(normaliseProfile(null)).toBeNull();
    expect(normaliseProfile('nope')).toBeNull();
    expect(normaliseProfile(42)).toBeNull();
  });

  it('repairs a profile full of junk rather than throwing', () => {
    const repaired = normaliseProfile({
      trainerName: '',
      starterId: 'not-a-creature',
      xp: -100,
      caught: ['cindik', 'fake-mon', 42],
      badges: ['first-win', 'invented-badge'],
      tier: 999,
      battlesWon: 'lots',
      streak: { current: -1, best: null, lastPlayed: 12 },
      settings: { language: 'klingon' },
    })!;

    expect(repaired).not.toBeNull();
    expect(repaired.trainerName).toBe('Trainer');
    expect(repaired.starterId).toBe('cindik');
    expect(repaired.xp).toBe(0);
    expect(repaired.caught).toEqual(['cindik']);
    expect(repaired.badges).toEqual(['first-win']);
    expect(repaired.tier).toBe(10);
    expect(repaired.battlesWon).toBe(0);
    expect(repaired.streak).toEqual({ current: 0, best: 0, lastPlayed: null });
    expect(repaired.settings.language).toBe('en');
    expect(repaired.settings.sound).toBe(true);
  });

  it('always leaves the starter in the album', () => {
    const repaired = normaliseProfile({ starterId: 'zaplet', caught: [] })!;
    expect(repaired.caught).toContain('zaplet');
  });

  it('repairs an empty object into a playable profile', () => {
    const repaired = normaliseProfile({})!;
    expect(repaired.version).toBe(PROFILE_VERSION);
    expect(repaired.caught).toHaveLength(1);
    expect(() => partnerFor(repaired)).not.toThrow();
  });

  it('drops duplicate album entries', () => {
    const repaired = normaliseProfile({ starterId: 'cindik', caught: ['cindik', 'cindik', 'bublet'] })!;
    expect(repaired.caught).toEqual(['cindik', 'bublet']);
  });
});

describe('derived stats', () => {
  it('reports accuracy, guarding against divide-by-zero', () => {
    expect(overallAccuracy(profile())).toBe(0);
    expect(overallAccuracy(profile({ problemsCorrect: 3, problemsTotal: 4 }))).toBe(0.75);
  });

  it('reports album completion', () => {
    expect(completion(profile())).toBeCloseTo(1 / CREATURES.length);
    expect(completion(profile({ caught: CREATURES.map((c) => c.id) }))).toBe(1);
  });
});
