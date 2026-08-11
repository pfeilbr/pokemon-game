'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type Language, type Profile } from '@/lib/game/progress';
import { type Cue, play } from '@/lib/audio';
import { type StringKey, t } from '@/lib/i18n';
import {
  type SessionInfo,
  clearLocal,
  fetchRemoteProfile,
  fetchSession,
  loadLocal,
  pushRemoteProfile,
  reconcile,
  saveLocal,
} from '@/lib/storage/client';

export type SyncState = 'local' | 'saving' | 'saved' | 'error';

type GameContextValue = {
  profile: Profile | null;
  /** True until the first load from storage settles. */
  loading: boolean;
  session: SessionInfo;
  syncState: SyncState;
  language: Language;
  /** Applies a change and persists it. */
  update: (fn: (profile: Profile) => Profile) => void;
  /** Replaces the profile wholesale (sign-up, sign-in, reset). */
  setProfile: (profile: Profile | null) => void;
  refreshSession: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Plays a sound cue if the player has sound on. */
  cue: (cue: Cue) => void;
  /** Translates a UI string into the player's language. */
  tr: (key: StringKey) => string;
};

const GameContext = createContext<GameContextValue | null>(null);

const EMPTY_SESSION: SessionInfo = {
  signedIn: false,
  trainerName: null,
  provider: null,
  accountsAvailable: false,
  googleAvailable: false,
};

/** How long to wait after the last change before pushing to the server. */
const SYNC_DEBOUNCE_MS = 1200;

export function GameProvider({ children }: { children: React.ReactNode }) {
  const [profile, setProfileState] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<SessionInfo>(EMPTY_SESSION);
  const [syncState, setSyncState] = useState<SyncState>('local');

  const pendingSync = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestProfile = useRef<Profile | null>(null);

  // First load: read the device save immediately so play can start, then ask
  // the server whether there is a newer one to merge in.
  useEffect(() => {
    let cancelled = false;

    const local = loadLocal();
    if (local) {
      setProfileState(local);
      latestProfile.current = local;
    }
    setLoading(false);

    void (async () => {
      const info = await fetchSession();
      if (cancelled) return;
      setSession(info);

      if (!info.signedIn) return;

      const remote = await fetchRemoteProfile();
      if (cancelled) return;

      const winner = reconcile(local, remote);
      if (winner) {
        setProfileState(winner);
        latestProfile.current = winner;
        saveLocal(winner);
        // If the device copy was ahead, get the server caught up.
        if (winner !== remote) void pushRemoteProfile(winner);
      }
      setSyncState('saved');
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(
    (next: Profile, signedIn: boolean) => {
      saveLocal(next);
      latestProfile.current = next;

      if (!signedIn) {
        setSyncState('local');
        return;
      }

      setSyncState('saving');
      if (pendingSync.current) clearTimeout(pendingSync.current);
      pendingSync.current = setTimeout(() => {
        const toPush = latestProfile.current;
        if (!toPush) return;
        void pushRemoteProfile(toPush).then((ok) => setSyncState(ok ? 'saved' : 'error'));
      }, SYNC_DEBOUNCE_MS);
    },
    [],
  );

  const update = useCallback(
    (fn: (profile: Profile) => Profile) => {
      setProfileState((current) => {
        if (!current) return current;
        const next = fn(current);
        persist(next, session.signedIn);
        return next;
      });
    },
    [persist, session.signedIn],
  );

  const setProfile = useCallback(
    (next: Profile | null) => {
      setProfileState(next);
      if (next) {
        persist(next, session.signedIn);
      } else {
        clearLocal();
        latestProfile.current = null;
        setSyncState('local');
      }
    },
    [persist, session.signedIn],
  );

  const refreshSession = useCallback(async () => {
    const info = await fetchSession();
    setSession(info);
    if (info.signedIn) {
      const remote = await fetchRemoteProfile();
      const winner = reconcile(latestProfile.current, remote);
      if (winner) {
        setProfileState(winner);
        latestProfile.current = winner;
        saveLocal(winner);
        if (winner !== remote) void pushRemoteProfile(winner);
      }
      setSyncState('saved');
    }
  }, []);

  const signOut = useCallback(async () => {
    // Flush anything still queued before dropping the session, so the last
    // battle is not lost.
    if (pendingSync.current) clearTimeout(pendingSync.current);
    if (latestProfile.current && session.signedIn) {
      await pushRemoteProfile(latestProfile.current);
    }
    await fetch('/api/auth/signout', { method: 'POST' }).catch(() => {});
    setSession({ ...EMPTY_SESSION, accountsAvailable: session.accountsAvailable, googleAvailable: session.googleAvailable });
    setSyncState('local');
  }, [session.signedIn, session.accountsAvailable, session.googleAvailable]);

  // Best-effort flush when the tab goes away mid-battle.
  useEffect(() => {
    const flush = () => {
      if (!session.signedIn || !latestProfile.current) return;
      const body = JSON.stringify({ profile: latestProfile.current });
      navigator.sendBeacon?.('/api/profile', new Blob([body], { type: 'application/json' }));
    };
    document.addEventListener('visibilitychange', flush);
    return () => document.removeEventListener('visibilitychange', flush);
  }, [session.signedIn]);

  useEffect(() => () => {
    if (pendingSync.current) clearTimeout(pendingSync.current);
  }, []);

  const language: Language = profile?.settings.language ?? 'en';
  const soundOn = profile?.settings.sound ?? true;

  const value = useMemo<GameContextValue>(
    () => ({
      profile,
      loading,
      session,
      syncState,
      language,
      update,
      setProfile,
      refreshSession,
      signOut,
      cue: (c: Cue) => play(c, soundOn),
      tr: (key: StringKey) => t(key, language),
    }),
    [profile, loading, session, syncState, language, soundOn, update, setProfile, refreshSession, signOut],
  );

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export function useGame(): GameContextValue {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error('useGame must be used inside <GameProvider>');
  return ctx;
}
