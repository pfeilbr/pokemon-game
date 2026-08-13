import { describe, expect, it } from 'vitest';
import {
  type BattleState,
  type Profile,
  applyBattleResult,
  availableMoves,
  battleReducer,
  createBattle,
  createProfile,
  levelFromXp,
  partnerFor,
  summarise,
} from '../engine';

/**
 * Plays a whole battle exactly the way `BattleScreen` drives it.
 *
 * The rules themselves are covered by the engine tests at the repository root.
 * What is only testable here is this client's *wiring*: the arguments the screen
 * builds `createBattle` from, the order it dispatches actions in, and the fact
 * that the catch phase needs an explicit `beginCatch` from an effect before its
 * clock starts. Each of those is a place where the screen can be wrong while
 * every engine test still passes.
 */

function newProfile(): Profile {
  return createProfile({ trainerName: 'Leo', starterId: 'cindik' });
}

/** Mirrors `BattleScreen`'s reducer initialiser argument for argument. */
function startBattle(profile: Profile, opponentId: string): BattleState {
  const level = levelFromXp(profile.xp);
  return createBattle({
    seed: `${profile.trainerName}:${profile.battlesWon + profile.battlesLost}:${opponentId}`,
    playerCreatureId: partnerFor(profile),
    foeCreatureId: opponentId,
    playerLevel: level,
    foeLevel: level,
    tier: profile.tier,
  });
}

/**
 * Runs the fight to its end, answering every question correctly and spending
 * the special whenever it is affordable - the way a competent player plays.
 * `now` is threaded explicitly, which is the whole point of the pure reducer.
 */
function playOut(start: BattleState, options: { correct: boolean }): BattleState {
  let state = start;
  let now = 1_000;

  for (
    let guard = 0;
    guard < 400 && state.phase !== 'victory' && state.phase !== 'defeat';
    guard++
  ) {
    now += 900;

    if (state.phase === 'choosing') {
      const moves = availableMoves(state);
      const special = moves.find((m) => m.kind === 'special' && m.affordable);
      const move = special ?? moves.find((m) => m.kind === 'quick')!;
      state = battleReducer(state, { type: 'chooseMove', moveId: move.id, now });
      continue;
    }

    if (state.phase === 'catching' && state.problemShownAt === null) {
      // The screen does this from an effect once the catch screen is on show.
      state = battleReducer(state, { type: 'beginCatch', now });
      continue;
    }

    if (state.phase === 'solving' || state.phase === 'catching') {
      const answer = state.problem!.answer;
      state = battleReducer(state, {
        type: 'answer',
        value: options.correct ? answer : answer + 1,
        now,
      });
      continue;
    }

    if (state.phase === 'resolving') {
      state = battleReducer(state, { type: 'continue' });
    }
  }

  return state;
}

describe('a battle driven the way the screen drives it', () => {
  it('reaches an ending rather than stalling in a phase the screen cannot advance', () => {
    const end = playOut(startBattle(newProfile(), 'flurro'), { correct: true });
    expect(['victory', 'defeat']).toContain(end.phase);
  });

  it('lets a player who answers everything correctly win and catch the creature', () => {
    const end = playOut(startBattle(newProfile(), 'flurro'), { correct: true });
    const summary = summarise(end);

    expect(summary.won).toBe(true);
    // Reaching the catch question at all requires beginCatch to have fired.
    expect(summary.caught).toBe(true);
  });

  it('folds the result into the profile the way the screen does', () => {
    const profile = newProfile();
    const end = playOut(startBattle(profile, 'flurro'), { correct: true });
    const result = applyBattleResult(profile, summarise(end), end.attempts);

    expect(result.xpGained).toBeGreaterThan(0);
    expect(result.profile.battlesWon).toBe(1);
    expect(result.profile.caught).toContain('flurro');
    // A win at level 1 clears the first-win badge, which the victory screen
    // then names.
    expect(result.newBadges).toContain('first-win');
  });

  it('still pays out when the player loses, because trying has to be worth something', () => {
    const profile = newProfile();
    const end = playOut(startBattle(profile, 'flurro'), { correct: false });
    const summary = summarise(end);
    const result = applyBattleResult(profile, summary, end.attempts);

    expect(summary.won).toBe(false);
    expect(result.xpGained).toBeGreaterThan(0);
  });

  it('gives a different fight each time, because the seed counts battles', () => {
    const first = newProfile();
    const second: Profile = { ...first, battlesWon: 1 };

    expect(startBattle(first, 'flurro').seed).not.toBe(startBattle(second, 'flurro').seed);
  });

  it('reuses the same seed for a screen that re-renders mid-fight', () => {
    const profile = newProfile();
    expect(startBattle(profile, 'flurro').seed).toBe(startBattle(profile, 'flurro').seed);
  });

  it('fights with the evolved partner once the trainer has levelled', () => {
    // partnerFor is what the screen passes as the player creature, so an
    // evolution has to show up in the battle itself, not just on the dashboard.
    const grown: Profile = { ...newProfile(), xp: 5_000 };
    expect(startBattle(grown, 'flurro').player.creatureId).not.toBe('cindik');
  });
});
