import { type Profile, normaliseProfile, reconcile } from '@/lib/game/progress';
import { STORAGE_KEY } from './key';

// Re-exported so callers keep importing their persistence helpers from one
// place, even though the conflict rule itself belongs to the engine.
export { reconcile };

/**
 * Client-side persistence.
 *
 * The game is offline-first on purpose. The profile always lives in
 * localStorage, so a child can play instantly with no account, no network and
 * no configuration - which is also why the app deploys to Vercel with zero
 * environment variables set. Signing in is an *upgrade* that mirrors the same
 * profile to the server so it follows him to another device.
 */

// Defined in `./key` and re-exported here, so every existing caller keeps its
// import and the crash-recovery screen can read the key without importing the
// engine. See the note in that file.
export { STORAGE_KEY } from './key';

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    // Access can throw outright in Safari private mode.
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadLocal(): Profile | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normaliseProfile(JSON.parse(raw));
  } catch {
    // Corrupt JSON should mean "no save", never a white screen.
    return null;
  }
}

export function saveLocal(profile: Profile): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Quota exceeded or blocked. The in-memory profile still works for this
    // session, so carry on rather than interrupting play.
  }
}

export function clearLocal(): void {
  storage()?.removeItem(STORAGE_KEY);
}

// ---------------------------------------------------------------------------
// Server sync
// ---------------------------------------------------------------------------

export type SessionInfo = {
  signedIn: boolean;
  trainerName: string | null;
  provider: 'pin' | 'google' | null;
  /** False when the deployment has no database configured. */
  accountsAvailable: boolean;
  googleAvailable: boolean;
};

export async function fetchSession(): Promise<SessionInfo> {
  try {
    const res = await fetch('/api/session', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as SessionInfo;
  } catch {
    return {
      signedIn: false,
      trainerName: null,
      provider: null,
      accountsAvailable: false,
      googleAvailable: false,
    };
  }
}

export async function fetchRemoteProfile(): Promise<Profile | null> {
  try {
    const res = await fetch('/api/profile', { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { profile: unknown };
    return normaliseProfile(body.profile);
  } catch {
    return null;
  }
}

export async function pushRemoteProfile(profile: Profile): Promise<boolean> {
  try {
    const res = await fetch('/api/profile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
