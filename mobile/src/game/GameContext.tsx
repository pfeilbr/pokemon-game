import * as Haptics from 'expo-haptics';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { type Language, type Profile, type StringKey, t } from '../engine';
import { clearProfile, loadProfile, saveProfile } from '../storage';

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
 */

export type Feedback = 'tap' | 'correct' | 'wrong' | 'win' | 'lose';

type GameValue = {
  profile: Profile | null;
  /** True until the first read from storage settles. */
  loading: boolean;
  language: Language;
  update: (fn: (profile: Profile) => Profile) => void;
  setProfile: (profile: Profile | null) => void;
  feedback: (kind: Feedback) => void;
  tr: (key: StringKey) => string;
};

const GameContext = createContext<GameValue | null>(null);

export function GameProvider({ children }: { children: ReactNode }) {
  const [profile, setProfileState] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void loadProfile().then((saved) => {
      if (cancelled) return;
      if (saved) setProfileState(saved);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setProfile = useCallback((next: Profile | null) => {
    setProfileState(next);
    void (next ? saveProfile(next) : clearProfile());
  }, []);

  const update = useCallback((fn: (current: Profile) => Profile) => {
    setProfileState((current) => {
      if (!current) return current;
      const next = fn(current);
      void saveProfile(next);
      return next;
    });
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
      update,
      setProfile,
      feedback,
      tr: (key: StringKey) => t(key, language),
    }),
    [profile, loading, language, update, setProfile, feedback],
  );

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export function useGame(): GameValue {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error('useGame must be used inside <GameProvider>');
  return ctx;
}
