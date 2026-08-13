import { beforeEach, describe, expect, it } from 'vitest';
import { createProfile, starters } from './engine';
import { STORAGE_KEY, type ProfileStore, clearProfile, loadProfile, saveProfile } from './storage';

/**
 * The save is the one thing in this app a child would genuinely mourn, so the
 * failure modes matter more than the happy path: a corrupt write, a half-written
 * file, a schema that moved on. None of them may throw on launch.
 */

function memoryStore(): ProfileStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
  };
}

describe('device persistence', () => {
  let store: ReturnType<typeof memoryStore>;

  beforeEach(() => {
    store = memoryStore();
  });

  it('round-trips a profile', async () => {
    const profile = createProfile({ trainerName: 'Leo', starterId: starters()[0]!.id });
    await saveProfile(profile, store);
    expect(await loadProfile(store)).toEqual(profile);
  });

  it('returns null when there is no save yet, rather than inventing one', async () => {
    expect(await loadProfile(store)).toBeNull();
  });

  it('treats a corrupt save as no save instead of crashing on launch', async () => {
    store.data.set(STORAGE_KEY, '{ this is not json');
    expect(await loadProfile(store)).toBeNull();
  });

  it('repairs a save written by an older or tampered-with version', async () => {
    // Unknown creature, negative XP, an invented badge, a wrong-typed streak.
    store.data.set(
      STORAGE_KEY,
      JSON.stringify({
        trainerName: 'Leo',
        starterId: 'not-a-creature',
        xp: -500,
        caught: ['cindik', 'also-not-a-creature'],
        badges: ['first-win', 'badge-that-never-existed'],
        streak: { current: 'lots' },
      }),
    );

    const repaired = await loadProfile(store);
    expect(repaired).not.toBeNull();
    expect(repaired!.xp).toBe(0);
    expect(repaired!.caught).not.toContain('also-not-a-creature');
    expect(repaired!.badges).toEqual(['first-win']);
    expect(repaired!.streak.current).toBe(0);
  });

  it('survives a storage layer that throws, because a failed write must not end a battle', async () => {
    const broken: ProfileStore = {
      getItem: async () => {
        throw new Error('disk full');
      },
      setItem: async () => {
        throw new Error('disk full');
      },
      removeItem: async () => {
        throw new Error('disk full');
      },
    };
    const profile = createProfile({ trainerName: 'Leo', starterId: starters()[0]!.id });

    await expect(saveProfile(profile, broken)).resolves.toBeUndefined();
    await expect(loadProfile(broken)).resolves.toBeNull();
    await expect(clearProfile(broken)).resolves.toBeUndefined();
  });

  it('uses the same storage key the web client uses, so the save means the same thing', () => {
    expect(STORAGE_KEY).toBe('mathmon.profile.v1');
  });
});
