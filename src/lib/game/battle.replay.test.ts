import { describe, expect, it } from 'vitest';
import {
  type BattleAction,
  type BattleSetup,
  type BattleState,
  availableMoves,
  battleReducer,
  createBattle,
  isOver,
} from './battle';
import { CREATURES } from './creatures';
import { createRng } from './rng';

/**
 * CLAUDE.md claims a battle "can be serialised to JSON mid-fight and resumed".
 *
 * That claim used to be guarded by a single test that cut one fight after one
 * turn, played one more turn and asserted the attempt count had reached two.
 * That check cannot see the failure it is about. A save that drops a field,
 * rounds a float, reorders a key or turns a value into `null` still leaves two
 * attempts in the log - the battle simply continues as a *different* battle,
 * which is exactly the bug nobody would notice.
 *
 * So these tests do not assert that a resumed battle keeps working. They assert
 * it is the same battle, byte for byte, cut at every point it could have been
 * interrupted. `scripts/audit_replay.py` runs the same three properties across
 * the whole roster; this file keeps them inside `npm test`.
 */

const STARTERS = CREATURES.filter((c) => c.stage === 1);

type Style = 'smart' | 'mixed' | 'mash';

/**
 * Plays a battle, recording the exact action objects issued.
 *
 * The actions are recorded rather than re-derived, because a saved battle's
 * remaining input is literal data, not a bot that can look at the state again.
 */
function record(
  setup: BattleSetup,
  style: Style,
): { actions: BattleAction[]; trace: BattleState[] } {
  const rng = createRng(`replay:${style}:${setup.seed}`);
  let state = createBattle(setup);
  const actions: BattleAction[] = [];
  const trace: BattleState[] = [state];
  let clock = 0;

  for (let guard = 0; guard < 400 && !isOver(state); guard++) {
    // Forward-only, as a real clock is, but by a seeded amount so slow turns,
    // fast turns and crits all occur.
    clock += 120 + rng.int(0, 2600);
    let action: BattleAction;

    if (state.phase === 'catching') {
      if (state.problemShownAt === null) {
        action = { type: 'beginCatch', now: clock };
      } else {
        const right = style === 'mash' ? false : style === 'smart' ? true : rng.next() < 0.7;
        const answer = state.problem!.answer;
        action = { type: 'answer', value: right ? answer : answer + 1, now: clock };
      }
    } else if (state.phase === 'resolving') {
      action = { type: 'continue' };
    } else if (state.phase === 'choosing') {
      const affordable = availableMoves(state).filter((m) => m.affordable);
      const move =
        style === 'smart'
          ? (affordable.find((m) => m.kind === 'special') ??
            affordable.find((m) => m.kind === 'strong') ??
            affordable[0]!)
          : style === 'mash'
            ? (affordable.find((m) => m.kind === 'strong') ?? affordable[0]!)
            : affordable[rng.int(0, affordable.length - 1)]!;
      action = { type: 'chooseMove', moveId: move.id, now: clock };
    } else {
      const right = style === 'mash' ? false : style === 'smart' ? true : rng.next() < 0.65;
      const answer = state.problem!.answer;
      // `timeout` is the only way a turn nobody answered gets resolved, and it
      // is the one action that reads `problemShownAt` back off a snapshot.
      action =
        style === 'mixed' && rng.next() < 0.08
          ? { type: 'timeout', now: clock }
          : { type: 'answer', value: right ? answer : answer + 1, now: clock };
    }

    state = battleReducer(state, action);
    actions.push(action);
    trace.push(state);
  }

  return { actions, trace };
}

/** A small but varied set of fights: both a first battle and a levelled one. */
const CASES: Array<{ name: string; setup: BattleSetup; style: Style }> = [];
for (const style of ['smart', 'mixed', 'mash'] as const) {
  for (const scenario of [
    { name: 'level 3, tier 4', level: 3, tier: 4 },
    { name: 'level 1, tier 1', level: 1, tier: 1 },
  ]) {
    for (const player of [STARTERS[0]!, STARTERS[3]!, STARTERS[7]!]) {
      for (const foe of [STARTERS[1]!, STARTERS[5]!, STARTERS[11]!]) {
        CASES.push({
          name: `${player.id} vs ${foe.id}, ${scenario.name}, ${style}`,
          style,
          setup: {
            seed: `replay:${player.id}-vs-${foe.id}:${scenario.name}`,
            playerCreatureId: player.id,
            foeCreatureId: foe.id,
            playerLevel: scenario.level,
            foeLevel: scenario.level,
            tier: scenario.tier,
          },
        });
      }
    }
  }
}

