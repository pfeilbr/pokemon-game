import { describe, expect, it } from 'vitest';
import { createRng, hashSeed } from './rng';

describe('createRng', () => {
  it('produces the same stream for the same seed', () => {
    const a = Array.from({ length: 20 }, () => createRng(42).next());
    const b = createRng(42);
    expect(a[0]).toBe(b.next());

    const first = Array.from({ length: 20 }, () => createRng(7).next());
    const second = Array.from({ length: 20 }, () => createRng(7).next());
    expect(first).toEqual(second);
  });

  it('produces different streams for different seeds', () => {
    const a = Array.from({ length: 10 }, (_, i) => createRng(1).int(0, 1000) + i * 0);
    const b = Array.from({ length: 10 }, (_, i) => createRng(2).int(0, 1000) + i * 0);
    expect(a[0]).not.toBe(b[0]);
  });

  it('accepts string seeds', () => {
    expect(createRng('daily-2026-08-11').next()).toBe(createRng('daily-2026-08-11').next());
    expect(createRng('a').next()).not.toBe(createRng('b').next());
  });

  it('keeps next() inside [0, 1)', () => {
    const rng = createRng(99);
    for (let i = 0; i < 5000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('keeps int() inside the inclusive range and reaches both ends', () => {
    const rng = createRng(5);
    const seen = new Set<number>();
    for (let i = 0; i < 3000; i++) {
      const v = rng.int(3, 7);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
      seen.add(v);
    }
    expect(seen).toEqual(new Set([3, 4, 5, 6, 7]));
  });

  it('handles a single-value int range', () => {
    expect(createRng(1).int(4, 4)).toBe(4);
  });

  it('throws when int() gets an inverted range', () => {
    expect(() => createRng(1).int(9, 2)).toThrow(/max/);
  });

  it('picks uniformly enough from a list', () => {
    const rng = createRng(11);
    const counts = new Map<string, number>();
    for (let i = 0; i < 6000; i++) {
      const v = rng.pick(['a', 'b', 'c']);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    for (const key of ['a', 'b', 'c']) {
      expect(counts.get(key)!).toBeGreaterThan(1600);
    }
  });

  it('respects weights', () => {
    const rng = createRng(3);
    let heavy = 0;
    for (let i = 0; i < 4000; i++) {
      if (rng.weighted(['heavy', 'light'], [9, 1]) === 'heavy') heavy++;
    }
    expect(heavy / 4000).toBeGreaterThan(0.85);
    expect(heavy / 4000).toBeLessThan(0.95);
  });

  it('never returns a zero-weight option', () => {
    const rng = createRng(3);
    for (let i = 0; i < 500; i++) {
      expect(rng.weighted(['no', 'yes'], [0, 1])).toBe('yes');
    }
  });

  it('rejects malformed inputs loudly', () => {
    const rng = createRng(1);
    expect(() => rng.pick([])).toThrow();
    expect(() => rng.weighted([], [])).toThrow();
    expect(() => rng.weighted(['a'], [1, 2])).toThrow(/weights/);
    expect(() => rng.weighted(['a', 'b'], [0, 0])).toThrow(/zero/);
    expect(() => rng.weighted(['a', 'b'], [-1, 2])).toThrow(/negative/);
  });

  it('shuffles without losing or duplicating items', () => {
    const rng = createRng(21);
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = rng.shuffle(input);
    expect(out).toHaveLength(input.length);
    expect([...out].sort((a, b) => a - b)).toEqual(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // input untouched
  });
});

describe('hashSeed', () => {
  it('is stable and collision-free for our seed shapes', () => {
    expect(hashSeed('abc')).toBe(hashSeed('abc'));
    expect(hashSeed('abc')).not.toBe(hashSeed('abd'));
    expect(hashSeed('')).toBeGreaterThanOrEqual(0);
  });

  it('stays inside uint32', () => {
    for (const s of ['', 'a', 'a very long seed string for the daily challenge 2026-08-11']) {
      const h = hashSeed(s);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});
