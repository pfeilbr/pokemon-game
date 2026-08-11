import { describe, expect, it } from 'vitest';
import {
  COMBO_CAP,
  CRIT_THRESHOLD,
  GLANCE_ATTACK_RATIO,
  type BattleState,
  availableMoves,
  battleReducer,
  beginCatch,
  computeDamage,
  createBattle,
  isOver,
  speedFraction,
  summarise,
} from './battle';
import { MAX_CHARGE } from './moves';
import { CREATURES, getCreature } from './creatures';
import { NOT_VERY_EFFECTIVE, SUPER_EFFECTIVE } from './elements';

const setup = {
  seed: 'test-seed',
  playerCreatureId: 'cindik', // ember
  foeCreatureId: 'sproutle', // leaf - ember is strong into leaf
  playerLevel: 3,
  foeLevel: 3,
  tier: 4,
};

function fresh(overrides: Partial<typeof setup> = {}): BattleState {
  return createBattle({ ...setup, ...overrides });
}

/** Plays one full turn. `correct` decides whether the answer is right. */
function playTurn(state: BattleState, moveId: string, correct: boolean, elapsedMs = 2000): BattleState {
  let next = battleReducer(state, { type: 'chooseMove', moveId, now: 0 });
  if (next.phase !== 'solving') return next;
  const answer = correct ? next.problem!.answer : next.problem!.answer + 1;
  next = battleReducer(next, { type: 'answer', value: answer, now: elapsedMs });
  if (next.phase === 'resolving') next = battleReducer(next, { type: 'continue' });
  return next;
}

/** Drives a battle to its end, always answering the same way. */
function playOut(state: BattleState, correct: boolean, moveKind = 'strong'): BattleState {
  let s = state;
  for (let i = 0; i < 100 && !isOver(s); i++) {
    if (s.phase === 'catching') {
      s = beginCatch(s, 0);
      const answer = correct ? s.problem!.answer : s.problem!.answer + 1;
      s = battleReducer(s, { type: 'answer', value: answer, now: 1000 });
      break;
    }
    const move = availableMoves(s).find((m) => m.kind === moveKind && m.affordable);
    s = playTurn(s, move?.id ?? availableMoves(s)[0]!.id, correct);
  }
  return s;
}

describe('createBattle', () => {
  it('starts both fighters at full health, ready to choose', () => {
    const s = fresh();
    expect(s.phase).toBe('choosing');
    expect(s.turn).toBe(1);
    expect(s.player.hp).toBe(s.player.maxHp);
    expect(s.foe.hp).toBe(s.foe.maxHp);
    expect(s.charge).toBe(0);
    expect(s.outcome).toBeNull();
    expect(s.log).toEqual([]);
  });

  it('clamps a nonsense tier', () => {
    expect(fresh({ tier: 99 }).tier).toBe(10);
    expect(fresh({ tier: -3 }).tier).toBe(1);
  });
});

describe('move availability', () => {
  it('offers four moves and gates the ones that cost charge', () => {
    const s = fresh();
    const moves = availableMoves(s);
    expect(moves).toHaveLength(4);
    expect(moves.filter((m) => m.affordable).map((m) => m.kind)).toEqual(['quick', 'strong']);
  });

  it('unlocks charge moves once charge is earned', () => {
    const moves = availableMoves({ ...fresh(), charge: MAX_CHARGE });
    expect(moves.every((m) => m.affordable)).toBe(true);
  });

  it('refuses a move the player cannot afford', () => {
    const s = fresh();
    const special = availableMoves(s).find((m) => m.kind === 'special')!;
    expect(battleReducer(s, { type: 'chooseMove', moveId: special.id, now: 0 })).toBe(s);
  });

  it('ignores an unknown move id', () => {
    const s = fresh();
    expect(battleReducer(s, { type: 'chooseMove', moveId: 'not-a-move', now: 0 })).toBe(s);
  });
});