/**
 * Reports every value in `value` that JSON cannot carry unchanged.
 *
 * Each of these survives `JSON.stringify` by becoming something else rather than
 * by failing loudly, which is what makes it dangerous: `undefined`, functions and
 * symbols vanish from an object, `NaN` and `Infinity` become `null`, `-0` becomes
 * `0`, a `Date` becomes a string that never parses back, a `Map` or `Set` becomes
 * `{}`. A state holding one of these drifts on its first save whether or not the
 * fight under test happens to exercise it.
 */
function unserialisable(value: unknown, path = '', depth = 0): string[] {
  if (depth > 32) return [`${path}: nested deeper than 32 levels`];
  if (value === null) return [];

  const type = typeof value;
  if (type === 'string' || type === 'boolean') return [];
  if (type === 'undefined') return [`${path}: undefined`];
  if (type === 'function') return [`${path}: a function`];
  if (type === 'symbol') return [`${path}: a symbol`];
  if (type === 'bigint') return [`${path}: a bigint`];
  if (type === 'number') {
    const n = value as number;
    if (Number.isNaN(n)) return [`${path}: NaN`];
    if (!Number.isFinite(n)) return [`${path}: Infinity`];
    if (Object.is(n, -0)) return [`${path}: -0`];
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, i) => unserialisable(item, `${path}[${i}]`, depth + 1));
  }
  if (value instanceof Date) return [`${path}: a Date`];
  if (value instanceof Map) return [`${path}: a Map`];
  if (value instanceof Set) return [`${path}: a Set`];

  const proto: unknown = Object.getPrototypeOf(value as object);
  if (proto !== Object.prototype && proto !== null) {
    return [`${path}: a class instance`];
  }
  const record = value as Record<string, unknown>;
  if (typeof record.toJSON === 'function') return [`${path}: an object with its own toJSON`];

  return Object.keys(record).flatMap((key) =>
    unserialisable(record[key], path === '' ? key : `${path}.${key}`, depth + 1),
  );
}

describe('a battle survives being saved mid-fight', () => {
  it.each(CASES)('replays byte-identically from its seed: $name', ({ setup, style }) => {
    const first = record(setup, style);
    const refs = first.trace.map((s) => JSON.stringify(s));
    expect(first.actions.length).toBeGreaterThan(0);

    // The bot itself must be deterministic, or the recording is smuggling in
    // entropy and nothing below proves anything about the engine.
    const again = record(setup, style);
    expect(again.actions).toEqual(first.actions);

    let state = createBattle(setup);
    expect(JSON.stringify(state)).toBe(refs[0]);
    first.actions.forEach((action, i) => {
      state = battleReducer(state, action);
      expect(JSON.stringify(state)).toBe(refs[i + 1]);
    });
  });

  it.each(CASES)(
    'resumes byte-identically from a snapshot at every action index: $name',
    ({ setup, style }) => {
      const { actions, trace } = record(setup, style);
      const refs = trace.map((s) => JSON.stringify(s));

      // Cut at *every* index, including before the first action and after the
      // last. Cutting at one point only proves the engine survives that point.
      for (let cut = 0; cut < refs.length; cut++) {
        const saved = refs[cut]!;
        let state = JSON.parse(saved) as BattleState;
        expect(JSON.stringify(state)).toBe(saved);

        for (let i = cut; i < actions.length; i++) {
          // The action is round-tripped too: a resumed battle's next input
          // arrives as JSON, not as the object that was in memory.
          const action = JSON.parse(JSON.stringify(actions[i])) as BattleAction;
          state = battleReducer(state, action);
          expect(JSON.stringify(state)).toBe(refs[i + 1]);
        }
      }
    },
  );

  it.each(CASES)(
    'never holds a value JSON cannot carry unchanged: $name',
    ({ setup, style }) => {
      const { trace } = record(setup, style);
      for (const state of trace) {
        expect(unserialisable(state)).toEqual([]);
      }
    },
  );
});

describe('the round-trip check itself catches a bad value', () => {
  it('names every kind of value that JSON would silently change', () => {
    const state = createBattle({
      seed: 'guard',
      playerCreatureId: STARTERS[0]!.id,
      foeCreatureId: STARTERS[1]!.id,
      playerLevel: 3,
      foeLevel: 3,
      tier: 4,
    });
    expect(unserialisable(state)).toEqual([]);

    const cases: Array<[string, unknown]> = [
      ['undefined', undefined],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-0', -0],
      ['a function', () => 1],
      ['a Date', new Date(0)],
      ['a Map', new Map()],
      ['a Set', new Set()],
    ];
    for (const [why, value] of cases) {
      const spoiled = { ...state, injected: value } as unknown as BattleState;
      expect(unserialisable(spoiled)).toEqual([`injected: ${why}`]);
    }

    // Nested, too - the log is where a bad value would realistically appear.
    const nested = {
      ...state,
      log: [{ kind: 'foeFaint', turn: Number.NaN }],
    } as unknown as BattleState;
    expect(unserialisable(nested)).toEqual(['log[0].turn: NaN']);
  });
});
