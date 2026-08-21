import * as Haptics from 'expo-haptics';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';
import {
  type AuthFailure,
  type SessionInfo,
  fetchRemoteSave,
  fetchSession,
  pushRemoteProfile,
  signInWithPin,
  signOut as signOutRemote,
} from '../api';
import { type Language, type Profile, type StringKey, t } from '../engine';
import { clearProfile, loadProfile, saveProfile } from '../storage';
import { type AppPhase, applyRemoteSave, planRefresh } from './refresh';

/**
 * Game state for the whole app.
 *
 * Mirrors the web client's `GameProvider`: it owns the profile, persists every
 * change, and hands down a translator. It deliberately owns no game rules -
 * those all live in the shared engine.
 *
 * Where the web client plays synthesised audio, this one taps the Taptic
 * Engine. On a phone held in one hand that reads better than sound, and it
 * needs no audio assets, which keeps the "no bundled media" property intact.
 *
 * Signing in is an upgrade, never a gate. The device save is always the source
 * the game plays from, so a flat network, a flight, or no account at all costs
 * a child nothing; an account only mirrors that save so it follows him to
 * another device. That is the same shape as the web client, deliberately.
 */

export type Feedback = 'tap' | 'correct' | 'wrong' | 'win' | 'lose';

export type SyncState = 'local' | 'saving' | 'saved' | 'error';

type GameValue = {
  profile: Profile | null;
  /** True until the first read from storage settles. */
  loading: boolean;
  language: Language;
  session: SessionInfo | null;
  syncState: SyncState;
  update: (fn: (profile: Profile) => Profile) => void;
  setProfile: (profile: Profile | null) => void;
  signIn: (
    name: string,
    pin: string,
    mode: 'login' | 'register',
  ) => Promise<{ ok: true } | { ok: false; reason: AuthFailure }>;
  signOut: () => Promise<void>;
  feedback: (kind: Feedback) => void;
  tr: (key: StringKey) => string;
};

const GameContext = createContext<GameValue | null>(null);

/** How long to wait after the last change before mirroring it to the server. */
const SYNC_DEBOUNCE_MS = 1200;

