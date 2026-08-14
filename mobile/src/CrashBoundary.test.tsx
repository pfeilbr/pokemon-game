import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Text } from 'react-native';
import { createProfile, getCreature, t } from './engine';
import { CrashBoundary } from './CrashBoundary';
import { STORAGE_KEY } from './storage';

/**
 * The crash boundary, driven by a real crash.
 *
 * The fault is deliberately an honest one rather than `throw new Error('boom')`.
 * `getCreature` throws on an unknown id *by design* - CLAUDE.md says the engine
 * throws on invalid data and repairs it at the boundary - so a save that
 * survived a schema change with a creature id nobody ships any more is the
 * shape a real crash takes on this client. A synthetic throw would prove the
 * React plumbing and nothing about the game.
 *
 * What is being asserted is not "an error was caught". It is the promise the
 * screen makes to a seven-year-old: that a crash never costs him his album.
 * Every path through this file checks the save is still on the device
 * afterwards, including the one where a retry has already failed.
 */

/** A screen that renders a creature the roster does not have. */
function Doomed() {
  return <Text>{getCreature('no-such-creature').name.en}</Text>;
}

function saved(language: 'en' | 'zh' = 'en') {
  const profile = createProfile({ trainerName: 'Leo', starterId: 'cindik' });
  return { ...profile, settings: { ...profile.settings, language } };
}

/**
 * React writes the caught error and its component stack to the console itself,
 * on top of the boundary's own log line. Silenced so a *passing* run is quiet
 * and a real unexpected error still stands out.
 */
let noise: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  noise = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  noise.mockRestore();
});

describe('the iOS crash boundary', () => {
  it('catches an engine throw and offers a way out instead of a blank screen', async () => {
    const profile = saved();
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(profile));

    await render(
      <CrashBoundary>
        <Doomed />
      </CrashBoundary>,
    );

    expect(screen.getByTestId('crash-recovery')).toBeOnTheScreen();
    expect(screen.getByText(t('crashTitle', 'en'))).toBeOnTheScreen();
    // The reassurance, not the stack trace, is what he reads.
    expect(screen.getByText(t('crashBody', 'en'))).toBeOnTheScreen();
    expect(screen.getByTestId('crash-try-again')).toBeOnTheScreen();
    expect(screen.getByTestId('crash-go-home')).toBeOnTheScreen();

    // The save is the whole point: catching the crash must not cost him it.
    expect(await AsyncStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(profile));
  });

  it('never shows the destructive option on the first crash', async () => {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(saved()));

    await render(
      <CrashBoundary>
        <Doomed />
      </CrashBoundary>,
    );

    expect(screen.queryByTestId('crash-still-stuck')).toBeNull();
    expect(screen.queryByTestId('crash-erase-confirmed')).toBeNull();
  });

  it('retries in place, and brings the game back when the fault has passed', async () => {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(saved()));

    let broken = true;
    function Flaky() {
      if (broken) return <Text>{getCreature('no-such-creature').name.en}</Text>;
      return <Text testID="recovered">{getCreature('cindik').name.en}</Text>;
    }

    await render(
      <CrashBoundary>
        <Flaky />
      </CrashBoundary>,
    );
    expect(screen.getByTestId('crash-recovery')).toBeOnTheScreen();

    broken = false;
    await fireEvent.press(screen.getByTestId('crash-try-again'));

    expect(screen.getByTestId('recovered')).toBeOnTheScreen();
    expect(screen.queryByTestId('crash-recovery')).toBeNull();
  });

  it('keeps the save through a retry that fails, and only then admits defeat', async () => {
    const profile = saved();
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(profile));

    await render(
      <CrashBoundary>
        <Doomed />
      </CrashBoundary>,
    );

    await fireEvent.press(screen.getByTestId('crash-try-again'));

    // Still broken - and this is the first moment the erase offer may appear.
    expect(screen.getByTestId('crash-recovery')).toBeOnTheScreen();
    expect(screen.getByTestId('crash-still-stuck')).toBeOnTheScreen();
    // A failed retry is not permission to delete anything.
    expect(await AsyncStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(profile));
  });

  it('puts two more taps and a named cost in front of erasing the album', async () => {
    const profile = saved();
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(profile));

    await render(
      <CrashBoundary>
        <Doomed />
      </CrashBoundary>,
    );
    await fireEvent.press(screen.getByTestId('crash-try-again'));

    // Tap one: the disclosure. Still nothing destroyed, and the warning has to
    // say what it costs rather than just asking "are you sure?".
    await fireEvent.press(screen.getByTestId('crash-still-stuck'));
    expect(screen.getByText(t('eraseSaveWarning', 'en'))).toBeOnTheScreen();
    expect(await AsyncStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(profile));

    // Backing out is a real exit, not a decoration.
    await fireEvent.press(screen.getByTestId('crash-erase-cancel'));
    expect(screen.queryByText(t('eraseSaveWarning', 'en'))).toBeNull();
    expect(await AsyncStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(profile));

    // Tap two, deliberately: only this clears the device.
    await fireEvent.press(screen.getByTestId('crash-still-stuck'));
    await fireEvent.press(screen.getByTestId('crash-erase-confirmed'));
    await waitFor(async () => expect(await AsyncStorage.getItem(STORAGE_KEY)).toBeNull());
  });

  it('speaks the language the save is written in', async () => {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(saved('zh')));

    await render(
      <CrashBoundary>
        <Doomed />
      </CrashBoundary>,
    );

    expect(await screen.findByText(t('crashTitle', 'zh'))).toBeOnTheScreen();
    expect(screen.queryByText(t('crashTitle', 'en'))).toBeNull();
  });

  it('falls back to English rather than crashing again on an unreadable save', async () => {
    await AsyncStorage.setItem(STORAGE_KEY, '{not json at all');

    await render(
      <CrashBoundary>
        <Doomed />
      </CrashBoundary>,
    );

    expect(screen.getByText(t('crashTitle', 'en'))).toBeOnTheScreen();
    // A save it cannot parse is not a save it may throw away.
    expect(await AsyncStorage.getItem(STORAGE_KEY)).toBe('{not json at all');
  });

  it('sends the router home, so a crashed screen can never trap him on it', async () => {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(saved()));
    const onGoHome = vi.fn();

    await render(
      <CrashBoundary onGoHome={onGoHome}>
        <Doomed />
      </CrashBoundary>,
    );

    await fireEvent.press(screen.getByTestId('crash-go-home'));
    expect(onGoHome).toHaveBeenCalledTimes(1);
  });

  it('stays out of the way when nothing is wrong', async () => {
    await render(
      <CrashBoundary>
        <Text testID="fine">{getCreature('cindik').name.en}</Text>
      </CrashBoundary>,
    );

    expect(screen.getByTestId('fine')).toBeOnTheScreen();
    expect(screen.queryByTestId('crash-recovery')).toBeNull();
  });
});
