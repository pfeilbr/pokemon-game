import { fireEvent, screen } from '@testing-library/react-native';
import { describe, expect, it, vi } from 'vitest';
import { normaliseProfile } from '../engine';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORAGE_KEY } from '../storage';
import { renderWithProfile, trainer } from '../test/harness';
import { Settings } from './Settings';

/**
 * Settings, mounted for real.
 *
 * `Settings.test.ts` proves the two transitions change one field of the save
 * and nothing else. What it cannot see is whether pressing 中文 reaches them,
 * or whether the screen redraws in the language it just chose - which is the
 * entire point of the feature for a bilingual child.
 */

async function saved() {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  return normaliseProfile(JSON.parse(raw ?? 'null'));
}

describe('settings', () => {
  it('opens in the language the profile was created with', async () => {
    await renderWithProfile(trainer(), (p) => <Settings profile={p} onBack={() => {}} />);

    expect(screen.getByText('Settings')).toBeOnTheScreen();
    expect(screen.getByText('Language')).toBeOnTheScreen();
    expect(screen.getByTestId('lang-en')).toBeOnTheScreen();
    expect(screen.getByTestId('lang-zh')).toBeOnTheScreen();
  });

  it('redraws itself in Chinese the moment 中文 is chosen', async () => {
    await renderWithProfile(trainer(), (p) => <Settings profile={p} onBack={() => {}} />);

    await fireEvent.press(screen.getByTestId('lang-zh'));

    expect(screen.getByText('设置')).toBeOnTheScreen();
    expect(screen.getByText('语言')).toBeOnTheScreen();
    expect(screen.queryByText('Settings')).toBeNull();
    expect((await saved())?.settings.language).toBe('zh');
  });

  it('switches back to English again', async () => {
    await renderWithProfile(trainer({ settings: { language: 'zh', sound: true } }), (p) => (
      <Settings profile={p} onBack={() => {}} />
    ));

    expect(screen.getByText('设置')).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('lang-en'));

    expect(screen.getByText('Settings')).toBeOnTheScreen();
    expect((await saved())?.settings.language).toBe('en');
  });

  it('flips the sound switch, and says which way it is', async () => {
    await renderWithProfile(trainer(), (p) => <Settings profile={p} onBack={() => {}} />);

    expect(screen.getByTestId('toggle-sound')).toHaveTextContent('On');

    await fireEvent.press(screen.getByTestId('toggle-sound'));

    expect(screen.getByTestId('toggle-sound')).toHaveTextContent('Off');
    expect((await saved())?.settings.sound).toBe(false);
  });

  it('shows whose save this is', async () => {
    await renderWithProfile(trainer(), (p) => <Settings profile={p} onBack={() => {}} />);

    expect(screen.getByText('Leo')).toBeOnTheScreen();
    expect(screen.getByText('Saving on this device')).toBeOnTheScreen();
  });

  it('goes back home', async () => {
    const onBack = vi.fn();
    await renderWithProfile(trainer(), (p) => <Settings profile={p} onBack={onBack} />);

    await fireEvent.press(screen.getByText('← Home'));

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
