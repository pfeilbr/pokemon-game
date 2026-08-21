import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { CrashBoundary } from './src/CrashBoundary';
import { GameProvider, useGame } from './src/game/GameContext';
import { Album } from './src/screens/Album';
import { BattleScreen } from './src/screens/BattleScreen';
import { Home } from './src/screens/Home';
import { Onboarding } from './src/screens/Onboarding';
import { PickOpponent } from './src/screens/PickOpponent';
import { ProgressScreen } from './src/screens/ProgressScreen';
import { SignIn } from './src/screens/SignIn';
import { Settings } from './src/screens/Settings';
import { findCreature } from './src/engine';
import { readCaptureScreen } from './src/storage';
import { colors } from './src/theme';

/**
 * The app root and its router.
 *
 * A hand-rolled screen switch rather than React Navigation. There are eight
 * screens, no deep links, no tabs, and no back stack worth preserving - the
 * game's own "back" buttons are the navigation. A navigation library would add
 * two more native modules and a prebuild surface to the iOS build for a `switch`
 * statement's worth of behaviour.
 */

type Screen =
  | { name: 'home' }
  | { name: 'pick' }
  | { name: 'battle'; opponentId: string }
  | { name: 'album' }
  | { name: 'progress' }
  | { name: 'settings' }
  | { name: 'signin' };

function Router({ screen, setScreen }: { screen: Screen; setScreen: (screen: Screen) => void }) {
  const { profile, loading } = useGame();

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.gold} size="large" />
      </View>
    );
  }

  // No save yet: sign-up is the whole app until there is one.
  if (!profile) return <Onboarding />;

  const home = () => setScreen({ name: 'home' });

  switch (screen.name) {
    case 'pick':
      return (
        <PickOpponent
          profile={profile}
          onChoose={(opponentId) => setScreen({ name: 'battle', opponentId })}
          onBack={home}
        />
      );

    case 'battle':
      return (
        <BattleScreen
          // Remounts for a rematch, so each fight starts from a clean reducer.
          key={`${screen.opponentId}:${profile.battlesWon + profile.battlesLost}`}
          profile={profile}
          opponentId={screen.opponentId}
          onExit={() => setScreen({ name: 'pick' })}
          onHome={home}
        />
      );

    case 'album':
      return <Album profile={profile} onBack={home} />;

    case 'progress':
      return <ProgressScreen profile={profile} onBack={home} />;

    case 'settings':
      return (
        <Settings profile={profile} onBack={home} onSignIn={() => setScreen({ name: 'signin' })} />
      );

    case 'signin':
      return <SignIn onDone={() => setScreen({ name: 'settings' })} />;

    default:
      return (
        <Home
          profile={profile}
          onBattle={() => setScreen({ name: 'pick' })}
          onAlbum={() => setScreen({ name: 'album' })}
          onProgress={() => setScreen({ name: 'progress' })}
          onSettings={() => setScreen({ name: 'settings' })}
        />
      );
  }
}

/**
 * Where the crash boundary sits, and why it sits there.
 *
 * Everything that can throw a game error is inside it: `GameProvider`, which
 * reads and reconciles the save, and every screen, which render engine values.
 * Only the safe-area layout and the status bar are outside, so the recovery
 * screen still gets its insets and does not draw under the notch - and those
 * two know nothing about the game, which is what makes them safe company.
 *
 * The current screen is held *here*, above the boundary, so that "try again"
 * and "home" stay two different offers on a client with no URL: a retry
 * remounts the subtree on the screen that crashed, while home resets the screen
 * first. That mirrors the web, where `reset()` re-renders the crashed route and
 * the Home link navigates away from it.
 */
/**
 * The screen `mobile/scripts/capture_screens.sh` asked for, by name.
 *
 * `simctl` can launch and screenshot but cannot tap, so the harness needs one
 * way to say which screen to photograph. It writes `SCREEN_KEY` into the app's
 * own storage alongside the seeded save, and this turns that name into a
 * screen, optionally with an opponent (`battle:vinari`) because the battle
 * screen is the one worth photographing most and cannot be reached without
 * one. The opponent is checked against the real roster, so the only thing this
 * can carry is a creature that already exists - never a profile, never a score.
 *
 * This replaced a `mathmon://screen/<name>` deep link. The link could not work:
 * iOS confirms a custom-scheme open with a dialog and waits for a tap, so two
 * CI runs photographed "Open in Mathmon?" instead of the game. A key the app
 * only reads is also the smaller hook - a URL is reachable by anything on the
 * device, this is not.
 *
 * Exported and pure, so it is tested without a renderer.
 */
export function screenFromName(name: string | null): Screen | null {
  if (name === null) return null;

  const [screen, opponentId] = name.split(':');
  if (screen === 'battle') {
    // An id the roster does not have would throw inside `getCreature` and land
    // the child on the crash screen, so it is refused here instead.
    return opponentId && findCreature(opponentId) ? { name: 'battle', opponentId } : null;
  }

  switch (screen) {
    case 'home':
      return { name: 'home' };
    case 'pick':
      return { name: 'pick' };
    case 'album':
      return { name: 'album' };
    case 'progress':
      return { name: 'progress' };
    case 'settings':
      return { name: 'settings' };
    case 'signin':
      return { name: 'signin' };
    default:
      return null;
  }
}

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const goHome = useCallback(() => setScreen({ name: 'home' }), []);

  // Lives here rather than in Router, which has early returns above the point a
  // hook could sit, and which does not own `screen`.
  useEffect(() => {
    void readCaptureScreen().then((name) => {
      const next = screenFromName(name);
      if (next) setScreen(next);
    });
  }, []);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
        <StatusBar style="light" />
        <CrashBoundary onGoHome={goHome}>
          <GameProvider>
            <Router screen={screen} setScreen={setScreen} />
          </GameProvider>
        </CrashBoundary>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