describe('turn flow', () => {
  it('shows a problem when a move is chosen', () => {
    const s = battleReducer(fresh(), { type: 'chooseMove', moveId: 'ember-quick', now: 1000 });
    expect(s.phase).toBe('solving');
    expect(s.problem).not.toBeNull();
    expect(s.problemShownAt).toBe(1000);
  });

  it('makes the quick move easier and the strong move harder than the base tier', () => {
    const base = fresh({ tier: 5 });
    const quick = battleReducer(base, { type: 'chooseMove', moveId: 'ember-quick', now: 0 });
    const strong = battleReducer(base, { type: 'chooseMove', moveId: 'ember-strong', now: 0 });
    expect(quick.problem!.tier).toBe(4);
    expect(strong.problem!.tier).toBe(6);
  });

  it('never asks the same question two turns running', () => {
    let s = fresh();
    const prompts: string[] = [];
    for (let i = 0; i < 12 && !isOver(s); i++) {
      s = battleReducer(s, { type: 'chooseMove', moveId: 'ember-quick', now: 0 });
      if (s.phase !== 'solving') break;
      prompts.push(s.problem!.prompt);
      s = battleReducer(s, { type: 'answer', value: s.problem!.answer, now: 1000 });
      if (s.phase === 'resolving') s = battleReducer(s, { type: 'continue' });
    }
    for (let i = 1; i < prompts.length; i++) {
      expect(prompts[i]).not.toBe(prompts[i - 1]);
    }
  });

  it('rejects actions that do not belong to the current phase', () => {
    const s = fresh();
    expect(battleReducer(s, { type: 'answer', value: 1, now: 0 })).toBe(s);
    expect(battleReducer(s, { type: 'continue' })).toBe(s);

    const solving = battleReducer(s, { type: 'chooseMove', moveId: 'ember-quick', now: 0 });
    expect(battleReducer(solving, { type: 'chooseMove', moveId: 'ember-strong', now: 0 })).toBe(solving);
  });

  it('holds the opponent back on turn one so the player always opens', () => {
    const after = playTurn(fresh(), 'ember-quick', true);
    expect(after.player.hp).toBe(after.player.maxHp);
    expect(after.log.some((l) => l.kind === 'foeHit')).toBe(false);
  });

  it('lets the opponent counterattack from turn two', () => {
    const s = playTurn(playTurn(fresh(), 'ember-quick', true), 'ember-quick', true);
    expect(s.player.hp).toBeLessThan(s.player.maxHp);
    expect(s.log.some((l) => l.kind === 'foeHit')).toBe(true);
  });
});

describe('answers', () => {
  it('rewards a correct answer with damage, charge and combo', () => {
    const s = playTurn(fresh(), 'ember-quick', true);
    expect(s.foe.hp).toBeLessThan(s.foe.maxHp);
    expect(s.charge).toBe(1);
    expect(s.combo).toBe(1);
    expect(s.log[0]!.kind).toBe('playerHit');
  });

  it('still lands a glancing hit on a wrong answer, and breaks the combo', () => {
    const s = playTurn(playTurn(fresh(), 'ember-quick', true), 'ember-quick', false);
    expect(s.combo).toBe(0);
    expect(s.bestCombo).toBe(1);
    const glance = s.log.find((l) => l.kind === 'playerGlance');
    expect(glance).toBeDefined();
    expect(glance!.kind === 'playerGlance' && glance.amount).toBeGreaterThan(0);
  });

  it('tells the player the right answer when they miss', () => {
    let s = battleReducer(fresh(), { type: 'chooseMove', moveId: 'ember-quick', now: 0 });
    const expected = s.problem!.answer;
    s = battleReducer(s, { type: 'answer', value: expected + 7, now: 1000 });
    const glance = s.log.find((l) => l.kind === 'playerGlance');
    expect(glance!.kind === 'playerGlance' && glance.correctAnswer).toBe(expected);
  });

  it('treats a timeout as a wrong answer', () => {
    let s = battleReducer(fresh(), { type: 'chooseMove', moveId: 'ember-quick', now: 0 });
    s = battleReducer(s, { type: 'timeout', now: 30_000 });
    expect(s.combo).toBe(0);
    expect(s.log.some((l) => l.kind === 'playerGlance')).toBe(true);
  });

  it('records every attempt for the stats screen', () => {
    const s = playTurn(playTurn(fresh(), 'ember-quick', true), 'ember-quick', false);
    expect(s.attempts).toHaveLength(2);
    expect(s.attempts.map((a) => a.correct)).toEqual([true, false]);
    expect(s.attempts[0]!.elapsedMs).toBe(2000);
  });
});

