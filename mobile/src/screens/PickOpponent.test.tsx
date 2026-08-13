import { fireEvent, screen } from '@testing-library/react-native';
import { describe, expect, it, vi } from 'vitest';
import { ELEMENTS, ELEMENT_STYLE, getCreature, partnerFor } from '../engine';
import { renderWithProfile, trainer } from '../test/harness';
import { PickOpponent } from './PickOpponent';

/**
 * Opponent choice, mounted for real.
 *
 * The counter-pick is the strategy layer of this game, and all of it lives on
 * this screen: three cards, a stated verdict on each, and the whole element
 * wheel one tap away. None of that is checkable without rendering - a verdict
 * computed correctly and then not drawn looks exactly like no verdict at all.
 */

const chip = (element: (typeof ELEMENTS)[number]) =>
  `${ELEMENT_STYLE[element].icon} ${ELEMENT_STYLE[element].label.en}`;

describe('choosing an opponent', () => {
  it('offers three opponents, none of them the partner', async () => {
    const profile = trainer();
    await renderWithProfile(profile, (p) => (
      <PickOpponent profile={p} onChoose={() => {}} onBack={() => {}} />
    ));

    const cards = screen.getAllByTestId(/^opponent-/);

    expect(cards).toHaveLength(3);
    expect(screen.queryByTestId(`opponent-${partnerFor(profile)}`)).toBeNull();
  });

  it('states a verdict on every card, so the matchup is readable before the fight', async () => {
    await renderWithProfile(trainer(), (p) => (
      <PickOpponent profile={p} onChoose={() => {}} onBack={() => {}} />
    ));

    const verdicts = screen.getAllByText(/^[▲▼=] (Good matchup|Tough matchup|Even matchup)$/);

    expect(verdicts).toHaveLength(3);
  });

  it('shows the partner it is picking against', async () => {
    const profile = trainer();
    await renderWithProfile(profile, (p) => (
      <PickOpponent profile={p} onChoose={() => {}} onBack={() => {}} />
    ));

    expect(screen.getByText('You')).toBeOnTheScreen();
    expect(screen.getByText(getCreature(partnerFor(profile)).name.en)).toBeOnTheScreen();
  });

  it('starts the fight against the opponent that was tapped', async () => {
    const onChoose = vi.fn();
    await renderWithProfile(trainer(), (p) => (
      <PickOpponent profile={p} onChoose={onChoose} onBack={() => {}} />
    ));

    // The card's own id is the contract with the router; a card that starts
    // somebody else's battle is the failure worth catching.
    const first = screen.getAllByTestId(/^opponent-/)[0];
    const id = String(first?.props.testID).replace('opponent-', '');

    await fireEvent.press(screen.getByTestId(`opponent-${id}`));

    expect(onChoose).toHaveBeenCalledWith(id);
  });

  it('keeps the whole element wheel one tap away', async () => {
    await renderWithProfile(trainer(), (p) => (
      <PickOpponent profile={p} onChoose={() => {}} onBack={() => {}} />
    ));

    const showing = () =>
      ELEMENTS.filter((element) => screen.queryAllByText(chip(element)).length > 0);

    // At most four elements are on screen unopened: the partner and three foes.
    expect(showing().length).toBeLessThan(ELEMENTS.length);

    await fireEvent.press(screen.getByTestId('toggle-type-chart'));
    expect(showing()).toEqual([...ELEMENTS]);

    await fireEvent.press(screen.getByTestId('toggle-type-chart'));
    expect(showing().length).toBeLessThan(ELEMENTS.length);
  });

  it('goes back home', async () => {
    const onBack = vi.fn();
    await renderWithProfile(trainer(), (p) => (
      <PickOpponent profile={p} onChoose={() => {}} onBack={onBack} />
    ));

    await fireEvent.press(screen.getByText('← Home'));

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
