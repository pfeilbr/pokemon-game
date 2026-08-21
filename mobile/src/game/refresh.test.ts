import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRemoteSave } from '../api';
import { type Profile, createProfile, getCreature, partnerFor, starters } from '../engine';
import { type ProfileStore, loadProfile, saveProfile } from '../storage';
import { FOREGROUND_REFRESH_MIN_MS, applyRemoteSave, planRefresh } from './refresh';

/**
 * Coming back to the app, without a renderer.
 *
 * The gap being closed is one `mobile/README.md` used to admit to: the server
 * was read on launch and on sign-in and never again. A React Native app is one
 * process that can live for weeks, so a child who played on the laptop and then
 * picked up an iPad that had been backgrounded since breakfast saw the album as
 * it stood at breakfast. Force-quitting fixes it, and a seven-year-old does not
 * know how to force-quit an app. A stale album does not look stale; it looks
 * like his creatures are gone.
 *
 * What is asserted here is not that a component re-rendered. It is the two
 * claims that make the feature safe to ship:
 *
 *   - a refresh only happens when it is worth happening, and a player with no
 *     account never causes a single request;
 *   - when it does happen it *merges*, and when it fails it changes nothing at
 *     all - the bytes on the device are the same bytes.
 *
 * Both are pure functions, so they are tested the way the engine's rules are.
 * The one piece of glue below, `foreground()`, mirrors the `AppState` handler in
 * `GameContext` step for step, the same way `flow.test.ts` mirrors
 * `BattleScreen`'s reducer wiring - it is what lets a request be counted rather
 * than assumed.
 */

const BASE = 'https://example.test';

/** Storage the test can inspect byte for byte, exactly as `storage.test.ts` does. */
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

const T0 = '2026-03-01T09:00:00.000Z';

function profileAt(updatedAt: string, extra: Partial<Profile> = {}): Profile {
  return {
    ...createProfile({ trainerName: 'Leo', starterId: 'cindik', now: T0 }),
    updatedAt,
    ...extra,
  };
}

/** A fetch stub that records every request, so "no request" is checkable. */
function recordingFetch(handler: (path: string, init: RequestInit) => unknown) {
  const calls: { path: string; method: string }[] = [];
  const mock = vi.fn(async (input: string, init: RequestInit = {}) => {
    calls.push({ path: input, method: (init.method ?? 'GET').toUpperCase() });
    return handler(input, init);
  });
  vi.stubGlobal('fetch', mock);
  return calls;
}

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

type Device = {
  store: ProfileStore & { data: Map<string, string> };
  latest: Profile | null;
  lastPullAt: number | null;
  pushQueued: boolean;
  signedIn: boolean;
  phase: 'active' | 'background' | 'inactive';
  pushedBack: Profile[];
};

async function device(save: Profile | null, over: Partial<Device> = {}): Promise<Device> {
  const store = memoryStore();
  if (save) await saveProfile(save, store);
  return {
    store,
    latest: save,
    lastPullAt: null,
    pushQueued: false,
    signedIn: true,
    phase: 'background',
    pushedBack: [],
    ...over,
  };
}

/**
 * One return to the foreground, wired exactly as `GameContext` wires it.
 *
 * Every decision in here is delegated: `planRefresh` says whether to ask,
 * `applyRemoteSave` says what the answer means. The rest is the carrying out,
 * and the two lines that matter are the ones that are *conditional* - the
 * device is only rewritten when the save actually changed, and the server is
 * only pushed when it is the side that is behind.
 */
async function foreground(d: Device, now: number) {
  const previous = d.phase;
  d.phase = 'active';

  const plan = planRefresh({
    previous,
    next: 'active',
    signedIn: d.signedIn,
    lastPullAt: d.lastPullAt,
    now,
    pushQueued: d.pushQueued,
  });
  if (!plan.pull) return plan;

  const remote = await fetchRemoteSave(BASE);
  // The interval only restarts when the server answered; everything else is
  // `applyRemoteSave`'s to decide, including what a miss means.
  if (remote.kind !== 'unavailable') d.lastPullAt = now;

  const outcome = applyRemoteSave(d.latest, remote);
  if (outcome.profile && outcome.writeDevice) {
    d.latest = outcome.profile;
    await saveProfile(outcome.profile, d.store);
  }
  if (outcome.profile && outcome.pushBack) d.pushedBack.push(outcome.profile);
  return plan;
}

