import { describe, expect, it } from 'vitest';
import { GRADIENT_REF, type Shape, drawCreature, flattenShapes, shade } from './art';
import {
  type Aura,
  type Crown,
  CREATURES,
  type Creature,
  type Ears,
  type Pattern,
  type Tail,
  type Texture,
  type Wings,
  getCreature,
} from './creatures';

/**
 * The art used to be written out once per client and hand-ported between them,
 * which made "this creature silently lost its crown" a real and invisible bug -
 * a missing branch draws nothing, and nothing looks like art.
 *
 * Now the geometry is data, so that class of bug is testable directly: give a
 * creature a feature, and assert more shapes come out than without it.
 */

function withArt(base: Creature, art: Partial<Creature['art']>): Creature {
  return { ...base, art: { ...base.art, ...art } };
}

/** Every leaf shape a creature draws. */
function leaves(creature: Creature): Shape[] {
  return flattenShapes(drawCreature(creature).shapes);
}

const SAMPLE = getCreature('cindik');

describe('drawCreature', () => {
  it('draws every creature in the roster', () => {
    for (const creature of CREATURES) {
      const drawing = drawCreature(creature);
      expect(drawing.viewBox).toBe('0 0 100 100');
      // A creature that renders to nothing would be an invisible fighter.
      expect(leaves(creature).length).toBeGreaterThan(10);
    }
  });

  it('references only gradients it also defines', () => {
    for (const creature of CREATURES) {
      const drawing = drawCreature(creature);
      const defined = new Set(drawing.gradients.map((g) => g.id));

      for (const shape of flattenShapes(drawing.shapes)) {
        if (shape.kind === 'group') continue;
        for (const value of [shape.fill, shape.stroke]) {
          if (value?.startsWith(GRADIENT_REF)) {
            expect(defined).toContain(value.slice(GRADIENT_REF.length));
          }
        }
      }
    }
  });

  it('gives each creature its own gradient ids, so two on screen cannot collide', () => {
    // Both fighters are rendered into the same document during a battle, and
    // SVG gradient ids are global to it.
    const seen = new Set<string>();
    for (const creature of CREATURES) {
      for (const gradient of drawCreature(creature).gradients) {
        expect(seen.has(gradient.id), `duplicate gradient id ${gradient.id}`).toBe(false);
        seen.add(gradient.id);
      }
    }
  });

  it('emits only finite numbers, because NaN in a path silently drops the shape', () => {
    for (const creature of CREATURES) {
      for (const shape of leaves(creature)) {
        for (const [key, value] of Object.entries(shape)) {
          if (typeof value === 'number') {
            expect(Number.isFinite(value), `${creature.id}.${key} is ${value}`).toBe(true);
          }
        }
        if (shape.kind === 'path') {
          expect(shape.d, `${creature.id} has NaN in a path`).not.toMatch(/NaN|undefined/);
        }
      }
    }
  });
});

