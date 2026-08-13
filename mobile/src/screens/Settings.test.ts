import { describe, expect, it, vi } from 'vitest';

/**
 * The settings transitions.
 *
 * There is no React Native test renderer in this project and there should not
 * be one: the interesting part of a settings screen is not that a `<Pressable>`
 * rendered, it is that flipping a switch changes exactly one field of the save
 * and nothing else. So the transitions are exported as pure functions and
 * tested directly, the same way the engine is.
 *
 * The two mocks below are the price of importing a `.tsx` screen into a Node
 * test run: `react-native` and `expo-haptics` are Metro/Hermes modules that
 * cannot be evaluated outside a bundler. Nothing under test touches either.
 */
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (sheet: unknown) => sheet },
  Text: 'Text',
  View: 'View',
}));
vi.mock('expo-haptics', () => ({
  impactAsync: () => undefined,
  notificationAsync: () => undefined,
  ImpactFeedbackStyle: { Light: 'Light', Heavy: 'Heavy' },
  NotificationFeedbackType: { Success: 'Success', Warning: 'Warning' },
}));

const { createProfile, normaliseProfile, starters } = await import('../engine');
const { toggleSound, withLanguage } = await import('./Settings');

type Profile = ReturnType<typeof createProfile>;

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';

function profileAt(now: string): Profile {
  const base = createProfile({ trainerName: 'Leo', starterId: starters()[0]!.id, now });
  // A save with some history on it, so "changed nothing else" is a real claim.
  return {
    ...base,
    xp: 240,
    battlesWon: 3,
    badges: ['first-win'],
    tier: 2,
    streak: { current: 4, best: 6, lastPlayed: '2026-01-01' },
  };
}

/** Everything a settings change must leave alone. */
function everythingElse(profile: Profile) {
  const { settings, updatedAt, ...rest } = profile;
  return rest;
}

describe('settings transitions', () => {
  it('switches the language and touches nothing but the language', () => {
    const before = profileAt(T0);
    const after = withLanguage(before, 'zh', T1);

    expect(after.settings.language).toBe('zh');
    expect(after.settings.sound).toBe(before.settings.sound);
    expect(everythingElse(after)).toEqual(everythingElse(before));
  });

  it('switches back to English, so the toggle is not one-way', () => {
    const zh = withLanguage(profileAt(T0), 'zh', T1);
    expect(withLanguage(zh, 'en', T1).settings.language).toBe('en');
  });

  it('toggles sound and touches nothing but sound', () => {
    const before = profileAt(T0);
    expect(before.settings.sound).toBe(true);

    const off = toggleSound(before, T1);
    expect(off.settings.sound).toBe(false);
    expect(off.settings.language).toBe(before.settings.language);
    expect(everythingElse(off)).toEqual(everythingElse(before));

    expect(toggleSound(off, T1).settings.sound).toBe(true);
  });

  it('never mutates the profile it was given', () => {
    const before = profileAt(T0);
    const snapshot = JSON.parse(JSON.stringify(before));

    withLanguage(before, 'zh', T1);
    toggleSound(before, T1);

    expect(before).toEqual(snapshot);
  });

  it('round-trips through normaliseProfile unchanged, so the save survives a reload', () => {
    const zh = withLanguage(profileAt(T0), 'zh', T1);
    expect(normaliseProfile(zh)).toEqual(zh);

    const muted = toggleSound(zh, T1);
    expect(normaliseProfile(muted)).toEqual(muted);
    // And through a real save/load cycle, not just the in-memory object.
    const reloaded = normaliseProfile(JSON.parse(JSON.stringify(muted)));
    expect(reloaded?.settings).toEqual({ language: 'zh', sound: false });
  });

  it('stamps updatedAt with the time it was handed', () => {
    expect(withLanguage(profileAt(T0), 'zh', T1).updatedAt).toBe(T1);
    expect(toggleSound(profileAt(T0), T1).updatedAt).toBe(T1);
  });

  it('never moves updatedAt backwards, because sync resolves last-write-wins on it', () => {
    // A device whose clock is behind must not be able to stamp a change with a
    // timestamp older than the save it is changing - the server would keep the
    // stale copy and the child's setting would come back on the next sync.
    const before = profileAt(T1);
    const stale = '2025-06-01T00:00:00.000Z';

    expect(withLanguage(before, 'zh', stale).updatedAt).toBe(before.updatedAt);
    expect(toggleSound(before, stale).updatedAt).toBe(before.updatedAt);
    // The change itself still lands.
    expect(withLanguage(before, 'zh', stale).settings.language).toBe('zh');
    expect(toggleSound(before, stale).settings.sound).toBe(false);
  });
});