/**
 * The claim the whole feature is subordinate to: whatever else happened, the
 * game can still be played from the save on the device.
 *
 * Deliberately not a snapshot. It reads the save back through the real
 * `storage.ts` - so `normaliseProfile` runs at the boundary, as it does on the
 * device - and then asks the engine for the two things every screen needs on
 * launch: who the partner is, and that each caught creature is a real one.
 * `getCreature` throws on an id the roster does not have, which is the failure
 * a broken sync would actually produce.
 */
async function stillPlayable(d: Device): Promise<Profile> {
  const save = await loadProfile(d.store);
  expect(save).not.toBeNull();
  expect(getCreature(partnerFor(save!)).id).toBeTruthy();
  for (const id of save!.caught) expect(getCreature(id).id).toBe(id);
  return save!;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('planRefresh', () => {
  const base = {
    previous: 'background' as const,
    next: 'active' as const,
    signedIn: true,
    lastPullAt: null,
    now: 10_000_000,
    pushQueued: false,
  };

  it('refreshes when a signed-in app returns to the foreground', () => {
    expect(planRefresh(base)).toEqual({ pull: true, reason: 'pull' });
  });

  it('treats inactive -> active as a return, because the iPad app switcher is', () => {
    // background -> inactive -> active is the real path back on iPadOS. A gate
    // that insisted on `background` would never fire there.
    expect(planRefresh({ ...base, previous: 'inactive' }).pull).toBe(true);
  });

  it('ignores everything that is not an arrival in the foreground', () => {
    expect(planRefresh({ ...base, next: 'background' }).reason).toBe('not-a-foreground');
    expect(planRefresh({ ...base, next: 'inactive' }).reason).toBe('not-a-foreground');
    expect(planRefresh({ ...base, previous: 'active' }).reason).toBe('not-a-foreground');
  });

  it('never asks anything of the server for a player with no account', () => {
    expect(planRefresh({ ...base, signedIn: false })).toEqual({
      pull: false,
      reason: 'local-only',
    });
  });

  it('stands down while this device still owes the server a push', () => {
    // The queued push means *this* device is the one that is ahead. Pulling
    // first would fetch a copy that predates it, merge it back and push anyway:
    // two round trips to reach where the queued push already goes on its own.
    expect(planRefresh({ ...base, pushQueued: true }).reason).toBe('push-queued');
  });

  it('does not fire again inside the minimum interval', () => {
    const lastPullAt = base.now - (FOREGROUND_REFRESH_MIN_MS - 1);
    expect(planRefresh({ ...base, lastPullAt })).toEqual({ pull: false, reason: 'too-soon' });
  });

  it('fires again once the interval has passed', () => {
    const lastPullAt = base.now - FOREGROUND_REFRESH_MIN_MS;
    expect(planRefresh({ ...base, lastPullAt }).pull).toBe(true);
  });

  it('is not wedged shut by a clock that moved backwards', () => {
    // This repository has already lost an afternoon to a device clock. The
    // interval is a courtesy to the battery, not a rule, so it must fail open.
    expect(planRefresh({ ...base, lastPullAt: base.now + 3_600_000 }).pull).toBe(true);
  });
});

describe('a foreground refresh', () => {
  it('makes no request at all when nobody is signed in', async () => {
    const calls = recordingFetch(() => okJson({ profile: profileAt(T0) }));
    const d = await device(profileAt(T0), { signedIn: false });
    const before = new Map(d.store.data);

    expect((await foreground(d, 10_000_000)).reason).toBe('local-only');

    expect(calls).toEqual([]);
    expect(d.store.data).toEqual(before);
    await stillPlayable(d);
  });

  it('makes no request when it already asked a moment ago', async () => {
    const calls = recordingFetch(() => okJson({ profile: profileAt(T0) }));
    const now = 10_000_000;
    const d = await device(profileAt(T0), { lastPullAt: now - 5_000 });

    expect((await foreground(d, now)).reason).toBe('too-soon');
    expect(calls).toEqual([]);

    // ...and one that is worth making still is.
    d.phase = 'background';
    await foreground(d, now + FOREGROUND_REFRESH_MIN_MS);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
  });

  it('merges the server in rather than replacing the device save', async () => {
    // The scenario the feature exists for, with the danger written into it: the
    // laptop is newer *and* the iPad holds creatures the laptop has never seen,
    // caught offline on the train. A replace loses them; a merge keeps both.
    const onlyOnDevice = starters()[4]!.id;
    const onlyOnServer = starters()[7]!.id;

    const deviceSave = profileAt('2026-03-01T09:00:00.000Z', {
      caught: ['cindik', onlyOnDevice],
      badges: ['first-win'],
      xp: 400,
      battlesWon: 9,
    });
    const serverSave = profileAt('2026-03-01T18:00:00.000Z', {
      caught: ['cindik', onlyOnServer],
      badges: ['streak-3'],
      xp: 120,
      battlesWon: 2,
      trainerName: 'Leo the Bold',
    });

    recordingFetch(() => okJson({ profile: serverSave }));
    const d = await device(deviceSave);

    await foreground(d, 10_000_000);
    const save = await stillPlayable(d);

    // Everything earned on either side survives, from both directions.
    expect(save.caught).toContain(onlyOnDevice);
    expect(save.caught).toContain(onlyOnServer);
    expect(save.badges).toEqual(expect.arrayContaining(['first-win', 'streak-3']));
    // Lifetime counters and records take the larger, never the newer.
    expect(save.xp).toBe(400);
    expect(save.battlesWon).toBe(9);
    // Mutable state is the only place last-write-wins still applies.
    expect(save.trainerName).toBe('Leo the Bold');

    // The device had something the server lacked, so the server is caught up -
    // once. It is the only push a refresh can cause.
    expect(d.pushedBack).toHaveLength(1);
    expect(d.pushedBack[0]!.caught).toContain(onlyOnDevice);
  });

  it('costs a single GET and no push when only the server is ahead', async () => {
    // The plain hand-off: nothing was earned on the phone since the last sync,
    // so `reconcile` hands back the server's own object and there is nothing to
    // send. This is what stops two devices pushing at each other forever.
    const deviceSave = profileAt('2026-03-01T09:00:00.000Z', { caught: ['cindik'], xp: 10 });
    const serverSave = profileAt('2026-03-01T18:00:00.000Z', {
      caught: ['cindik', starters()[3]!.id],
      xp: 500,
    });

    const calls = recordingFetch(() => okJson({ profile: serverSave }));
    const d = await device(deviceSave);

    await foreground(d, 10_000_000);

    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(d.pushedBack).toEqual([]);
    expect((await stillPlayable(d)).xp).toBe(500);
  });

  it('converges and then goes quiet, so two devices cannot ping-pong', async () => {
    // Round one: the phone is ahead, so it pushes. Round two: the server now
    // holds what the phone sent, so there is nothing to send back. Without the
    // reference-identity contract `reconcile` publishes, every foreground from
    // here on would be a fresh PUT, forever, on both devices.
    const phone = profileAt('2026-03-01T18:00:00.000Z', {
      caught: ['cindik', starters()[2]!.id],
      xp: 300,
    });
    let server = profileAt('2026-03-01T09:00:00.000Z', { caught: ['cindik'], xp: 10 });

    recordingFetch(() => okJson({ profile: server }));
    const d = await device(phone);

    await foreground(d, 10_000_000);
    expect(d.pushedBack).toHaveLength(1);

    // The server took the push, as `saveProfileMerged` would.
    server = d.pushedBack[0]!;

    d.phase = 'background';
    await foreground(d, 10_000_000 + FOREGROUND_REFRESH_MIN_MS);
    expect(d.pushedBack).toHaveLength(1);

    d.phase = 'background';
    await foreground(d, 10_000_000 + 2 * FOREGROUND_REFRESH_MIN_MS);
    expect(d.pushedBack).toHaveLength(1);
  });

  it('leaves the save byte-identical when the network is flat', async () => {
    const deviceSave = profileAt(T0, { caught: ['cindik', starters()[5]!.id], xp: 250 });
    recordingFetch(() => {
      throw new Error('Network request failed');
    });

    const d = await device(deviceSave);
    const before = new Map(d.store.data);

    await foreground(d, 10_000_000);

    expect(d.store.data).toEqual(before);
    expect(d.latest).toBe(deviceSave);
    expect(d.pushedBack).toEqual([]);
    // Nothing was learned, so the interval must not start counting either -
    // the next foreground is still allowed to try.
    expect(d.lastPullAt).toBeNull();
    await stillPlayable(d);
  });

  it('leaves the save byte-identical when the request times out', async () => {
    vi.useFakeTimers();
    const deviceSave = profileAt(T0, { caught: ['cindik', starters()[6]!.id], xp: 250 });

    // A server that never answers: the request lives until `api.ts` aborts it.
    recordingFetch(
      (_path, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
        }),
    );

    const d = await device(deviceSave);
    const before = new Map(d.store.data);

    const pending = foreground(d, 10_000_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;

    expect(d.store.data).toEqual(before);
    expect(d.latest).toBe(deviceSave);
    expect(d.pushedBack).toEqual([]);
    expect(d.lastPullAt).toBeNull();
    await stillPlayable(d);
  });

  it('treats an account with no save yet as the server being behind', async () => {
    // Not a miss. A fresh account has nothing stored, and the phone holds the
    // only copy - collapsing this into the flat-network case is what would make
    // a first sign-in silently fail to upload.
    const deviceSave = profileAt(T0, { xp: 90 });
    recordingFetch(() => okJson({ profile: null }));

    const d = await device(deviceSave);
    const before = new Map(d.store.data);

    await foreground(d, 10_000_000);

    expect(d.store.data).toEqual(before);
    expect(d.pushedBack).toEqual([deviceSave]);
    await stillPlayable(d);
  });
});

describe('applyRemoteSave', () => {
  it('hands back the caller’s own object when the server cannot be reached', () => {
    const local = profileAt(T0);
    expect(applyRemoteSave(local, { kind: 'unavailable', reason: 'offline' })).toEqual({
      profile: local,
      writeDevice: false,
      pushBack: false,
    });
    // Reference identity, not deep equality: nothing is rewritten, so nothing
    // downstream can decide something changed.
    expect(applyRemoteSave(local, { kind: 'unavailable', reason: 'offline' }).profile).toBe(local);
  });

  it('does not rewrite the device when the server merely agrees with it', () => {
    const local = profileAt(T0, { caught: ['cindik'], xp: 40 });
    const remote = { ...local, xp: 10, updatedAt: '2026-02-01T00:00:00.000Z' };
    const outcome = applyRemoteSave(local, { kind: 'profile', profile: remote });
    expect(outcome.profile).toBe(local);
    expect(outcome.writeDevice).toBe(false);
  });

  it('survives a device with no save at all', () => {
    const remote = profileAt(T0);
    const outcome = applyRemoteSave(null, { kind: 'profile', profile: remote });
    expect(outcome.profile).toBe(remote);
    expect(outcome.writeDevice).toBe(true);
    expect(outcome.pushBack).toBe(false);

    expect(applyRemoteSave(null, { kind: 'none' })).toEqual({
      profile: null,
      writeDevice: false,
      pushBack: false,
    });
  });
});
