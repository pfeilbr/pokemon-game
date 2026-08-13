import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, screen } from '@testing-library/react-native';
import type { ReactElement, ReactNode } from 'react';
import { Text } from 'react-native';
import { type Profile, createProfile } from '../engine';
import { GameProvider, useGame } from '../game/GameContext';
import { STORAGE_KEY } from '../storage';

/**
 * How a screen is mounted in a test.
 *
 * Always inside the real `GameProvider`, never a stub of it: the provider owns
 * the language, the save and the feedback cue, and a screen reading those from
 * a hand-written fake is not the screen that ships. The only substitutions are
 * the two native platform APIs, and those are made once in `setup.ts`.
 */
export async function renderScreen(ui: ReactElement) {
  return await render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => <GameProvider>{children}</GameProvider>,
  });
}

/**
 * Mounts a screen the way `App.tsx` does: a profile on the device, the provider
 * reading it back, and only then the screen, with that profile as a prop.
 *
 * Going through storage rather than handing the screen a literal is the point.
 * It means every screen test also crosses `normaliseProfile`, and it means a
 * screen cannot pass here while failing on the device because the provider had
 * not settled yet.
 */
export async function renderWithProfile(
  profile: Profile,
  screenFor: (profile: Profile) => ReactElement,
) {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  const result = await renderScreen(<Live screenFor={screenFor} />);
  await screen.findByTestId('live');
  return result;
}

function Live({ screenFor }: { screenFor: (profile: Profile) => ReactElement }) {
  const { profile, loading } = useGame();
  if (loading || !profile) return null;
  return (
    <>
      <Text testID="live" />
      {screenFor(profile)}
    </>
  );
}

/** A trainer part-way through the game, for the screens that need one. */
export function trainer(overrides: Partial<Profile> = {}): Profile {
  return {
    ...createProfile({ trainerName: 'Leo', starterId: 'cindik' }),
    ...overrides,
  };
}

/**
 * A window onto the provider's own state, for the one test that has to assert
 * on what a screen *did* rather than what it drew: sign-up creates a profile
 * that appears nowhere on the screen that created it.
 */
export function ProfileProbe() {
  const { profile } = useGame();
  return (
    <Text testID="probe-profile">
      {profile ? `${profile.trainerName}/${profile.starterId}` : ''}
    </Text>
  );
}
