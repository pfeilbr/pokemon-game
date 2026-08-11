/**
 * Seeded pseudo-random number generator.
 *
 * The whole game engine is deterministic: given a seed, a battle replays
 * identically. That keeps tests exact (no flaky "sometimes it crits") and lets
 * the daily challenge hand every player the same fight.
 *
 * mulberry32 - tiny, fast, and statistically fine for a kids' game.
 */

export type Rng = {
  /** Next float in [0, 1). Advances the stream. */
  next(): number;
  /** Next integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Uniform pick. Throws on an empty list so a bad table fails loudly. */
  pick<T>(items: readonly T[]): T;
  /** Weighted pick. Weights must be non-negative and sum above zero. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  /** Fisher-Yates copy. */
  shuffle<T>(items: readonly T[]): T[];
  /** Current internal state, so a battle can be serialised mid-fight. */
  state(): number;
};

/** Turns an arbitrary string into a 32-bit seed (xfnv1a). */
export function hashSeed(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function createRng(seed: number | string): Rng {
  let a = (typeof seed === 'string' ? hashSeed(seed) : seed >>> 0) || 1;

  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number => {
    if (max < min) throw new Error(`rng.int: max (${max}) < min (${min})`);
    return min + Math.floor(next() * (max - min + 1));
  };

  return {
    next,
    int,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error('rng.pick: empty list');
      return items[int(0, items.length - 1)]!;
    },
    weighted<T>(items: readonly T[], weights: readonly number[]): T {
      if (items.length === 0) throw new Error('rng.weighted: empty list');
      if (items.length !== weights.length) {
        throw new Error(`rng.weighted: ${items.length} items vs ${weights.length} weights`);
      }
      let total = 0;
      for (const w of weights) {
        if (w < 0) throw new Error('rng.weighted: negative weight');
        total += w;
      }
      if (total <= 0) throw new Error('rng.weighted: weights sum to zero');

      let roll = next() * total;
      for (let i = 0; i < items.length; i++) {
        roll -= weights[i]!;
        if (roll < 0) return items[i]!;
      }
      return items[items.length - 1]!;
    },
    shuffle<T>(items: readonly T[]): T[] {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(0, i);
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
    state: () => a,
  };
}
