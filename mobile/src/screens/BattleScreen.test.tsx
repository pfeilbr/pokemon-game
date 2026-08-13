import { fireEvent, screen } from '@testing-library/react-native';
import { describe, expect, it, vi } from 'vitest';
import {
  type BattleState,
  type Profile,
  availableMoves,
  battleReducer,
  createBattle,
  getCreature,
  levelFromXp,
  partnerFor,
} from '../engine';
import { renderWithProfile, trainer } from '../test/harness';
import { BattleScreen } from './BattleScreen';

/**
 * The battle screen, mounted for real.
 *
 * The rules are proven at the repository root and the dispatch order is proven
 * by `game/flow.test.ts`; what neither can see is whether any of it reaches a
 * child's thumb. A missing move button, a keypad that renders no digits, or a
 * problem that never appears would leave both of those suites green.
 *
 * Maths is the win condition, so the two turns played here are the two that
 * matter: a right answer, and a wrong one.
 */

const OPPONENT = 'flurro';

const profile = () => trainer();

/**
 * The battle the screen is about to run, reconstructed from the same inputs.
 *
 * The engine is seeded and pure, so this is the same fight down to the
 * question - which is the only way to know the right answer without reading it
 * off the screen and re-implementing the maths to check it.
 */
function mirror(saved: Profile, opponentId: string): BattleState {
  const level = levelFromXp(saved.xp);
  return createBattle({
    seed: `${saved.trainerName}:${saved.battlesWon + saved.battlesLost}:${opponentId}`,
    playerCreatureId: partnerFor(saved),
    foeCreatureId: opponentId,
    playerLevel: level,
    foeLevel: level,
    tier: saved.tier,
  });
}

/** The answer to the question the screen shows after choosing `quick`. */
function answerAfterQuickMove(saved: Profile, opponentId: string): number {
  const start = mirror(saved, opponentId);
  const quick = availableMoves(start).find((move) => move.kind === 'quick');
  const solving = battleReducer(start, { type: 'chooseMove', moveId: quick?.id ?? '', now: 1_000 });
  return solving.problem?.answer ?? Number.NaN;
}

async function type(digits: string) {
  for (const digit of digits) {
    await fireEvent.press(screen.getByTestId(`key-${digit}`));
  }
}

async function mount(saved: Profile = profile()) {
  await renderWithProfile(saved, (p) => (
    <BattleScreen profile={p} opponentId={OPPONENT} onExit={() => {}} onHome={() => {}} />
  ));
}

describe('a battle', () => {
  it('opens on both fighters and a move to choose', async () => {
    const saved = profile();
    await mount(saved);

    expect(screen.getByTestId('battle')).toBeOnTheScreen();
    expect(screen.getByText(getCreature(partnerFor(saved)).name.en)).toBeOnTheScreen();
    expect(screen.getByText(getCreature(OPPONENT).name.en)).toBeOnTheScreen();
    expect(screen.getByText('A wild creature appeared!')).toBeOnTheScreen();
  });

  it('shows the whole four-slot move kit', async () => {
    await mount();

    for (const kind of ['quick', 'strong', 'special', 'mend']) {
      expect(screen.getByTestId(`move-${kind}`), `${kind} is missing`).toBeOnTheScreen();
    }
    expect(screen.getAllByTestId(/^move-/)).toHaveLength(4);
  });

  it('locks the special until there is charge for it', async () => {
    await mount();

    // The special is the answer to a bad matchup, and it costs charge that only
    // correct answers earn - so at the start of a fight it must not be usable.
    expect(screen.getByTestId('move-special')).toBeDisabled();
    expect(screen.getByTestId('move-quick')).toBeEnabled();
  });

  it('puts a question and a full keypad up when a move is chosen', async () => {
    await mount();

    await fireEvent.press(screen.getByTestId('move-quick'));

    expect(screen.getByTestId('problem')).toBeOnTheScreen();
    for (const digit of '0123456789') {
      expect(screen.getByTestId(`key-${digit}`), `key ${digit} is missing`).toBeOnTheScreen();
    }
    expect(screen.getByTestId('key-⌫')).toBeOnTheScreen();
    expect(screen.getByTestId('key-Clear')).toBeOnTheScreen();
    expect(screen.getByTestId('submit-answer')).toBeOnTheScreen();
    expect(screen.getByTestId('speed-meter')).toBeOnTheScreen();
  });

  it('builds the answer on the keypad and can clear it', async () => {
    await mount();
    await fireEvent.press(screen.getByTestId('move-quick'));

    expect(screen.getByTestId('answer-display')).toHaveTextContent('?');

    await type('42');
    expect(screen.getByTestId('answer-display')).toHaveTextContent('42');

    await fireEvent.press(screen.getByTestId('key-⌫'));
    expect(screen.getByTestId('answer-display')).toHaveTextContent('4');

    await fireEvent.press(screen.getByTestId('key-Clear'));
    expect(screen.getByTestId('answer-display')).toHaveTextContent('?');
  });

  it('lands a hit for a right answer', async () => {
    const saved = profile();
    await mount(saved);

    await fireEvent.press(screen.getByTestId('move-quick'));
    await type(String(answerAfterQuickMove(saved, OPPONENT)));
    await fireEvent.press(screen.getByTestId('submit-answer'));

    expect(screen.getByText(/^(Correct!|⚡ Critical hit!)$/)).toBeOnTheScreen();
    expect(screen.getByText(/^−\d+$/)).toBeOnTheScreen();
  });

  it('tells the child the answer after a wrong one, and carries on', async () => {
    await mount();

    await fireEvent.press(screen.getByTestId('move-quick'));
    // Four digits is the keypad's limit, and no tier-1 answer reaches 9999.
    await type('9999');
    await fireEvent.press(screen.getByTestId('submit-answer'));

    expect(screen.getByText('Not quite')).toBeOnTheScreen();
    expect(screen.getByText(/^The answer was \d+$/)).toBeOnTheScreen();

    // A wrong answer is never the end of the fight.
    await fireEvent.press(screen.getByTestId('continue-turn'));
    expect(screen.getAllByTestId(/^move-/)).toHaveLength(4);
  });

  it('leaves the battle when the back button is used', async () => {
    const onExit = vi.fn();
    await renderWithProfile(profile(), (p) => (
      <BattleScreen profile={p} opponentId={OPPONENT} onExit={onExit} onHome={() => {}} />
    ));

    await fireEvent.press(screen.getByText('Back'));

    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
