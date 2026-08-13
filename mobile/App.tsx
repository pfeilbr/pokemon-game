import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { GameProvider, useGame } from './src/game/GameContext';
import { Album } from './src/screens/Album';
import { BattleScreen } from './src/screens/BattleScreen';
import { Home } from './src/screens/Home';
import { Onboarding } from './src/screens/Onboarding';
import { PickOpponent } from './src/screens/PickOpponent';
import { ProgressScreen } from './src/screens/ProgressScreen';
import { Settings } from './src/screens/Settings';
import { colors } from './src/theme';

/**
 * The app root and its router.
 *
 * A hand-rolled screen switch rather than React Navigation. There are seven
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
  | { name: 'settings' };

function Router() {
  const { profile, loading } = useGame();
  const [screen, setScreen] = useState<Screen>({ name: 'home' });

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
      return <Settings profile={profile} onBack={home} />;

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

export default function App() {
  return (
    <SafeAreaProvider>
      <GameProvider>
        <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
          <StatusBar style="light" />
          <Router />
        </SafeAreaView>
      </GameProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