describe('charge and mend', () => {
  it('spends charge on the special and refunds one for answering correctly', () => {
    const s = playTurn({ ...fresh(), charge: MAX_CHARGE }, 'ember-special', true);
    expect(s.charge).toBe(1);
  });

  it('caps charge so it cannot be banked forever', () => {
    let s = fresh();
    for (let i = 0; i < 6 && !isOver(s); i++) s = playTurn(s, 'ember-quick', true);
    expect(s.charge).toBeLessThanOrEqual(MAX_CHARGE);
  });

  it('heals with mend but never above the maximum', () => {
    const hurt: BattleState = {
      ...fresh(),
      charge: 2,
      turn: 1,
      player: { ...fresh().player, hp: 10 },
    };
    const s = playTurn(hurt, 'mend', true);
    expect(s.player.hp).toBeGreaterThan(10);
    expect(s.player.hp).toBeLessThanOrEqual(s.player.maxHp);
    expect(s.log.some((l) => l.kind === 'playerMend')).toBe(true);
  });

  it('does not overheal a nearly-full fighter', () => {
    const s = playTurn({ ...fresh(), charge: 2 }, 'mend', true);
    expect(s.player.hp).toBe(s.player.maxHp);
  });

  it('still heals a little on a wrong answer, so charge is never wasted', () => {
    const hurt: BattleState = { ...fresh(), charge: 2, player: { ...fresh().player, hp: 10 } };
    const s = playTurn(hurt, 'mend', false);
    expect(s.player.hp).toBeGreaterThan(10);
  });
});

describe('computeDamage', () => {
  const base = {
    power: 16,
    attack: 10,
    attackerElement: 'ember',
    defenderElement: 'leaf',
    correct: true,
    elapsedMs: 0,
    parSeconds: 10,
    combo: 0,
  } as const;

  it('applies the type multiplier', () => {
    const strong = computeDamage(base);
    const weak = computeDamage({ ...base, defenderElement: 'aqua' });
    expect(strong.typeMultiplier).toBe(SUPER_EFFECTIVE);
    expect(weak.typeMultiplier).toBe(NOT_VERY_EFFECTIVE);
    expect(strong.damage).toBeGreaterThan(weak.damage);
  });

  it('crits on an instant answer and not on a slow one', () => {
    expect(computeDamage({ ...base, elapsedMs: 0 }).crit).toBe(true);
    expect(computeDamage({ ...base, elapsedMs: 60_000 }).crit).toBe(false);
    expect(computeDamage({ ...base, elapsedMs: 0 }).speedMultiplier).toBeGreaterThanOrEqual(
      CRIT_THRESHOLD,
    );
  });

  it('never penalises a slow answer below normal damage', () => {
    expect(computeDamage({ ...base, elapsedMs: 999_999 }).speedMultiplier).toBe(1);
  });

  it('gives no speed bonus for a wrong answer', () => {
    expect(computeDamage({ ...base, correct: false, elapsedMs: 0 }).speedMultiplier).toBe(1);
  });

  it('reduces a wrong answer to a flat chip', () => {
    const right = computeDamage({ ...base, elapsedMs: 999_999 });
    const wrong = computeDamage({ ...base, correct: false, elapsedMs: 999_999 });
    expect(wrong.damage).toBeLessThan(right.damage);
    expect(wrong.damage).toBe(Math.round(base.attack * GLANCE_ATTACK_RATIO));
  });

  /**
   * Regression guard. A miss must not benefit from type advantage, combo or
   * speed, or a favourable matchup would let a player win by guessing.
   */
  it('gives a wrong answer no type, combo or speed bonus', () => {
    const superEffective = computeDamage({ ...base, correct: false, defenderElement: 'leaf' });
    const resisted = computeDamage({ ...base, correct: false, defenderElement: 'aqua' });
    const combod = computeDamage({ ...base, correct: false, combo: COMBO_CAP });
    const instant = computeDamage({ ...base, correct: false, elapsedMs: 0 });

    expect(superEffective.damage).toBe(resisted.damage);
    expect(combod.damage).toBe(resisted.damage);
    expect(instant.damage).toBe(resisted.damage);
    expect(instant.crit).toBe(false);
  });

  it('rewards combos but caps the bonus', () => {
    const none = computeDamage({ ...base, combo: 0 }).damage;
    const some = computeDamage({ ...base, combo: 3 }).damage;
    const capped = computeDamage({ ...base, combo: COMBO_CAP }).damage;
    const beyond = computeDamage({ ...base, combo: 999 }).damage;
    expect(some).toBeGreaterThan(none);
    expect(beyond).toBe(capped);
  });

  it('always deals at least one damage', () => {
    const d = computeDamage({
      ...base,
      power: 1,
      attack: 1,
      correct: false,
      defenderElement: 'aqua',
    });
    expect(d.damage).toBeGreaterThanOrEqual(1);
  });
});

