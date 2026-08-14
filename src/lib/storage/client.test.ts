import { beforeEach, describe, expect, it } from 'vitest';
import { createProfile, type Profile } from '@/lib/game/progress';
import { STORAGE_KEY, clearLocal, loadLocal, reconcile, saveLocal } from './client';

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    ...createProfile({ trainerName: 'Leo', starterId: 'cindik', now: '2026-08-11T12:00:00.000Z' }),
    ...overrides,
  };
}

describe('local storage', () => {
  beforeEach(() => window.localStorage.clear());

  it('round-trips a profile', () => {
    const saved = profile({ xp: 400 });
    saveLocal(saved);
    expect(loadLocal()).toEqual(saved);
  });

  it('returns null when there is nothing saved', () => {
    expect(loadLocal()).toBeNull();
  });

  it('treats corrupt data as no save rather than crashing', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json');
    expect(loadLocal()).toBeNull();
  });

  it('repairs a partially valid save instead of discarding it', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ trainerName: 'Leo', starterId: 'zaplet', xp: 250 }),
    );
    const loaded = loadLocal();
    expect(loaded?.trainerName).toBe('Leo');
    expect(loaded?.xp).toBe(250);
    expect(loaded?.caught).toContain('zaplet');
  });

  it('clears the save', () => {
    saveLocal(profile());
    clearLocal();
    expect(loadLocal()).toBeNull();
  });
});

describe('reconcile', () => {
  const older = profile({ xp: 100, updatedAt: '2026-08-10T00:00:00.000Z' });
  const newer = profile({ xp: 900, updatedAt: '2026-08-11T00:00:00.000Z' });

  it('takes whichever side was written last', () => {
    expect(reconcile(older, newer)).toBe(newer);
    expect(reconcile(newer, older)).toBe(newer);
  });

  it('handles one side being missing', () => {
    expect(reconcile(null, newer)).toBe(newer);
    expect(reconcile(newer, null)).toBe(newer);
    expect(reconcile(null, null)).toBeNull();
  });

  it('prefers the readable timestamp when the other will not parse', () => {
    const remote = profile({ xp: 2, updatedAt: 'not-a-date' });
    expect(reconcile(older, remote)?.updatedAt).toBe(older.updatedAt);
    // ...and it answers the same whichever side it arrives on.
    expect(reconcile(remote, older)).toEqual(reconcile(older, remote));
  });

  it('keeps the further-along save when the timestamps are identical', () => {
    // Two devices can write the same millisecond, and "whichever one the caller
    // passed first" would make the result depend on which device opened the app
    // first. The one with more of the child's life in it wins.
    const local = profile({ xp: 1, updatedAt: '2026-08-11T00:00:00.000Z' });
    const remote = profile({ xp: 2, updatedAt: '2026-08-11T00:00:00.000Z' });
    expect(reconcile(local, remote)?.xp).toBe(2);
    expect(reconcile(remote, local)?.xp).toBe(2);
  });

  /**
   * The album, the badges and the records are merged, not discarded.
   *
   * Toggling the language on the laptop bumps `updatedAt` without earning
   * anything (see `src/app/settings/page.tsx`), so under a pure last-write-wins
   * rule that laptop beat an afternoon of offline play on the tablet and took
   * the whole album with it. `scripts/audit_sync.py` sweeps this property over
   * a corpus of divergent saves; these are the cases worth naming.
   */
  describe('merges what the child earned', () => {
    const tablet = profile({
      xp: 900,
      caught: ['cindik', 'sproutle', 'bublet'],
      badges: ['first-win', 'combo-5'],
      bestCombo: 9,
      battlesWon: 12,
      problemsCorrect: 80,
      problemsTotal: 100,
      streak: { current: 4, best: 4, lastPlayed: '2026-08-11' },
      updatedAt: '2026-08-11T00:00:00.000Z',
    });
    const laptop = profile({
      xp: 300,
      caught: ['cindik', 'pebblo'],
      badges: ['first-win', 'collector-6'],
      bestCombo: 3,
      battlesWon: 4,
      problemsCorrect: 30,
      problemsTotal: 44,
      streak: { current: 1, best: 7, lastPlayed: '2026-08-12' },
      settings: { language: 'zh', sound: false },
      // Later, but only because a setting was toggled on it.
      updatedAt: '2026-08-12T00:00:00.000Z',
    });

    it('unions the album and the badges', () => {
      const merged = reconcile(tablet, laptop);
      expect(merged?.caught).toEqual(
        expect.arrayContaining(['cindik', 'sproutle', 'bublet', 'pebblo']),
      );
      expect(merged?.badges).toEqual(
        expect.arrayContaining(['first-win', 'combo-5', 'collector-6']),
      );
    });

    it('keeps the larger of every lifetime counter and record', () => {
      const merged = reconcile(tablet, laptop);
      expect(merged?.xp).toBe(900);
      expect(merged?.battlesWon).toBe(12);
      expect(merged?.problemsCorrect).toBe(80);
      expect(merged?.problemsTotal).toBe(100);
      expect(merged?.bestCombo).toBe(9);
      expect(merged?.streak.best).toBe(7);
    });

    it('still lets the newer save decide the mutable state', () => {
      const merged = reconcile(tablet, laptop);
      expect(merged?.settings).toEqual({ language: 'zh', sound: false });
      expect(merged?.streak.current).toBe(1);
      expect(merged?.updatedAt).toBe(laptop.updatedAt);
    });

    it('gives the same answer whichever device synced first', () => {
      expect(reconcile(tablet, laptop)).toEqual(reconcile(laptop, tablet));
    });

    it('is idempotent, and a no-op merge returns the save itself', () => {
      expect(reconcile(tablet, tablet)).toBe(tablet);
      const merged = reconcile(tablet, laptop)!;
      expect(reconcile(merged, laptop)).toBe(merged);
      expect(reconcile(merged, tablet)).toBe(merged);
    });

    it('never restarts the album history', () => {
      const earlier = profile({ createdAt: '2026-01-01T00:00:00.000Z', xp: 5 });
      const later = profile({
        createdAt: '2026-08-01T00:00:00.000Z',
        xp: 6,
        updatedAt: '2026-12-01T00:00:00.000Z',
      });
      expect(reconcile(earlier, later)?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    });
  });
});
