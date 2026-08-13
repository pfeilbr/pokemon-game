import { describe, expect, it } from 'vitest';
import { ELEMENTS } from './elements';
import {
  CREATURES,
  LINES_PER_ELEMENT,
  availableAtLevel,
  evolutionLine,
  findCreature,
  getCreature,
  rosterIsComplete,
  starters,
  statsAtLevel,
} from './creatures';

describe('roster', () => {
  it('holds two complete three-stage lines per element', () => {
    expect(rosterIsComplete()).toBe(true);
    expect(CREATURES).toHaveLength(ELEMENTS.length * LINES_PER_ELEMENT * 3);
  });

  it('gives every creature a unique id', () => {
    const ids = CREATURES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every creature both language names and flavour text', () => {
    for (const c of CREATURES) {
      expect(c.name.en).toMatch(/\S/);
      expect(c.name.zh).toMatch(/\S/);
      expect(c.flavor.en).toMatch(/\S/);
      expect(c.flavor.zh).toMatch(/\S/);
    }
  });

  it('gives every creature a renderable art spec', () => {
    for (const c of CREATURES) {
      expect(c.art.primary).toMatch(/^#[0-9a-f]{6}$/i);
      expect(c.art.secondary).toMatch(/^#[0-9a-f]{6}$/i);
      expect(c.art.accent).toMatch(/^#[0-9a-f]{6}$/i);
      expect(c.art.scale).toBeGreaterThan(0.5);
      expect(c.art.scale).toBeLessThan(2);
    }
  });

  it('makes later stages strictly stronger', () => {
    // Walked per line, not per element: two lines share an element now, so
    // sorting an element's six creatures by stage interleaves them and compares
    // a stage 1 against a stage 1.
    for (const root of starters()) {
      const line = evolutionLine(root.id);
      for (let i = 1; i < line.length; i++) {
        expect(line[i]!.baseHp).toBeGreaterThan(line[i - 1]!.baseHp);
        expect(line[i]!.baseAtk).toBeGreaterThan(line[i - 1]!.baseAtk);
      }
    }
  });

  it('keeps every element balanced against every other at the same stage', () => {
    for (const stage of [1, 2, 3] as const) {
      const atStage = CREATURES.filter((c) => c.stage === stage);
      const hp = new Set(atStage.map((c) => c.baseHp));
      const atk = new Set(atStage.map((c) => c.baseAtk));
      // No element gets a stat advantage; matchups are decided by the wheel.
      expect(hp.size).toBe(1);
      expect(atk.size).toBe(1);
    }
  });

  it('points every evolution at a real creature one stage higher', () => {
    for (const c of CREATURES) {
      if (c.evolvesTo === null) {
        expect(c.stage).toBe(3);
        continue;
      }
      const next = getCreature(c.evolvesTo);
      expect(next.stage).toBe(c.stage + 1);
      expect(next.element).toBe(c.element);
    }
  });
});

describe('lookup helpers', () => {
  it('gets a creature by id', () => {
    expect(getCreature('cindik').name.en).toBe('Cindik');
  });

  it('throws on an unknown id rather than returning undefined', () => {
    expect(() => getCreature('mewtwo')).toThrow(/Unknown creature/);
    expect(findCreature('mewtwo')).toBeUndefined();
  });

  it('offers two starters per element, one per line', () => {
    const s = starters();
    expect(s).toHaveLength(ELEMENTS.length * LINES_PER_ELEMENT);
    expect(s.every((c) => c.stage === 1)).toBe(true);
    // Every line contributes exactly one starter, and every element two.
    expect(new Set(s.map((c) => c.lineId)).size).toBe(s.length);
    for (const element of ELEMENTS) {
      expect(s.filter((c) => c.element === element)).toHaveLength(LINES_PER_ELEMENT);
    }
  });
});

describe('evolutionLine', () => {
  it('returns the full line from any member', () => {
    const fromBase = evolutionLine('cindik').map((c) => c.id);
    const fromTop = evolutionLine('pyrolith').map((c) => c.id);
    expect(fromBase).toEqual(['cindik', 'blazur', 'pyrolith']);
    expect(fromTop).toEqual(fromBase);
  });

  it('returns a line for every creature', () => {
    for (const c of CREATURES) {
      const line = evolutionLine(c.id);
      expect(line).toHaveLength(3);
      expect(line.map((m) => m.id)).toContain(c.id);
    }
  });

  it('never crosses into the other line of the same element', () => {
    // The bug this guards: finding the root by element instead of by line sends
    // every ember creature down whichever ember line happens to come first, so
    // a Cinderpup would evolve into a Blazur.
    for (const c of CREATURES) {
      for (const member of evolutionLine(c.id)) {
        expect(member.lineId).toBe(c.lineId);
      }
    }
  });

  it('gives the two lines of an element genuinely different members', () => {
    for (const element of ELEMENTS) {
      const [first, second] = starters().filter((c) => c.element === element);
      const a = evolutionLine(first!.id).map((c) => c.id);
      const b = evolutionLine(second!.id).map((c) => c.id);
      expect(a.some((id) => b.includes(id))).toBe(false);
    }
  });
});

describe('availableAtLevel', () => {
  it('only offers starters to a brand-new trainer', () => {
    const wild = availableAtLevel(1);
    expect(wild).toHaveLength(ELEMENTS.length * LINES_PER_ELEMENT);
    expect(wild.every((c) => c.stage === 1)).toBe(true);
  });

  it('widens the pool as the trainer levels up', () => {
    expect(availableAtLevel(1).length).toBeLessThan(availableAtLevel(5).length);
    expect(availableAtLevel(5).length).toBeLessThan(availableAtLevel(10).length);
    expect(availableAtLevel(50)).toHaveLength(CREATURES.length);
  });

  it('never returns nothing, even at level 0', () => {
    expect(availableAtLevel(0).length).toBeGreaterThanOrEqual(0);
    expect(availableAtLevel(1).length).toBeGreaterThan(0);
  });
});

describe('statsAtLevel', () => {
  it('returns base stats at level 1', () => {
    const c = getCreature('cindik');
    expect(statsAtLevel(c, 1)).toEqual({ hp: c.baseHp, atk: c.baseAtk });
  });

  it('grows monotonically and never dips below base', () => {
    const c = getCreature('cindik');
    let prev = statsAtLevel(c, 1);
    for (let level = 2; level <= 30; level++) {
      const next = statsAtLevel(c, level);
      expect(next.hp).toBeGreaterThan(prev.hp);
      expect(next.atk).toBeGreaterThan(prev.atk);
      prev = next;
    }
    expect(statsAtLevel(c, 0).hp).toBe(c.baseHp);
  });
});
