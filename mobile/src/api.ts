import { type Profile, normaliseProfile } from './engine';

/**
 * Backend client.
 *
 * Talks to the same Next.js API the web app uses, so accounts and saved
 * progress are shared between the two clients rather than forked.
 *
 * The base URL is build-time configuration, never a hardcoded host: set
 * EXPO_PUBLIC_API_URL when building. With none set the client runs in
 * local-only mode, which mirrors how the web app behaves with no database.
 *
 * The session is an httpOnly cookie set by the server. React Native's fetch
 * uses the platform cookie store on iOS, so it is sent back automatically and
 * this client never sees, stores or forwards a credential itself - the same
 * property the web client has, for the same reason.
 */

export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? '';

export type SessionInfo = {
  signedIn: boolean;
  trainerName: string | null;
  provider: 'pin' | 'google' | null;
  accountsAvailable: boolean;
  googleAvailable: boolean;
};

export type BackendStatus =
  | { kind: 'not-configured' }
  | { kind: 'reachable'; session: SessionInfo }
  | { kind: 'unreachable'; reason: string };

/**
 * Why a sign-in failed, in the server's own vocabulary.
 *
 * `mismatch` deliberately covers both "no such trainer" and "wrong PIN" - the
 * server refuses to distinguish them so the endpoint cannot be used to find out
 * which children exist, and this client must not undo that by guessing.
 */
export type AuthFailure = 'mismatch' | 'locked' | 'taken' | 'invalid' | 'unavailable' | 'network';

export type AuthResult = { ok: true; trainerName: string } | { ok: false; reason: AuthFailure };

/** Requests give up rather than hanging a screen forever. */
const TIMEOUT_MS = 8000;

function url(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

/** One fetch with a timeout. Never throws; the caller decides what a miss means. */
async function request(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url(baseUrl, path), {
      ...init,
      signal: controller.signal,
      headers: { accept: 'application/json', ...init.headers },
    });
    return { response };
  } catch (error) {
    // The message is kept, not flattened to a constant: "offline" and "aborted"
    // send a parent looking in different places, and the shell shows this text.
    return { error: error instanceof Error ? error.message : 'network error' };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchSession(baseUrl = API_BASE_URL): Promise<BackendStatus> {
  if (!baseUrl) return { kind: 'not-configured' };

  const result = await request(baseUrl, '/api/session');
  if ('error' in result) return { kind: 'unreachable', reason: result.error };
  const { response } = result;
  if (!response.ok) return { kind: 'unreachable', reason: `HTTP ${response.status}` };

  let body: Partial<SessionInfo>;
  try {
    body = (await response.json()) as Partial<SessionInfo>;
  } catch {
    return { kind: 'unreachable', reason: 'unexpected response shape' };
  }

  // Trust nothing off the wire: a screen must not crash on a bad payload.
  if (typeof body.accountsAvailable !== 'boolean') {
    return { kind: 'unreachable', reason: 'unexpected response shape' };
  }

  return {
    kind: 'reachable',
    session: {
      signedIn: body.signedIn === true,
      trainerName: typeof body.trainerName === 'string' ? body.trainerName : null,
      provider: body.provider === 'pin' || body.provider === 'google' ? body.provider : null,
      accountsAvailable: body.accountsAvailable,
      googleAvailable: body.googleAvailable === true,
    },
  };
}

/**
 * Sign in, or create an account, with a trainer name and a 4-digit PIN.
 *
 * Both go to the same endpoint; `mode` decides which. The failure reasons come
 * straight from the server rather than being inferred from the status code, so
 * a locked account reads as locked rather than as a wrong PIN - a child who is
 * locked out needs to be told to wait, not to keep guessing.
 */
export async function signInWithPin(
  name: string,
  pin: string,
  mode: 'login' | 'register' = 'login',
  baseUrl = API_BASE_URL,
): Promise<AuthResult> {
  if (!baseUrl) return { ok: false, reason: 'unavailable' };

  const result = await request(baseUrl, '/api/auth/pin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, pin, mode }),
  });
  if ('error' in result) return { ok: false, reason: 'network' };
  const { response } = result;

  let body: { ok?: unknown; trainerName?: unknown; error?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // A body-less 200 would otherwise read as a successful sign-in.
    return { ok: false, reason: response.ok ? 'unavailable' : 'network' };
  }

  if (response.ok && body.ok === true) {
    return {
      ok: true,
      trainerName: typeof body.trainerName === 'string' ? body.trainerName : name,
    };
  }

  const reason = typeof body.error === 'string' ? body.error : '';
  const known: AuthFailure[] = ['mismatch', 'locked', 'taken', 'invalid', 'unavailable'];
  return {
    ok: false,
    reason: known.includes(reason as AuthFailure) ? (reason as AuthFailure) : 'unavailable',
  };
}

export async function signOut(baseUrl = API_BASE_URL): Promise<void> {
  if (!baseUrl) return;
  await request(baseUrl, '/api/auth/signout', { method: 'POST' });
}

/**
 * What the server had, or why this client does not know.
 *
 * The three cases are kept apart because two of them call for opposite
 * reactions and the third for none at all:
 *
 * - `profile` - a save to reconcile against.
 * - `none` - reached the server, and this account has no save yet. The device
 *   holds the only copy, so the server is the side that is behind.
 * - `unavailable` - no answer: offline, timed out, or the deployment has no
 *   database. Nothing is known, so nothing should happen and nothing should be
 *   said.
 *
 * Collapsing `none` and `unavailable` into one `null`, which is all
 * `fetchRemoteProfile` below can express, is harmless on launch - there is
 * nothing on the device yet worth protecting - but not on a foreground
 * refresh, where it would turn a flat network into an upload attempt every
 * time the app is opened.
 */
export type RemoteSave =
  | { kind: 'profile'; profile: Profile }
  | { kind: 'none' }
  | { kind: 'unavailable'; reason: string };

/**
 * Reads the profile the server holds.
 *
 * Normalised on arrival: the server is trusted to be the server, not to be
 * running the same version of the game as this phone.
 */
export async function fetchRemoteSave(baseUrl = API_BASE_URL): Promise<RemoteSave> {
  if (!baseUrl) return { kind: 'unavailable', reason: 'not configured' };

  const result = await request(baseUrl, '/api/profile');
  if ('error' in result) return { kind: 'unavailable', reason: result.error };
  const { response } = result;
  if (!response.ok) return { kind: 'unavailable', reason: `HTTP ${response.status}` };

  let body: { profile?: unknown };
  try {
    body = (await response.json()) as { profile?: unknown };
  } catch {
    return { kind: 'unavailable', reason: 'unexpected response shape' };
  }

  // `normaliseProfile` returns null for anything that is not an object, which
  // is what an account with no save stored looks like on the wire.
  const profile = normaliseProfile(body.profile);
  return profile === null ? { kind: 'none' } : { kind: 'profile', profile };
}

/**
 * The profile the server holds, or null.
 *
 * The flattened form of `fetchRemoteSave`, kept for the callers that genuinely
 * cannot act on the difference.
 */
export async function fetchRemoteProfile(baseUrl = API_BASE_URL): Promise<Profile | null> {
  const save = await fetchRemoteSave(baseUrl);
  return save.kind === 'profile' ? save.profile : null;
}

/** Mirrors the device's save to the server. Returns whether it landed. */
export async function pushRemoteProfile(
  profile: Profile,
  baseUrl = API_BASE_URL,
): Promise<boolean> {
  if (!baseUrl) return false;

  const result = await request(baseUrl, '/api/profile', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile }),
  });
  return 'response' in result && result.response.ok;
}
