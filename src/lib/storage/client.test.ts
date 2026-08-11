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

  it('keeps the local copy when the timestamps are identical', () => {
    const local = profile({ xp: 1, updatedAt: '2026-08-11T00:00:00.000Z' });
    const remote = profile({ xp: 2, updatedAt: '2026-08-11T00:00:00.000Z' });
    expect(reconcile(local, remote)).toBe(local);
  });

  it('prefers the local copy when the remote timestamp is unreadable', () => {
    const remote = profile({ xp: 2, updatedAt: 'not-a-date' });
    expect(reconcile(older, remote)).toBe(older);
  });
});
