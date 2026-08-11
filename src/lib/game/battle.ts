import { type Creature, getCreature, statsAtLevel } from './creatures';
import { type Element, effectiveness } from './elements';
import { type Attempt, type Problem, clampTier, generateProblem } from './math';
import { CHARGE_PER_CORRECT, MAX_CHARGE, type Move, findMove, movesFor } from './moves';
import { createRng } from './rng';

/**
 * The battle state machine.
 *
 * Written as a pure reducer over a serialisable state: no timers, no Date.now,
 * no RNG object held in state. Randomness comes from seeds derived from
 * `${seed}:${turn}:${purpose}`, and the current time is passed in with each
 * action. That means a battle can be snapshotted to the database mid-fight,
 * replayed exactly in a test, and reasoned about without mocking anything.
 *
 * Tuning notes - the player is seven:
 *  - A wrong answer still lands a glancing hit rather than wasting the turn
 *    outright. Losing a turn feels like a punishment; a weak hit feels like a
 *    near miss.
 *  - The opponent does not attack on the very first turn, so the player always
 *    gets to open.
 *  - Answering fast is rewarded with a critical hit, but answering slowly is
 *    never penalised below the normal damage.
 */

export type BattlePhase =
  | 'choosing'
  | 'solving'
  | 'resolving'
  | 'catching'
  | 'victory'
  | 'defeat';

export type LogEntry =
  | { kind: 'playerHit'; turn: number; amount: number; moveId: string; multiplier: number; crit: boolean }
  | { kind: 'playerGlance'; turn: number; amount: number; moveId: string; correctAnswer: number }
  | { kind: 'playerMend'; turn: number; amount: number }
  | { kind: 'foeHit'; turn: number; amount: number; multiplier: number }
  | { kind: 'foeFaint'; turn: number }
  | { kind: 'playerFaint'; turn: number }
  | { kind: 'caught'; turn: number; creatureId: string }
  | { kind: 'escaped'; turn: number; creatureId: string };

export type Fighter = {
  creatureId: string;
  level: number;
  hp: number;
  maxHp: number;
  atk: number;
};

export type BattleState = {
  seed: string;
  turn: number;
  phase: BattlePhase;
  player: Fighter;
  foe: Fighter;
  /** Current maths difficulty; adapts between battles, fixed within one. */
  tier: number;
  charge: number;
  combo: number;
  bestCombo: number;
  pendingMoveId: string | null;
  problem: Problem | null;
  /** Epoch ms when the current problem was shown. */
  problemShownAt: number | null;
  /** Survives past `problem` being cleared, so back-to-back turns never repeat. */
  lastPrompt: string | null;
  log: LogEntry[];
  attempts: Attempt[];
  /** Set once the fight ends. */
  caught: boolean;
  outcome: 'win' | 'loss' | null;
};

export type BattleAction =
  | { type: 'chooseMove'; moveId: string; now: number }
  | { type: 'answer'; value: number; now: number }
  | { type: 'timeout'; now: number }
  /** Starts the clock on the catch question once its screen is on show. */
  | { type: 'beginCatch'; now: number }
  | { type: 'continue' };

export type BattleSetup = {
  seed: string;
  playerCreatureId: string;
  foeCreatureId: string;
  playerLevel: number;
  foeLevel: number;
  tier: number;
};

/**
 * A wrong answer deals a flat chip of the attacker's own strength - no type
 * bonus, no combo, no speed bonus.
 *
 * This is load-bearing. An earlier version scaled the miss like a normal hit,
 * which meant a good type matchup multiplied the consolation damage enough to
 * win a fight without answering a single question correctly. Maths has to be
 * the win condition, so a miss is a fixed scratch and nothing more.
 */
export const GLANCE_ATTACK_RATIO = 0.25;

/** Fraction of a mend that still lands when the answer was wrong. */
export const GLANCE_MULTIPLIER = 0.25;
/** Peak speed bonus for an instant correct answer. */
export const MAX_SPEED_BONUS = 0.3;
/** A hit at or above this total speed bonus is flagged as a critical. */
export const CRIT_THRESHOLD = 1.2;
/** Per-combo damage bonus, capped at COMBO_CAP steps. */
export const COMBO_BONUS = 0.06;
export const COMBO_CAP = 5;
/** Scales the opponent's raw attack stat into per-turn damage. */
export const FOE_ATTACK_SCALE = 0.8;

function fighterFor(creature: Creature, level: number): Fighter {
  const stats = statsAtLevel(creature, level);
  return {
    creatureId: creature.id,
    level,
    hp: stats.hp,
    maxHp: stats.hp,
    atk: stats.atk,
  };
}

export function createBattle(setup: BattleSetup): BattleState {
  const player = getCreature(setup.playerCreatureId);
  const foe = getCreature(setup.foeCreatureId);
  return {
    seed: setup.seed,
    turn: 1,
    phase: 'choosing',
    player: fighterFor(player, setup.playerLevel),
    foe: fighterFor(foe, setup.foeLevel),
    tier: clampTier(setup.tier),
    charge: 0,
    combo: 0,
    bestCombo: 0,
    pendingMoveId: null,
    problem: null,
    problemShownAt: null,
    lastPrompt: null,
    log: [],
    attempts: [],
    caught: false,
    outcome: null,
  };
}

