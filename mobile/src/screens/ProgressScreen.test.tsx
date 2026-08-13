import { fireEvent, screen } from '@testing-library/react-native';
import { describe, expect, it, vi } from 'vitest';
import { BADGES, MAX_TIER, SKILL_META, badgeById } from '../engine';
import { renderWithProfile, trainer } from '../test/harness';
import { ProgressScreen } from './ProgressScreen';

/**
 * Progress, mounted for real.
 *
 * Half of this screen is for the grown-up: the per-skill breakdown is the
 * honest answer to "is this teaching him anything". A badge grid that dropped a
 * badge, or a skill row that never rendered, would be invisible to every other
 * test in this client.
 */

describe('the progress screen', () => {
  it('shows every badge, locked until it is earned', async () => {
    await renderWithProfile(trainer(), (p) => <ProgressScreen profile={p} onBack={() => {}} />);

    expect(screen.getAllByTestId(/^badge-/)).toHaveLength(BADGES.length);
    expect(screen.getAllByText('Locked')).toHaveLength(BADGES.length);
    expect(screen.getByText(`Badges · 0/${BADGES.length}`)).toBeOnTheScreen();
  });

  it('names a badge once it has been earned, and says why', async () => {
    const badge = badgeById('first-win');
    await renderWithProfile(trainer({ badges: ['first-win'] }), (p) => (
      <ProgressScreen profile={p} onBack={() => {}} />
    ));

    expect(screen.getByText(badge?.name.en ?? '')).toBeOnTheScreen();
    expect(screen.getByText(badge?.description.en ?? '')).toBeOnTheScreen();
    expect(screen.getAllByText('Locked')).toHaveLength(BADGES.length - 1);
  });

  it('reports the headline numbers', async () => {
    await renderWithProfile(
      trainer({ battlesWon: 4, problemsTotal: 20, problemsCorrect: 15, tier: 3 }),
      (p) => <ProgressScreen profile={p} onBack={() => {}} />,
    );

    expect(screen.getByText('Battles won')).toBeOnTheScreen();
    expect(screen.getByText('4')).toBeOnTheScreen();
    expect(screen.getByText('Questions answered')).toBeOnTheScreen();
    expect(screen.getByText('20')).toBeOnTheScreen();
    expect(screen.getByText('75%')).toBeOnTheScreen();
    expect(screen.getByText(`🧠 Maths level 3 / ${MAX_TIER}`)).toBeOnTheScreen();
  });

  it('says so plainly when there is nothing to break down yet', async () => {
    await renderWithProfile(trainer(), (p) => <ProgressScreen profile={p} onBack={() => {}} />);

    expect(screen.getByText('Maths skills')).toBeOnTheScreen();
    expect(screen.getByText('Play a battle to see your stats.')).toBeOnTheScreen();
  });

  it('breaks accuracy down by skill once questions have been answered', async () => {
    await renderWithProfile(
      trainer({
        skillStats: { add1: { attempts: 4, correct: 3, totalMs: 8_000 } },
      }),
      (p) => <ProgressScreen profile={p} onBack={() => {}} />,
    );

    expect(screen.getByText(SKILL_META.add1.label.en)).toBeOnTheScreen();
    expect(screen.getByText('75% · 2.0s')).toBeOnTheScreen();
    expect(screen.queryByText('Play a battle to see your stats.')).toBeNull();
  });

  it('goes back home', async () => {
    const onBack = vi.fn();
    await renderWithProfile(trainer(), (p) => <ProgressScreen profile={p} onBack={onBack} />);

    await fireEvent.press(screen.getByText('← Home'));

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