describe('every art feature actually draws something', () => {
  const crowns: Crown[] = [
    'flame',
    'leaf',
    'crystal',
    'bolt',
    'rock',
    'fin',
    'horn',
    'antler',
    'plume',
  ];
  const tails: Tail[] = ['puff', 'blade', 'curl', 'spark', 'fan', 'lash'];
  const patterns: Pattern[] = ['spots', 'stripes', 'belly', 'plates', 'swirl'];
  const textures: Texture[] = ['fur', 'scales', 'crystal', 'rocky'];
  const earStyles: Ears[] = ['round', 'pointed', 'long', 'frill'];
  const wingStyles: Wings[] = ['membrane', 'feather', 'insect'];
  const auras: Aura[] = ['embers', 'frost', 'leaves', 'dust', 'sparks', 'bubbles'];

  const bare = leaves(
    withArt(SAMPLE, {
      crown: 'none',
      tail: 'none',
      pattern: 'none',
      texture: 'smooth',
      ears: 'none',
      wings: 'none',
      aura: 'none',
    }),
  ).length;

  it.each(crowns)('draws the %s crown', (crown) => {
    expect(
      leaves(
        withArt(SAMPLE, {
          crown,
          tail: 'none',
          pattern: 'none',
          texture: 'smooth',
          ears: 'none',
          wings: 'none',
          aura: 'none',
        }),
      ).length,
    ).toBeGreaterThan(bare);
  });

  it.each(tails)('draws the %s tail', (tail) => {
    expect(
      leaves(
        withArt(SAMPLE, {
          crown: 'none',
          tail,
          pattern: 'none',
          texture: 'smooth',
          ears: 'none',
          wings: 'none',
          aura: 'none',
        }),
      ).length,
    ).toBeGreaterThan(bare);
  });

  it.each(patterns)('draws the %s pattern', (pattern) => {
    expect(
      leaves(
        withArt(SAMPLE, {
          crown: 'none',
          tail: 'none',
          pattern,
          texture: 'smooth',
          ears: 'none',
          wings: 'none',
          aura: 'none',
        }),
      ).length,
    ).toBeGreaterThan(bare);
  });

  it.each(textures)('draws the %s texture', (texture) => {
    expect(
      leaves(
        withArt(SAMPLE, {
          crown: 'none',
          tail: 'none',
          pattern: 'none',
          texture,
          ears: 'none',
          wings: 'none',
          aura: 'none',
        }),
      ).length,
    ).toBeGreaterThan(bare);
  });

  it.each(earStyles)('draws %s ears', (ears) => {
    expect(
      leaves(
        withArt(SAMPLE, {
          crown: 'none',
          tail: 'none',
          pattern: 'none',
          texture: 'smooth',
          ears,
          wings: 'none',
          aura: 'none',
        }),
      ).length,
    ).toBeGreaterThan(bare);
  });

  it.each(wingStyles)('draws %s wings', (wings) => {
    expect(
      leaves(
        withArt(SAMPLE, {
          crown: 'none',
          tail: 'none',
          pattern: 'none',
          texture: 'smooth',
          ears: 'none',
          wings,
          aura: 'none',
        }),
      ).length,
    ).toBeGreaterThan(bare);
  });

  it.each(auras)('draws the %s aura', (aura) => {
    expect(
      leaves(
        withArt(SAMPLE, {
          crown: 'none',
          tail: 'none',
          pattern: 'none',
          texture: 'smooth',
          ears: 'none',
          wings: 'none',
          aura,
        }),
      ).length,
    ).toBeGreaterThan(bare);
  });

  it('draws every body shape the roster uses', () => {
    for (const shape of new Set(CREATURES.map((c) => c.art.shape))) {
      expect(leaves(withArt(SAMPLE, { shape })).length, `${shape} draws nothing`).toBeGreaterThan(
        10,
      );
    }
  });

  it('draws every eye style the roster uses', () => {
    for (const eyes of new Set(CREATURES.map((c) => c.art.eyes))) {
      expect(leaves(withArt(SAMPLE, { eyes })).length, `${eyes} draws nothing`).toBeGreaterThan(10);
    }
  });

  it('reserves auras for final forms, so evolving is visibly a promotion', () => {
    for (const creature of CREATURES) {
      if (creature.art.aura !== 'none') expect(creature.stage).toBe(3);
    }
  });
});

describe('silhouette mode', () => {
  /**
   * An earlier version of this test only inspected the gradients, and passed
   * while every un-caught album slot was still showing its creature's exact
   * colours through its crown, ears and tail - those paint straight from the
   * palette and never touch a gradient. The album is meant to tell a child that
   * something is missing without telling him what it is.
   */
  it('leaks no palette colour anywhere, not in a gradient and not in a fill', () => {
    for (const creature of CREATURES) {
      const drawing = drawCreature(creature, { silhouette: true });
      const palette = [creature.art.primary, creature.art.secondary, creature.art.accent].map((c) =>
        c.toLowerCase(),
      );

      const used = [
        ...drawing.gradients.flatMap((g) => g.stops.map((s) => s.color)),
        ...flattenShapes(drawing.shapes).flatMap((s) =>
          s.kind === 'group' ? [] : [s.fill, s.stroke],
        ),
      ]
        .filter((c): c is string => typeof c === 'string')
        .map((c) => c.toLowerCase());

      for (const colour of palette) {
        expect(used, `${creature.id} leaks ${colour} while silhouetted`).not.toContain(colour);
      }
    }
  });

  it('still draws a recognisable body', () => {
    const drawing = drawCreature(getCreature('pyrolith'), { silhouette: true });
    expect(flattenShapes(drawing.shapes).length).toBeGreaterThan(10);
  });
});

describe('shade', () => {
  it('darkens towards black and lightens towards white', () => {
    expect(shade('#808080', -1)).toBe('#000000');
    expect(shade('#808080', 1)).toBe('#ffffff');
    expect(shade('#808080', 0)).toBe('#808080');
  });

  it('expands three-digit hex', () => {
    expect(shade('#fff', 0)).toBe('#ffffff');
  });

  it('returns the input unchanged rather than throwing on nonsense', () => {
    // Palettes come from data, and a bad colour should mean a plain creature,
    // never a crash mid-battle.
    expect(shade('not-a-colour', -0.5)).toBe('not-a-colour');
  });
});
