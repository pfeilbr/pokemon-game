import { fireEvent, screen } from '@testing-library/react-native';
import { describe, expect, it } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { normaliseProfile, starters } from '../engine';
import { STORAGE_KEY } from '../storage';
import { ProfileProbe, renderScreen } from '../test/harness';
import { Onboarding } from './Onboarding';

/**
 * Sign-up, mounted for real.
 *
 * This is the one screen with no way back: a child who cannot get through it
 * cannot play at all, and it is also the only screen the CI simulator job sees,
 * so everything behind it needs its own cover. What is asserted here is what a
 * child would notice - the twelve starters being on the screen, the button
 * refusing a one-letter name - and then the thing none of that proves on its
 * own: that pressing through actually leaves a saved profile behind.
 */

async function reachPartnerStep(name = 'Leo') {
  await renderScreen(
    <>
      <Onboarding />
      <ProfileProbe />
    </>,
  );
  await screen.findByTestId('trainer-name');
  await fireEvent.changeText(screen.getByTestId('trainer-name'), name);
  await fireEvent.press(screen.getByTestId('to-partner'));
}

describe('sign-up', () => {
  it('opens on the name step', async () => {
    await renderScreen(<Onboarding />);

    expect(await screen.findByText('Mathmon Battle League')).toBeOnTheScreen();
    expect(screen.getByTestId('trainer-name')).toBeOnTheScreen();
  });

  it('will not move on until the name is long enough', async () => {
    await renderScreen(<Onboarding />);
    await screen.findByTestId('trainer-name');

    expect(screen.getByTestId('to-partner')).toBeDisabled();

    await fireEvent.changeText(screen.getByTestId('trainer-name'), 'L');
    expect(screen.getByTestId('to-partner')).toBeDisabled();

    await fireEvent.changeText(screen.getByTestId('trainer-name'), 'Leo');
    expect(screen.getByTestId('to-partner')).toBeEnabled();
  });

  it('offers every starter, one per evolution line', async () => {
    await reachPartnerStep();

    const cells = screen.getAllByTestId(/^starter-/);

    expect(cells).toHaveLength(starters().length);
    expect(cells).toHaveLength(12);
    for (const creature of starters()) {
      expect(screen.getByTestId(`starter-${creature.id}`)).toBeOnTheScreen();
      expect(screen.getByText(creature.name.en)).toBeOnTheScreen();
    }
  });

  it('holds the adventure button shut until a partner is picked', async () => {
    await reachPartnerStep();

    expect(screen.getByTestId('start-adventure')).toBeDisabled();

    await fireEvent.press(screen.getByTestId('starter-cindik'));
    expect(screen.getByTestId('start-adventure')).toBeEnabled();
  });

  it('creates and saves a profile when a child plays it through', async () => {
    await reachPartnerStep('  Leo  ');
    await fireEvent.press(screen.getByTestId('starter-cindik'));
    await fireEvent.press(screen.getByTestId('start-adventure'));

    // In memory: the provider now has a profile, which is what the router
    // switches on to leave sign-up behind.
    expect(screen.getByTestId('probe-profile')).toHaveTextContent('Leo/cindik');

    // On the device: the same profile, through the real storage layer.
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    expect(raw, 'nothing was written to storage').not.toBeNull();

    // Through the real repair pass, because that is what the app reads back.
    const saved = normaliseProfile(JSON.parse(raw ?? 'null'));
    expect(saved, 'the save did not survive normalisation').not.toBeNull();
    expect(saved?.trainerName).toBe('Leo');
    expect(saved?.starterId).toBe('cindik');
    expect(saved?.caught).toContain('cindik');
  });

  it('goes back to the name step without losing the name', async () => {
    await reachPartnerStep('Mira');

    await fireEvent.press(screen.getByText('Back'));

    expect(screen.getByTestId('trainer-name')).toHaveDisplayValue('Mira');
  });
});
