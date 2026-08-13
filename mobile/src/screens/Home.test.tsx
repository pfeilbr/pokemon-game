import { fireEvent, screen } from '@testing-library/react-native';
import { describe, expect, it, vi } from 'vitest';
import { getCreature, partnerFor } from '../engine';
import { renderWithProfile, trainer } from '../test/harness';
import { Home } from './Home';

/**
 * The dashboard, mounted for real.
 *
 * It is the hub: everything else in the game is behind one of its four
 * buttons, so a button that quietly stopped rendering would strand a child on
 * this screen with no error anywhere. The test therefore checks each one is
 * present *and* wired, which is two different failures.
 */

const noop = () => {};

function nav(overrides: Partial<Record<string, () => void>> = {}) {
  return {
    onBattle: noop,
    onAlbum: noop,
    onProgress: noop,
    onSettings: noop,
    ...overrides,
  };
}

describe('the dashboard', () => {
  it('greets the trainer and shows the partner it has', async () => {
    const profile = trainer();
    await renderWithProfile(profile, (p) => <Home profile={p} {...nav()} />);

    expect(screen.getByText(`Hello, ${profile.trainerName}`)).toBeOnTheScreen();
    expect(screen.getByText(getCreature(partnerFor(profile)).name.en)).toBeOnTheScreen();
    expect(screen.getByText('Mathmon Battle League')).toBeOnTheScreen();
  });

  it('shows the three progress numbers a child checks first', async () => {
    await renderWithProfile(trainer({ tier: 3, caught: ['cindik', 'flurro'] }), (p) => (
      <Home profile={p} {...nav()} />
    ));

    expect(screen.getByText('Maths level')).toBeOnTheScreen();
    expect(screen.getByText('3')).toBeOnTheScreen();
    expect(screen.getByText('Day streak')).toBeOnTheScreen();
    // Two of thirty-six.
    expect(screen.getByText('6%')).toBeOnTheScreen();
  });

  it('offers all four destinations', async () => {
    await renderWithProfile(trainer(), (p) => <Home profile={p} {...nav()} />);

    for (const id of ['go-battle', 'go-album', 'go-progress', 'go-settings']) {
      expect(screen.getByTestId(id)).toBeOnTheScreen();
    }
  });

  it('navigates from each of them', async () => {
    const handlers = {
      onBattle: vi.fn(),
      onAlbum: vi.fn(),
      onProgress: vi.fn(),
      onSettings: vi.fn(),
    };
    await renderWithProfile(trainer(), (p) => <Home profile={p} {...handlers} />);

    for (const [id, handler] of [
      ['go-battle', handlers.onBattle],
      ['go-album', handlers.onAlbum],
      ['go-progress', handlers.onProgress],
      ['go-settings', handlers.onSettings],
    ] as const) {
      await fireEvent.press(screen.getByTestId(id));
      expect(handler, `${id} did nothing`).toHaveBeenCalledTimes(1);
    }
  });

  it('names the level the partner evolves at', async () => {
    await renderWithProfile(trainer(), (p) => <Home profile={p} {...nav()} />);

    expect(screen.getByText(/Evolves at level \d+/)).toBeOnTheScreen();
  });
});