export function playerElement(state: BattleState): Element {
  return getCreature(state.player.creatureId).element;
}

export function foeElement(state: BattleState): Element {
  return getCreature(state.foe.creatureId).element;
}

/** The four moves on the player's bar, with affordability resolved. */
export function availableMoves(state: BattleState): Array<Move & { affordable: boolean }> {
  return movesFor(playerElement(state)).map((move) => ({
    ...move,
    affordable: state.charge >= move.chargeCost,
  }));
}

/** How fast the answer was, as a 0..1 bonus fraction of MAX_SPEED_BONUS. */
export function speedFraction(elapsedMs: number, parSeconds: number): number {
  const par = Math.max(0.5, parSeconds) * 1000;
  const ratio = 1 - elapsedMs / par;
  return Math.min(1, Math.max(0, ratio));
}

export type DamageBreakdown = {
  damage: number;
  typeMultiplier: number;
  speedMultiplier: number;
  comboMultiplier: number;
  crit: boolean;
};

export function computeDamage(params: {
  power: number;
  attack: number;
  attackerElement: Element;
  defenderElement: Element;
  correct: boolean;
  elapsedMs: number;
  parSeconds: number;
  combo: number;
}): DamageBreakdown {
  const typeMultiplier = effectiveness(params.attackerElement, params.defenderElement);

  if (!params.correct) {
    // Flat chip. Deliberately ignores type, combo and speed so that no amount
    // of favourable matchup can substitute for getting the sum right.
    return {
      damage: Math.max(1, Math.round(params.attack * GLANCE_ATTACK_RATIO)),
      typeMultiplier,
      speedMultiplier: 1,
      comboMultiplier: 1,
      crit: false,
    };
  }

  const speedMultiplier = 1 + MAX_SPEED_BONUS * speedFraction(params.elapsedMs, params.parSeconds);
  const comboMultiplier = 1 + Math.min(params.combo, COMBO_CAP) * COMBO_BONUS;

  const base = params.power * (params.attack / 10);
  const raw = base * typeMultiplier * speedMultiplier * comboMultiplier;

  return {
    // Always at least 1: a hit that reads as "0 damage" looks broken.
    damage: Math.max(1, Math.round(raw)),
    typeMultiplier,
    speedMultiplier,
    comboMultiplier,
    crit: speedMultiplier >= CRIT_THRESHOLD,
  };
}

function foeDamage(state: BattleState): { damage: number; multiplier: number } {
  const multiplier = effectiveness(foeElement(state), playerElement(state));
  const rng = createRng(`${state.seed}:${state.turn}:foe`);
  const variance = 0.85 + rng.next() * 0.3;
  const raw = state.foe.atk * FOE_ATTACK_SCALE * multiplier * variance;
  return { damage: Math.max(1, Math.round(raw)), multiplier };
}

function problemFor(state: BattleState, move: Move): Problem {
  return generateProblem(
    `${state.seed}:${state.turn}:problem`,
    state.tier + move.tierOffset,
    state.lastPrompt ?? undefined,
  );
}

function catchProblemFor(state: BattleState): Problem {
  return generateProblem(
    `${state.seed}:${state.turn}:catch`,
    state.tier,
    state.lastPrompt ?? undefined,
  );
}

export function battleReducer(state: BattleState, action: BattleAction): BattleState {
  switch (action.type) {
    case 'chooseMove': {
      if (state.phase !== 'choosing') return state;
      const move = findMove(playerElement(state), action.moveId);
      if (!move || state.charge < move.chargeCost) return state;

      const problem = problemFor(state, move);
      return {
        ...state,
        phase: 'solving',
        pendingMoveId: move.id,
        problem,
        problemShownAt: action.now,
        lastPrompt: problem.prompt,
      };
    }

    case 'answer':
    case 'timeout': {
      if (state.phase === 'catching') return resolveCatch(state, action);
      if (state.phase !== 'solving' || !state.problem || state.pendingMoveId === null) return state;

      const move = findMove(playerElement(state), state.pendingMoveId);
      if (!move) return state;

      const correct = action.type === 'answer' && action.value === state.problem.answer;
      const elapsedMs = Math.max(0, action.now - (state.problemShownAt ?? action.now));

      return resolveTurn(state, { move, correct, elapsedMs });
    }

    case 'beginCatch': {
      if (state.phase !== 'catching' || state.problemShownAt !== null) return state;
      return { ...state, problemShownAt: action.now };
    }

    case 'continue': {
      if (state.phase !== 'resolving') return state;
      return { ...state, phase: 'choosing', pendingMoveId: null, problem: null, problemShownAt: null };
    }

    default:
      return state;
  }
}