describe('speedFraction', () => {
  it('is 1 for an instant answer and 0 once par has elapsed', () => {
    expect(speedFraction(0, 10)).toBe(1);
    expect(speedFraction(10_000, 10)).toBe(0);
    expect(speedFraction(5_000, 10)).toBeCloseTo(0.5);
  });

  it('clamps rather than going negative', () => {
    expect(speedFraction(999_999, 10)).toBe(0);
    expect(speedFraction(-500, 10)).toBe(1);
  });

  it('tolerates a zero par time', () => {
    expect(speedFraction(1000, 0)).toBeGreaterThanOrEqual(0);
    expect(speedFraction(1000, 0)).toBeLessThanOrEqual(1);
  });
});

describe('endgame', () => {
  it('a player who answers correctly wins', () => {
    const s = playOut(fresh(), true);
    expect(s.outcome).toBe('win');
    expect(s.phase).toBe('victory');
    expect(s.foe.hp).toBe(0);
  });

  it('a player who answers everything wrong loses', () => {
    const s = playOut(fresh(), false);
    expect(s.outcome).toBe('loss');
    expect(s.phase).toBe('defeat');
    expect(s.player.hp).toBe(0);
  });

  it('offers a catch question after a win, and catching depends on the answer', () => {
    let s = fresh();
    while (s.phase !== 'catching' && !isOver(s)) {
      s = playTurn(s, 'ember-strong', true);
    }
    expect(s.phase).toBe('catching');
    expect(s.problem).not.toBeNull();

    const timed = beginCatch(s, 0);
    const caught = battleReducer(timed, { type: 'answer', value: timed.problem!.answer, now: 500 });
    expect(caught.caught).toBe(true);
    expect(caught.phase).toBe('victory');
    expect(caught.log.some((l) => l.kind === 'caught')).toBe(true);

    const missed = battleReducer(timed, { type: 'answer', value: timed.problem!.answer + 1, now: 500 });
    expect(missed.caught).toBe(false);
    expect(missed.log.some((l) => l.kind === 'escaped')).toBe(true);
  });

  it('freezes once the battle is over', () => {
    const s = playOut(fresh(), true);
    expect(battleReducer(s, { type: 'chooseMove', moveId: 'ember-quick', now: 0 })).toBe(s);
    expect(battleReducer(s, { type: 'answer', value: 1, now: 0 })).toBe(s);
    expect(battleReducer(s, { type: 'continue' })).toBe(s);
  });

  it('summarises the fight', () => {
    const s = playOut(fresh(), true);
    const sum = summarise(s);
    expect(sum.won).toBe(true);
    expect(sum.total).toBeGreaterThan(0);
    expect(sum.correct).toBe(sum.total);
    expect(sum.hpRatio).toBeGreaterThan(0);
    expect(sum.hpRatio).toBeLessThanOrEqual(1);
    expect(sum.creatureId).toBe('sproutle');
  });
});

