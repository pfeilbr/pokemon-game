/**
 * The element wheel.
 *
 * Six elements arranged in a cycle. Each one is strong against the next two
 * and weak to the previous two, which leaves exactly one neutral opponent
 * apiece. That is perfectly symmetric - no element is secretly the best - so
 * matchups are a real strategy puzzle rather than a memory-of-trivia contest.
 * The in-game chart shows the whole wheel, because the fun is in planning the
 * counter, not in guessing it.
 */

export const ELEMENTS = ['ember', 'frost', 'leaf', 'stone', 'spark', 'aqua'] as const;

export type Element = (typeof ELEMENTS)[number];

export const SUPER_EFFECTIVE = 2;
export const NOT_VERY_EFFECTIVE = 0.5;
export const NEUTRAL = 1;

/** Position in the cycle. ember -> frost -> leaf -> stone -> spark -> aqua -> ember */
const ORDER: Record<Element, number> = {
  ember: 0,
  frost: 1,
  leaf: 2,
  stone: 3,
  spark: 4,
  aqua: 5,
};

/**
 * Damage multiplier when `attacker` hits `defender`.
 *
 * Distance around the cycle decides it: +1 and +2 are super effective,
 * -1 and -2 are resisted, and the element directly opposite is neutral.
 */
export function effectiveness(attacker: Element, defender: Element): number {
  const delta = (ORDER[defender] - ORDER[attacker] + ELEMENTS.length) % ELEMENTS.length;
  if (delta === 1 || delta === 2) return SUPER_EFFECTIVE;
  if (delta === 4 || delta === 5) return NOT_VERY_EFFECTIVE;
  return NEUTRAL; // delta 0 (mirror) or 3 (opposite)
}

/** The two elements this one hits hard. Used by the in-game type chart. */
export function strongAgainst(element: Element): Element[] {
  return ELEMENTS.filter((other) => effectiveness(element, other) === SUPER_EFFECTIVE);
}

/** The two elements that hit this one hard. */
export function weakTo(element: Element): Element[] {
  return ELEMENTS.filter((other) => effectiveness(other, element) === SUPER_EFFECTIVE);
}

export type ElementStyle = {
  /** Tailwind-facing hex, mirrored in globals.css tokens. */
  color: string;
  /** Deeper shade for gradients and shadows. */
  deep: string;
  label: { en: string; zh: string };
  icon: string;
};

export const ELEMENT_STYLE: Record<Element, ElementStyle> = {
  ember: { color: '#ff6b35', deep: '#9c2f0c', label: { en: 'Ember', zh: '火' }, icon: '🔥' },
  frost: { color: '#8ee3f5', deep: '#2a7c92', label: { en: 'Frost', zh: '冰' }, icon: '❄️' },
  leaf: { color: '#35c46b', deep: '#12703a', label: { en: 'Leaf', zh: '草' }, icon: '🍃' },
  stone: { color: '#b08968', deep: '#6b4f34', label: { en: 'Stone', zh: '岩' }, icon: '🪨' },
  spark: { color: '#ffd23f', deep: '#a67c00', label: { en: 'Spark', zh: '电' }, icon: '⚡' },
  aqua: { color: '#35a7ff', deep: '#0f5c9c', label: { en: 'Aqua', zh: '水' }, icon: '💧' },
};

export function effectivenessLabel(multiplier: number): { en: string; zh: string } | null {
  if (multiplier > NEUTRAL) return { en: 'Super effective!', zh: '效果拔群！' };
  if (multiplier < NEUTRAL) return { en: 'Not very effective…', zh: '效果不佳…' };
  return null;
}
