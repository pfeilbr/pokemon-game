import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProfile, normaliseProfile, reconcile, starters, type Profile } from './engine';
import { fetchRemoteProfile, fetchSession, pushRemoteProfile, signInWithPin, signOut } from './api';

/**
 * The API contract, against a real server.
 *
 * `api.test.ts` covers this client's behaviour with a stubbed `fetch` - what it
 * does when the network is bad, when a proxy returns HTML, when the payload is
 * the wrong shape. What it cannot cover is whether the requests this client
 * sends are the ones the Next.js routes actually accept. A mocked fetch agrees
 * with whatever the mock was written to expect, which is exactly the way a
 * client and a server drift apart.
 *
 * So this file talks to a running server. It skips itself unless one is
 * offered, which keeps `npm test` dependency-free:
 *
 *   npm run build && DATABASE_URL=... npm start        # in the repo root
 *   TEST_API_URL=http://127.0.0.1:3000 npm test        # in mobile/
 *
 * CI does not run it; the root E2E suite covers the same routes from the
 * browser. It exists so that a change to the server contract is caught here
 * rather than on a child's phone.
 */

const BASE = process.env.TEST_API_URL ?? '';
const describeLive = BASE ? describe : describe.skip;

/**
 * A cookie jar, because node's `fetch` has none.
 *
 * The session is an httpOnly cookie. On iOS the platform cookie store does
 * this, which is why `api.ts` never touches a credential; here that store has
 * to be stood in for, or every request after sign-in would arrive anonymous and
 * this file would test nothing but 401s.
 */
function installCookieJar(): () => void {
  const original = globalThis.fetch;
  const jar = new Map<string, string>();

  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const response = await original(input, {
      ...init,
      headers: cookie ? { ...init.headers, cookie } : init.headers,
    });

    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const index = pair?.indexOf('=') ?? -1;
      if (index > 0) {
        const name = pair!.slice(0, index);
        const value = pair!.slice(index + 1);
        if (value === '') jar.delete(name);
        else jar.set(name, value);
      }
    }
    return response;
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}

/**
 * Unique per run, so repeated runs against the same database do not collide.
 *
 * Kept inside the server's own 2-16 character limit (`isValidName`). The first
 * draft of this file used a longer name and every request came back `invalid`,
 * which is the live test earning its place before it had tested anything: a
 * mocked fetch would have happily accepted it.
 */
const trainerName = `ios${process.pid.toString(36)}${Math.floor(Date.now() / 1000).toString(36)}`;
const PIN = '4813';

let restore: () => void;

describeLive('the iOS client against a live server', () => {
  beforeAll(() => {
    restore = installCookieJar();
  });

  afterAll(async () => {
    await signOut(BASE);
    restore?.();
  });

  it('reaches the server and finds accounts enabled', async () => {
    const status = await fetchSession(BASE);
    expect(status.kind).toBe('reachable');
    if (status.kind !== 'reachable') return;
    // Without a database the rest of this file is meaningless, so say so
    // clearly rather than failing later with something obscure.
    expect(status.session.accountsAvailable).toBe(true);
  });

  it('creates an account and comes back signed in', async () => {
    const created = await signInWithPin(trainerName, PIN, 'register', BASE);
    expect(created).toEqual({ ok: true, trainerName });

    const status = await fetchSession(BASE);
    expect(status.kind === 'reachable' && status.session.signedIn).toBe(true);
  });

  it('refuses a second account with the same name', async () => {
    const again = await signInWithPin(trainerName, PIN, 'register', BASE);
    expect(again).toEqual({ ok: false, reason: 'taken' });
  });

  it('round-trips a profile through the server', async () => {
    const profile = createProfile({ trainerName, starterId: starters()[0]!.id });
    expect(await pushRemoteProfile(profile, BASE)).toBe(true);

    const remote = await fetchRemoteProfile(BASE);
    expect(remote).not.toBeNull();
    expect(remote!.trainerName).toBe(trainerName);
    expect(remote!.starterId).toBe(profile.starterId);
  });

  it('keeps the newer save when the device and the server disagree', async () => {
    const older: Profile = {
      ...createProfile({ trainerName, starterId: starters()[0]!.id }),
      xp: 10,
      updatedAt: '2020-01-01T00:00:00.000Z',
    };
    const newer: Profile = { ...older, xp: 999, updatedAt: '2030-01-01T00:00:00.000Z' };

    await pushRemoteProfile(newer, BASE);
    const remote = await fetchRemoteProfile(BASE);
    // The engine's rule, applied to a real server's answer.
    expect(reconcile(older, remote)?.xp).toBe(999);
  });

  it('normalises whatever the server returns rather than trusting it', async () => {
    const remote = await fetchRemoteProfile(BASE);
    expect(remote).not.toBeNull();
    expect(normaliseProfile(remote)).toEqual(remote);
  });

  it('rejects a wrong PIN without saying whether the name exists', async () => {
    // Both names must be *valid*, or this proves nothing: an over-long name is
    // refused as `invalid` before any lookup happens, which is a different
    // answer for a different reason and gives nothing away either way. The
    // first draft compared against a 23-character name and failed for exactly
    // that reason - the property under test is about two names the server
    // would actually go and look for.
    const absent = `nobody${trainerName.slice(3, 12)}`;
    expect(absent.length).toBeLessThanOrEqual(16);

    const wrongPin = await signInWithPin(trainerName, '0000', 'login', BASE);
    const noSuchName = await signInWithPin(absent, PIN, 'login', BASE);

    // Same answer for both, which is the property accounts.ts is built to keep.
    expect(wrongPin).toEqual({ ok: false, reason: 'mismatch' });
    expect(noSuchName).toEqual(wrongPin);
  });

  it('signs back in with the right PIN', async () => {
    const back = await signInWithPin(trainerName, PIN, 'login', BASE);
    expect(back.ok).toBe(true);
  });

  it('stops serving the profile once signed out', async () => {
    await signOut(BASE);

    const status = await fetchSession(BASE);
    expect(status.kind === 'reachable' && status.session.signedIn).toBe(false);
    expect(await fetchRemoteProfile(BASE)).toBeNull();
  });
});
