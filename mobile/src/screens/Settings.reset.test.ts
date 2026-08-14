import { describe, expect, it, vi } from 'vitest';
import type { ProfileStore } from '../storage';
import type { ResetPress, ResetStage } from './Settings';

/**
 * Start over — the gate, without a renderer.
 *
 * The web client has been able to delete a save since the beginning; this
 * client could not, and a child who wanted a fresh start on the iPad had to ask
 * an adult to delete the app. The gap was closable. What was not negotiable is
 * the safeguard: `CLAUDE.md` says a child losing his album to a schema change is
 * not an acceptable failure, and losing it to a mis-tap is the same loss by a
 * duller route.
 *
 * So the gate is a pure function, tested here the way the engine's rules are:
 * one press in, the next stage and a single `wipe` flag out. The claim under
 * test is not that a `<Pressable>` rendered — it is that exactly one sequence of
 * presses can reach the save, and that every other sequence leaves it alone.
 * The clear itself runs through the real `storage.ts`, against an injected
 * store, so "gone" means gone from the same boundary the device writes to.
 *
 * The two mocks below are the price of importing a `.tsx` screen into a Node
 * test run, exactly as in `Settings.test.ts`: `react-native` and `expo-haptics`
 * are Metro/Hermes modules that cannot be evaluated outside a bundler. Nothing
 * under test touches either.
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

const { createProfile, starters } = await import('../engine');
const { nextReset, startOverPlan } = await import('./Settings');
const { clearProfile, loadProfile, saveProfile } = await import('../storage');

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

const T0 = '2026-01-01T00:00:00.000Z';

function album() {
  const base = createProfile({ trainerName: 'Leo', starterId: starters()[0]!.id, now: T0 });
  // Weeks of collecting. This is the thing a mis-tap would cost.
  return { ...base, xp: 1240, battlesWon: 17, badges: ['first-win'], caught: [starters()[0]!.id] };
}

/**
 * The screen's own wiring, minus React.
 *
 * `Settings.tsx` does exactly this: hand the press to `nextReset`, keep the
 * stage it returns, and clear the save only if it said to. Reproducing those
 * three lines here is what lets the test assert on the save rather than on a
 * boolean — if the gate ever opens on the wrong press, this fails on a missing
 * album, which is the failure a child would feel.
 */
async function press(
  stage: ResetStage,
  what: ResetPress,
  store: ProfileStore,
): Promise<ResetStage> {
  const step = nextReset(stage, what);
  if (step.wipe) await clearProfile(store);
  return step.stage;
}

describe('start over', () => {
  it('asks first: one press opens the confirmation and touches nothing', async () => {
    const store = memoryStore();
    await saveProfile(album(), store);

    const step = nextReset('idle', 'startOver');
    expect(step.stage).toBe('confirming');
    expect(step.wipe).toBe(false);

    expect(await loadProfile(store)).toEqual(album());
  });

  it('leaves the save exactly as it was when the confirmation is dismissed', async () => {
    const store = memoryStore();
    await saveProfile(album(), store);

    let stage: ResetStage = 'idle';
    stage = await press(stage, 'startOver', store);
    stage = await press(stage, 'back', store);

    expect(stage).toBe('idle');
    expect(await loadProfile(store)).toEqual(album());
  });

  it('clears the save only after the delete is confirmed', async () => {
    const store = memoryStore();
    await saveProfile(album(), store);

    let stage: ResetStage = 'idle';
    stage = await press(stage, 'startOver', store);
    expect(await loadProfile(store)).not.toBeNull();

    stage = await press(stage, 'delete', store);

    expect(await loadProfile(store)).toBeNull();
    // And back to the quiet state, so the screen never re-opens holding a
    // confirmation for a save that no longer exists.
    expect(stage).toBe('idle');
  });

  it('cannot be wiped by a delete that never passed the confirmation', async () => {
    // The whole point of two deliberate actions: a `delete` arriving at `idle`
    // - a stale tap, a mis-wired button, a future refactor that forgets the
    // gate - must be inert rather than destructive.
    const store = memoryStore();
    await saveProfile(album(), store);

    const step = nextReset('idle', 'delete');
    expect(step.wipe).toBe(false);
    expect(step.stage).toBe('idle');

    expect(await press('idle', 'delete', store)).toBe('idle');
    expect(await loadProfile(store)).toEqual(album());
  });

  it('can be opened, dismissed and opened again, so a change of mind is free', async () => {
    const store = memoryStore();
    await saveProfile(album(), store);

    let stage: ResetStage = 'idle';
    for (let i = 0; i < 3; i += 1) {
      stage = await press(stage, 'startOver', store);
      expect(stage).toBe('confirming');
      stage = await press(stage, 'back', store);
      expect(stage).toBe('idle');
    }
    expect(await loadProfile(store)).toEqual(album());
  });

  it('never destroys the account copy, signed in or not', () => {
    // Start over means "start over on this device". The web client's reset
    // clears local storage and nothing else - there is no endpoint that deletes
    // an account's save, on either client - so an album that reached the server
    // is still there to sign back into. Deciding otherwise would make a mis-tap
    // on a phone able to erase what was earned on the laptop.
    expect(startOverPlan(true).deleteAccountCopy).toBe(false);
    expect(startOverPlan(false).deleteAccountCopy).toBe(false);

    // Signed in, the session is dropped *first*: signing out flushes the save
    // still queued for the server, so the last battle reaches the account
    // before the device forgets it, and the fresh profile that sign-up creates
    // afterwards is never pushed over it.
    expect(startOverPlan(true).signOutFirst).toBe(true);
    expect(startOverPlan(false).signOutFirst).toBe(false);

    // Both cases still clear this device. That is the part the child asked for.
    expect(startOverPlan(true).clearDevice).toBe(true);
    expect(startOverPlan(false).clearDevice).toBe(true);
  });
});
