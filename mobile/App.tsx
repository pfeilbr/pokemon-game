import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, View } from 'react-native';
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
 * `mathmon://screen/album`, `mathmon://screen/battle?opponent=vinari`.
 *
 * A deep link selects a screen and can do nothing else. It deliberately cannot
 * carry state: `simctl` can open a URL but cannot tap, so this is how
 * `mobile/scripts/capture_screens.sh` walks the app through its screens for
 * `mobile/docs/screens/` - but a link that could write the save would be a hole
 * in a child's album for the life of the app, to save the harness twenty lines.
 * The seeded save the harness needs goes in through the filesystem instead.
 *
 * Exported and pure, so it is tested without a renderer.
 */
const SCREEN_LINK = /^[a-z][a-z0-9+.-]*:\/\/screen\/([a-z]+)(?:\?opponent=([a-z-]+))?$/;

export function screenFromUrl(url: string | null): Screen | null {
  if (!url) return null;
  const match = SCREEN_LINK.exec(url);
  if (!match) return null;
  const [, name, opponentId] = match;
  switch (name) {
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
    // A battle needs an opponent; a link without one navigates nowhere rather
    // than starting an arbitrary fight.
    case 'battle':
      return opponentId ? { name: 'battle', opponentId } : null;
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
    const open = (url: string | null) => {
      const next = screenFromUrl(url);
      if (next) setScreen(next);
    };
    void Linking.getInitialURL().then(open);
    const subscription = Linking.addEventListener('url', (event) => open(event.url));
    return () => subscription.remove();
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
