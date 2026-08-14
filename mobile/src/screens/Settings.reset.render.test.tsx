import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { describe, expect, it, vi } from 'vitest';
import { STORAGE_KEY } from '../storage';
import { renderWithProfile, trainer } from '../test/harness';
import { Settings } from './Settings';

/**
 * Start over, mounted for real.
 *
 * `Settings.reset.test.ts` proves the gate only opens on one sequence of
 * presses. What it cannot see is whether the buttons on the screen are wired to
 * that gate at all - a destructive control that skips the confirmation would
 * pass every pure test in this repository and still lose a child's album on the
 * first curious tap.
 *
 * So this file presses what a thumb presses, and reads the save back out of
 * AsyncStorage through the real `storage.ts` afterwards.
 */

const saved = () => AsyncStorage.getItem(STORAGE_KEY);

function mount(onBack: () => void = () => {}) {
  return renderWithProfile(trainer(), (p) => (
    <Settings profile={p} onBack={onBack} onSignIn={() => {}} />
  ));
}

describe('start over, on the screen', () => {
  it('offers no delete until it is asked for', async () => {
    await mount();

    expect(screen.getByTestId('start-over')).toBeOnTheScreen();
    expect(screen.queryByTestId('reset-confirm')).toBeNull();
  });

  it('names what it costs before it will do it', async () => {
    await mount();

    await fireEvent.press(screen.getByTestId('start-over'));

    expect(screen.getByText('Delete all progress? This cannot be undone.')).toBeOnTheScreen();
    expect(screen.getByTestId('reset-confirm')).toBeOnTheScreen();
    expect(screen.getByTestId('reset-cancel')).toBeOnTheScreen();
    // Asking is not doing.
    expect(await saved()).not.toBeNull();
  });

  it('leaves the save untouched when the confirmation is dismissed', async () => {
    await mount();
    const before = await saved();

    await fireEvent.press(screen.getByTestId('start-over'));
    await fireEvent.press(screen.getByTestId('reset-cancel'));

    expect(await saved()).toBe(before);
    // And the screen is back to its quiet state, one press from asking again.
    expect(screen.getByTestId('start-over')).toBeOnTheScreen();
    expect(screen.queryByTestId('reset-confirm')).toBeNull();
  });

  it('deletes the save only on the confirmed press, and hands the app to sign-up', async () => {
    const onBack = vi.fn();
    await mount(onBack);

    await fireEvent.press(screen.getByTestId('start-over'));
    expect(await saved()).not.toBeNull();

    await fireEvent.press(screen.getByTestId('reset-confirm'));

    await waitFor(async () => expect(await saved()).toBeNull());
    // With no profile the harness renders nothing, which is the same branch
    // `App.tsx` takes: no save means sign-up is the whole app. An empty
    // dashboard is the failure this asserts against.
    await waitFor(() => expect(screen.queryByTestId('live')).toBeNull());
    expect(onBack).toHaveBeenCalled();
  });

  it('speaks Chinese too, because the child it is for reads both', async () => {
    await renderWithProfile(trainer({ settings: { language: 'zh', sound: true } }), (p) => (
      <Settings profile={p} onBack={() => {}} onSignIn={() => {}} />
    ));

    expect(screen.getByText('重新开始')).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('start-over'));

    expect(screen.getByText('确定要删除所有进度吗？此操作无法撤销。')).toBeOnTheScreen();
    expect(screen.getByTestId('reset-confirm')).toHaveTextContent('删除');
    expect(screen.getByTestId('reset-cancel')).toHaveTextContent('返回');
  });
});