export function GameProvider({ children }: { children: ReactNode }) {
  const [profile, setProfileState] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [syncState, setSyncState] = useState<SyncState>('local');

  const pendingSync = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<Profile | null>(null);
  const signedIn = useRef(false);
  /** When the server last answered, so a foreground can decide it is too soon. */
  const lastPullAt = useRef<number | null>(null);

  /**
   * Writes to the device first, then schedules the server.
   *
   * Order matters: the device save is what the game plays from, so it must
   * never wait on a network. The push is debounced because a battle updates the
   * profile several times in a few seconds and each push is a round trip on a
   * phone's connection.
   */
  const persist = useCallback((next: Profile) => {
    latest.current = next;
    void saveProfile(next);

    if (!signedIn.current) {
      setSyncState('local');
      return;
    }

    setSyncState('saving');
    if (pendingSync.current) clearTimeout(pendingSync.current);
    pendingSync.current = setTimeout(() => {
      // Cleared as the timer fires, not only when it is replaced: `planRefresh`
      // reads this handle to answer "is this device still holding changes the
      // server has not heard?", and a stale handle would answer yes forever.
      pendingSync.current = null;
      const toPush = latest.current;
      if (!toPush) return;
      void pushRemoteProfile(toPush).then((ok) => setSyncState(ok ? 'saved' : 'error'));
    }, SYNC_DEBOUNCE_MS);
  }, []);

  /**
   * Reads the server and folds it into the device save.
   *
   * The deciding is not done here: `applyRemoteSave` asks the shared
   * `reconcile` and hands back what changed, so this function only carries out
   * the answer. Note what it does *not* do - it writes the device through
   * `saveProfile` rather than through `persist`, so a pull cannot arm the
   * debounced push. That is the loop guard; the only push a pull can cause is
   * the explicit one below, and only when the server is genuinely behind.
   *
   * A miss returns before touching anything at all, including `syncState`. On a
   * flat network the child sees exactly what he saw a moment ago.
   */
  const pull = useCallback(async () => {
    const remote = await fetchRemoteSave();
    const answered = remote.kind !== 'unavailable';
    // The interval only restarts when the server actually answered. A miss must
    // not buy itself a minute of not trying again.
    if (answered) lastPullAt.current = Date.now();

    const outcome = applyRemoteSave(latest.current, remote);
    if (!outcome.profile) return;

    if (outcome.writeDevice) {
      setProfileState(outcome.profile);
      latest.current = outcome.profile;
      void saveProfile(outcome.profile);
    }
    // If the device was ahead, the server is the one that needs catching up.
    if (outcome.pushBack) void pushRemoteProfile(outcome.profile);
    if (answered) setSyncState('saved');
  }, []);

  // Read the device save first and start playing; ask the server afterwards.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const saved = await loadProfile();
      if (cancelled) return;
      if (saved) {
        setProfileState(saved);
        latest.current = saved;
      }
      setLoading(false);

      const status = await fetchSession();
      if (cancelled || status.kind !== 'reachable') return;
      setSession(status.session);
      signedIn.current = status.session.signedIn;
      if (status.session.signedIn) await pull();
    })();

    return () => {
      cancelled = true;
    };
  }, [pull]);

  /**
   * Coming back to the app reads the server again.
   *
   * Without this the server is read on launch and on sign-in and never again,
   * and a React Native app is one process that can live for weeks - so a child
   * who played on the laptop and then picked up a long-backgrounded iPad saw
   * the album as it stood that morning, with no way out but force-quitting.
   *
   * Every decision about whether to ask is in `planRefresh`, which is pure and
   * tested without a renderer. This handler owns only the two things it alone
   * knows: which phase the app was in a moment ago, and what the clock says.
   */
  useEffect(() => {
    // The provider mounts while the app is on screen, and launch has just read
    // the server, so the first phase worth reacting to is a *return*.
    let phase: AppPhase = 'active';

    const subscription = AppState.addEventListener('change', (next) => {
      const previous = phase;
      phase = next;
      const plan = planRefresh({
        previous,
        next,
        signedIn: signedIn.current,
        lastPullAt: lastPullAt.current,
        now: Date.now(),
        pushQueued: pendingSync.current !== null,
      });
      if (plan.pull) void pull();
    });

    return () => subscription.remove();
  }, [pull]);

  useEffect(
    () => () => {
      if (pendingSync.current) clearTimeout(pendingSync.current);
    },
    [],
  );

  const setProfile = useCallback(
    (next: Profile | null) => {
      setProfileState(next);
      if (next) {
        persist(next);
      } else {
        latest.current = null;
        setSyncState('local');
        void clearProfile();
      }
    },
    [persist],
  );

  const update = useCallback(
    (fn: (current: Profile) => Profile) => {
      setProfileState((current) => {
        if (!current) return current;
        const next = fn(current);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const signIn = useCallback(
    async (
      name: string,
      pin: string,
      mode: 'login' | 'register',
    ): Promise<{ ok: true } | { ok: false; reason: AuthFailure }> => {
      const result = await signInWithPin(name, pin, mode);
      if (!result.ok) return result;

      signedIn.current = true;
      const status = await fetchSession();
      if (status.kind === 'reachable') setSession(status.session);
      await pull();
      return { ok: true };
    },
    [pull],
  );

  const signOut = useCallback(async () => {
    // Flush anything still queued before dropping the session, so the last
    // battle is not lost between the phone and the account.
    if (pendingSync.current) clearTimeout(pendingSync.current);
    if (signedIn.current && latest.current) await pushRemoteProfile(latest.current);

    await signOutRemote();
    signedIn.current = false;
    setSyncState('local');

    const status = await fetchSession();
    if (status.kind === 'reachable') setSession(status.session);
  }, []);

  const soundOn = profile?.settings.sound ?? true;

  const feedback = useCallback(
    (kind: Feedback) => {
      // `sound` doubles as the master feedback switch on this client; a child
      // who turned sound off does not want the phone buzzing either.
      if (!soundOn) return;
      switch (kind) {
        case 'tap':
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          break;
        case 'correct':
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          break;
        case 'wrong':
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          break;
        case 'win':
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          break;
        case 'lose':
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
          break;
      }
    },
    [soundOn],
  );

  const language: Language = profile?.settings.language ?? 'en';

  const value = useMemo<GameValue>(
    () => ({
      profile,
      loading,
      language,
      session,
      syncState,
      update,
      setProfile,
      signIn,
      signOut,
      feedback,
      tr: (key: StringKey) => t(key, language),
    }),
    [profile, loading, language, session, syncState, update, setProfile, signIn, signOut, feedback],
  );

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export function useGame(): GameValue {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error('useGame must be used inside <GameProvider>');
  return ctx;
}
