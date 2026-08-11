import type { Element } from './elements';

/**
 * Moves.
 *
 * Every creature gets the same four-slot kit, re-skinned to its element. That
 * is a deliberate choice: the player is seven, and a fixed kit means the
 * decision each turn is always the interesting one - "which of these four,
 * given the matchup and my charge?" - rather than "what does this creature
 * even do?". Chess has six piece types, not sixty.
 */

export type MoveKind = 'quick' | 'strong' | 'special' | 'mend';

export type Move = {
  id: string;
  kind: MoveKind;
  name: { en: string; zh: string };
  /** Damage coefficient. `mend` uses it as a heal percentage instead. */
  power: number;
  /** Shifts the maths problem relative to the player's current tier. */
  tierOffset: number;
  /** Charge points spent to use it. Charge is earned by answering correctly. */
  chargeCost: number;
  description: { en: string; zh: string };
};

export const MAX_CHARGE = 3;

/** Charge earned for a correct answer. */
export const CHARGE_PER_CORRECT = 1;

const ELEMENT_MOVE_NAMES: Record<
  Element,
  {
    quick: { en: string; zh: string };
    strong: { en: string; zh: string };
    special: { en: string; zh: string };
  }
> = {
  ember: {
    quick: { en: 'Cinder Flick', zh: '火星弹' },
    strong: { en: 'Flame Burst', zh: '烈焰爆' },
    special: { en: 'Inferno Nova', zh: '炎爆新星' },
  },
  frost: {
    quick: { en: 'Frost Nip', zh: '霜咬' },
    strong: { en: 'Ice Shard', zh: '冰锥' },
    special: { en: 'Blizzard Crash', zh: '暴风雪' },
  },
  leaf: {
    quick: { en: 'Leaf Slap', zh: '叶击' },
    strong: { en: 'Vine Whip', zh: '藤鞭' },
    special: { en: 'Bloom Surge', zh: '花海冲击' },
  },
  stone: {
    quick: { en: 'Pebble Toss', zh: '投石' },
    strong: { en: 'Rock Slam', zh: '岩石猛击' },
    special: { en: 'Boulder Quake', zh: '巨岩震' },
  },
  spark: {
    quick: { en: 'Static Zap', zh: '静电击' },
    strong: { en: 'Thunder Jolt', zh: '雷击' },
    special: { en: 'Storm Overload', zh: '风暴超载' },
  },
  aqua: {
    quick: { en: 'Bubble Pop', zh: '泡沫弹' },
    strong: { en: 'Wave Crash', zh: '浪涛冲击' },
    special: { en: 'Tidal Fury', zh: '怒潮' },
  },
};

/** The four moves available to a creature of this element. */
export function movesFor(element: Element): Move[] {
  const names = ELEMENT_MOVE_NAMES[element];
  return [
    {
      id: `${element}-quick`,
      kind: 'quick',
      name: names.quick,
      power: 9,
      tierOffset: -1,
      chargeCost: 0,
      description: { en: 'Easy question, small hit.', zh: '简单题目，小伤害。' },
    },
    {
      id: `${element}-strong`,
      kind: 'strong',
      name: names.strong,
      power: 16,
      tierOffset: 1,
      chargeCost: 0,
      description: { en: 'Harder question, big hit.', zh: '较难题目，高伤害。' },
    },
    {
      id: `${element}-special`,
      kind: 'special',
      name: names.special,
      power: 30,
      tierOffset: 2,
      chargeCost: MAX_CHARGE,
      description: { en: 'Costs full charge. Huge hit.', zh: '消耗全部能量，超高伤害。' },
    },
    {
      id: 'mend',
      kind: 'mend',
      // Mend is element-neutral, so it keeps one name everywhere.
      name: { en: 'Mend', zh: '治疗' },
      power: 30, // percent of max HP restored
      tierOffset: 0,
      chargeCost: 2,
      description: { en: 'Costs 2 charge. Heals you.', zh: '消耗2点能量，恢复体力。' },
    },
  ];
}

export function findMove(element: Element, moveId: string): Move | undefined {
  return movesFor(element).find((m) => m.id === moveId);
}