function resolveTurn(
  state: BattleState,
  { move, correct, elapsedMs }: { move: Move; correct: boolean; elapsedMs: number },
): BattleState {
  const problem = state.problem!;
  const log: LogEntry[] = [...state.log];

  const attempt: Attempt = {
    skill: problem.skill,
    tier: problem.tier,
    correct,
    elapsedMs,
  };

  const combo = correct ? state.combo + 1 : 0;
  const bestCombo = Math.max(state.bestCombo, combo);
  let charge = state.charge - move.chargeCost;
  if (correct) charge = Math.min(MAX_CHARGE, charge + CHARGE_PER_CORRECT);

  let player = { ...state.player };
  let foe = { ...state.foe };

  if (move.kind === 'mend') {
    // A missed heal still restores a little, so spending charge is never a
    // total loss.
    const ratio = correct ? move.power / 100 : (move.power / 100) * GLANCE_MULTIPLIER;
    const healed = Math.min(player.maxHp - player.hp, Math.max(1, Math.round(player.maxHp * ratio)));
    player = { ...player, hp: player.hp + healed };
    log.push({ kind: 'playerMend', turn: state.turn, amount: healed });
  } else {
    const result = computeDamage({
      power: move.power,
      attack: player.atk,
      attackerElement: playerElement(state),
      defenderElement: foeElement(state),
      correct,
      elapsedMs,
      parSeconds: problem.parTime,
      combo: state.combo,
    });
    foe = { ...foe, hp: Math.max(0, foe.hp - result.damage) };
    log.push(
      correct
        ? {
            kind: 'playerHit',
            turn: state.turn,
            amount: result.damage,
            moveId: move.id,
            multiplier: result.typeMultiplier,
            crit: result.crit,
          }
        : {
            kind: 'playerGlance',
            turn: state.turn,
            amount: result.damage,
            moveId: move.id,
            correctAnswer: problem.answer,
          },
    );
  }

  const base: BattleState = {
    ...state,
    player,
    foe,
    charge,
    combo,
    bestCombo,
    attempts: [...state.attempts, attempt],
    log,
  };

  // Opponent down: skip its counterattack and go straight to the catch.
  if (foe.hp <= 0) {
    log.push({ kind: 'foeFaint', turn: state.turn });
    const catchProblem = catchProblemFor(base);
    return {
      ...base,
      phase: 'catching',
      problem: catchProblem,
      problemShownAt: null,
      lastPrompt: catchProblem.prompt,
      pendingMoveId: null,
      log,
    };
  }

  // The opponent holds back on turn one so the player always opens.
  if (state.turn > 1) {
    const counter = foeDamage(base);
    player = { ...player, hp: Math.max(0, player.hp - counter.damage) };
    log.push({ kind: 'foeHit', turn: state.turn, amount: counter.damage, multiplier: counter.multiplier });
  }

  if (player.hp <= 0) {
    log.push({ kind: 'playerFaint', turn: state.turn });
    return { ...base, player, phase: 'defeat', outcome: 'loss', log };
  }

  return {
    ...base,
    player,
    phase: 'resolving',
    turn: state.turn + 1,
    log,
  };
}

function resolveCatch(
  state: BattleState,
  action: Extract<BattleAction, { type: 'answer' | 'timeout' }>,
): BattleState {
  if (!state.problem) return { ...state, phase: 'victory', outcome: 'win' };

  const correct = action.type === 'answer' && action.value === state.problem.answer;
  const elapsedMs = Math.max(0, action.now - (state.problemShownAt ?? action.now));

  const attempt: Attempt = {
    skill: state.problem.skill,
    tier: state.problem.tier,
    correct,
    elapsedMs,
  };

  return {
    ...state,
    phase: 'victory',
    outcome: 'win',
    caught: correct,
    attempts: [...state.attempts, attempt],
    log: [
      ...state.log,
      correct
        ? { kind: 'caught', turn: state.turn, creatureId: state.foe.creatureId }
        : { kind: 'escaped', turn: state.turn, creatureId: state.foe.creatureId },
    ],
  };
}

/** Convenience wrapper over the `beginCatch` action. */
export function beginCatch(state: BattleState, now: number): BattleState {
  return battleReducer(state, { type: 'beginCatch', now });
}

export function isOver(state: BattleState): boolean {
  return state.phase === 'victory' || state.phase === 'defeat';
}

export type BattleSummary = {
  won: boolean;
  caught: boolean;
  creatureId: string;
  turns: number;
  correct: number;
  total: number;
  bestCombo: number;
  hpRemaining: number;
  hpRatio: number;
};

export function summarise(state: BattleState): BattleSummary {
  const correct = state.attempts.filter((a) => a.correct).length;
  return {
    won: state.outcome === 'win',
    caught: state.caught,
    creatureId: state.foe.creatureId,
    turns: state.turn,
    correct,
    total: state.attempts.length,
    bestCombo: state.bestCombo,
    hpRemaining: state.player.hp,
    hpRatio: state.player.maxHp > 0 ? state.player.hp / state.player.maxHp : 0,
  };
}
