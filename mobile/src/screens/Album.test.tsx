import { fireEvent, screen } from '@testing-library/react-native';
import { describe, expect, it, vi } from 'vitest';
import { CREATURES, ELEMENTS, ELEMENT_STYLE, getCreature } from '../engine';
import { renderWithProfile, trainer } from '../test/harness';
import { Album } from './Album';

/**
 * The album, mounted for real.
 *
 * `Album.test.ts` proves `groupByElement` accounts for every creature. This
 * proves the screen actually draws what that function returns - which used to
 * be checked by reading the screen's own source for the function's name, a
 * test that could not tell a rendered grouping from a mentioned one.
 */

const chip = (element: (typeof ELEMENTS)[number]) =>
  `${ELEMENT_STYLE[element].icon} ${ELEMENT_STYLE[element].label.en}`;

describe('the album', () => {
  it('draws one section per element, in wheel order', async () => {
    await renderWithProfile(trainer(), (p) => <Album profile={p} onBack={() => {}} />);

    // One header chip per element, and nothing else on the screen wears one
    // until a creature is selected.
    for (const element of ELEMENTS) {
      expect(screen.getAllByText(chip(element)), `${element} has no header`).toHaveLength(1);
    }

    // The album total plus one count per section.
    expect(screen.getAllByText(/^\d+ \/ \d+$/)).toHaveLength(ELEMENTS.length + 1);
  });

  it('shows the whole roster, caught or not', async () => {
    await renderWithProfile(trainer(), (p) => <Album profile={p} onBack={() => {}} />);

    expect(screen.getAllByTestId(/^album-/)).toHaveLength(CREATURES.length);
    for (const creature of CREATURES) {
      expect(
        screen.getByTestId(`album-${creature.id}`),
        `${creature.id} is missing`,
      ).toBeOnTheScreen();
    }
  });

  it('names what has been caught and silhouettes what has not', async () => {
    await renderWithProfile(trainer({ caught: ['cindik'] }), (p) => (
      <Album profile={p} onBack={() => {}} />
    ));

    expect(screen.getByText(getCreature('cindik').name.en)).toBeOnTheScreen();
    // Knowing what is missing is most of why a child keeps playing, so the
    // gaps are drawn rather than hidden.
    expect(screen.getAllByText('???')).toHaveLength(CREATURES.length - 1);
    expect(screen.getByText(`1 / ${CREATURES.length}`)).toBeOnTheScreen();
  });

  it('opens a creature when its cell is tapped, and closes it again', async () => {
    await renderWithProfile(trainer({ caught: ['cindik'] }), (p) => (
      <Album profile={p} onBack={() => {}} />
    ));

    await fireEvent.press(screen.getByTestId('album-cindik'));

    expect(screen.getByText(getCreature('cindik').flavor.en)).toBeOnTheScreen();
    expect(screen.getByText('Stage 1')).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('album-cindik'));
    expect(screen.queryByText(getCreature('cindik').flavor.en)).toBeNull();
  });

  it('will not spoil a creature that has not been caught', async () => {
    await renderWithProfile(trainer({ caught: [] }), (p) => (
      <Album profile={p} onBack={() => {}} />
    ));

    await fireEvent.press(screen.getByTestId('album-thornmoss'));

    expect(screen.getByText('Not caught yet')).toBeOnTheScreen();
    expect(screen.queryByText(getCreature('thornmoss').name.en)).toBeNull();
  });

  it('goes back home', async () => {
    const onBack = vi.fn();
    await renderWithProfile(trainer(), (p) => <Album profile={p} onBack={onBack} />);

    await fireEvent.press(screen.getByText('← Home'));

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