describe('determinism and purity', () => {
  it('replays identically from the same seed', () => {
    const a = playOut(fresh(), true);
    const b = playOut(fresh(), true);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('asks different questions under a different seed', () => {
    const promptsFor = (seed: string) => {
      let s = fresh({ seed });
      const prompts: string[] = [];
      for (let i = 0; i < 5 && !isOver(s); i++) {
        s = battleReducer(s, { type: 'chooseMove', moveId: 'ember-quick', now: 0 });
        if (s.phase !== 'solving') break;
        prompts.push(s.problem!.prompt);
        s = battleReducer(s, { type: 'answer', value: s.problem!.answer, now: 1000 });
        if (s.phase === 'resolving') s = battleReducer(s, { type: 'continue' });
      }
      return prompts;
    };
    expect(promptsFor('alpha')).not.toEqual(promptsFor('omega'));
  });

  it('never mutates the state handed to it', () => {
    const s = fresh();
    const snapshot = JSON.stringify(s);
    battleReducer(s, { type: 'chooseMove', moveId: 'ember-quick', now: 0 });
    playOut(s, true);
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it('survives a round-trip through JSON, as a saved battle must', () => {
    let s = playTurn(fresh(), 'ember-quick', true);
    s = JSON.parse(JSON.stringify(s)) as BattleState;
    s = playTurn(s, 'ember-strong', true);
    expect(s.attempts).toHaveLength(2);
    expect(s.foe.hp).toBeLessThan(s.foe.maxHp);
  });
});

describe('difficulty balance', () => {
  /** Saves the special for full charge, otherwise leans on the strong move. */
  function playSmart(state: BattleState): BattleState {
    let s = state;
    for (let i = 0; i < 100 && !isOver(s); i++) {
      if (s.phase === 'catching') {
        s = beginCatch(s, 0);
        s = battleReducer(s, { type: 'answer', value: s.problem!.answer, now: 1000 });
        break;
      }
      const moves = availableMoves(s);
      const special = moves.find((m) => m.kind === 'special' && m.affordable);
      const move = special ?? moves.find((m) => m.kind === 'strong')!;
      s = playTurn(s, move.id, true, 800);
    }
    return s;
  }

  const stageOne = CREATURES.filter((c) => c.stage === 1);

  /**
   * The headline property: good play beats every matchup, including the worst
   * one on the wheel (dealing 0.5x while taking 2x). The margin there is thin
   * on purpose - that is the fight that teaches him to counter-pick.
   */
  it('lets skilled play win every matchup, worst case included', () => {
    for (const player of stageOne) {
      for (const foe of stageOne) {
        const s = playSmart(
          createBattle({
            seed: `${player.id}-vs-${foe.id}`,
            playerCreatureId: player.id,
            foeCreatureId: foe.id,
            playerLevel: 3,
            foeLevel: 3,
            tier: 4,
          }),
        );
        expect(s.outcome, `${player.id} vs ${foe.id}`).toBe('win');
      }
    }
  });

  it('punishes the worst matchup enough that counter-picking matters', () => {
    // spark into stone: the player deals 0.5x and takes 2x.
    const worst = playSmart(
      createBattle({
        seed: 'worst-case',
        playerCreatureId: 'zaplet',
        foeCreatureId: 'pebblo',
        playerLevel: 3,
        foeLevel: 3,
        tier: 4,
      }),
    );
    const best = playSmart(
      createBattle({
        seed: 'best-case',
        playerCreatureId: 'pebblo',
        foeCreatureId: 'zaplet',
        playerLevel: 3,
        foeLevel: 3,
        tier: 4,
      }),
    );
    const worstRatio = worst.player.hp / worst.player.maxHp;
    const bestRatio = best.player.hp / best.player.maxHp;

    // Even played perfectly, the wrong matchup is a bloody nose; the right one
    // is comfortable. Both win, so a bad pick is a lesson rather than a wall.
    expect(worstRatio).toBeLessThan(0.5);
    expect(bestRatio).toBeGreaterThan(0.75);
    expect(bestRatio - worstRatio).toBeGreaterThan(0.3);
  });

  it('makes a bad matchup cost more health than a good one', () => {
    // ember into leaf (strong) vs ember into aqua (resisted)
    const good = playOut(fresh({ foeCreatureId: 'sproutle' }), true);
    const bad = playOut(fresh({ foeCreatureId: 'bublet' }), true);
    expect(bad.turn).toBeGreaterThan(good.turn);
    expect(bad.player.hp).toBeLessThan(good.player.hp);
  });

  /**
   * Regression guard for the bug this suite caught: with a type advantage a
   * player could once win while answering every single question wrong.
   */
  it('never lets a wrong-answer run win, even with the best matchup', () => {
    for (const player of stageOne) {
      for (const foe of stageOne) {
        const s = playOut(
          createBattle({
            seed: `mash-${player.id}-${foe.id}`,
            playerCreatureId: player.id,
            foeCreatureId: foe.id,
            playerLevel: 3,
            foeLevel: 3,
            tier: 4,
          }),
          false,
        );
        expect(s.outcome, `${player.id} vs ${foe.id}`).toBe('loss');
      }
    }
  });

  it('keeps every battle to a sensible number of turns', () => {
    for (const foe of stageOne) {
      const s = playSmart(fresh({ foeCreatureId: foe.id }));
      expect(s.turn).toBeGreaterThan(1);
      expect(s.turn).toBeLessThan(20);
    }
  });
});

describe('element helpers', () => {
  it('reads elements off the fighters', () => {
    const s = fresh();
    expect(getCreature(s.player.creatureId).element).toBe('ember');
    expect(getCreature(s.foe.creatureId).element).toBe('leaf');
  });
});
