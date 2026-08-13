import { describe, expect, it } from 'vitest';
import { CREATURES, ELEMENTS, type Shape, drawCreature } from '../engine';
import { groupByElement } from './Album';

/**
 * The album screen: what it groups, and what that costs to draw.
 *
 * Two separate risks live here, and neither is covered by the engine tests at
 * the repository root.
 *
 * **Completeness.** The roster doubled to 36. The web client groups the album
 * under one header per element; this client rendered a flat wall of 36, which a
 * seven-year-old cannot read. Grouping is the fix, but a grouping function is
 * exactly the kind of code that quietly drops or duplicates a row — and a
 * missing creature in an album looks identical to one you have not caught yet.
 * So the test walks the real function the screen calls, not a copy of it.
 *
 * That the *screen* draws what this function returns is the other half, and it
 * lives in `Album.test.tsx`, which mounts it. This file used to check that by
 * reading `Album.tsx` as text and looking for the words `groupByElement` and
 * `CREATURES.map(` — a test that could not tell a rendered grouping from a
 * mentioned one, and which a rename would have broken while the screen stayed
 * correct. It was a stand-in for having no renderer; there is one now.
 *
 * **Cost.** Every cell is an SVG built from `drawCreature`, and `art.ts` now
 * emits gradients, a rim shadow, an outline, texture, ears, wings and an aura.
 * 36 of those on one scrolling screen is the sort of thing that is fine until
 * it suddenly is not, and nobody notices which art feature pushed it over. The
 * bound below is a tripwire on that, measured rather than guessed.
 */

/**
 * SVG nodes one `CreatureArt` mounts, counted the way the renderer builds it:
 * the root `<Svg>` and its `<Defs>`, one node per gradient and per gradient
 * stop, then every shape — groups included, since a `<G>` is a node too and the
 * roster nests most of its geometry inside them.
 */
function nodeCount(creature: (typeof CREATURES)[number], silhouette: boolean): number {
  const walk = (shapes: readonly Shape[]): number =>
    shapes.reduce(
      (total, shape) => total + 1 + (shape.kind === 'group' ? walk(shape.children) : 0),
      0,
    );

  const drawing = drawCreature(creature, { silhouette });
  const stops = drawing.gradients.reduce((total, gradient) => total + gradient.stops.length, 0);
  return 2 + drawing.gradients.length + stops + walk(drawing.shapes);
}

/**
 * Budget, per creature, for one album cell.
 *
 * Measured worst case today is 86 nodes (`thornmoss`, a stage-3 with wings, an
 * aura and texture); the roster mean is 46. 120 leaves a stage-3 room to grow
 * by another 40% — a new crown or a tail lands well inside it — while still
 * catching an art feature that doubles a creature. Deliberately per-creature
 * rather than only on the total, because one runaway creature is the failure
 * mode worth naming: the total would absorb it and the profiler would not.
 */
const PER_CREATURE_BUDGET = 120;

/** 36 cells at the per-creature budget, allowing no creature to hide in the mean. */
const ALBUM_BUDGET = PER_CREATURE_BUDGET * CREATURES.length;

describe('the album groups the whole roster by element', () => {
  it('orders the groups the way the element wheel does', () => {
    // Same order as the web album, which maps ELEMENTS directly. A child who
    // learns where frost sits should find it in the same place on both clients.
    expect(groupByElement(CREATURES).map((group) => group.element)).toEqual([...ELEMENTS]);
  });

  it('accounts for every creature exactly once', () => {
    const listed = groupByElement(CREATURES).flatMap((group) => group.creatures.map((c) => c.id));

    expect(listed).toHaveLength(CREATURES.length);
    expect(new Set(listed).size).toBe(CREATURES.length);
    expect([...listed].sort()).toEqual(CREATURES.map((c) => c.id).sort());
  });

  it('files each creature under its own element', () => {
    for (const group of groupByElement(CREATURES)) {
      for (const creature of group.creatures) {
        expect(creature.element, `${creature.id} is filed under ${group.element}`).toBe(
          group.element,
        );
      }
    }
  });

  it('keeps roster order inside a group, so an evolution line reads root-first', () => {
    for (const group of groupByElement(CREATURES)) {
      const rosterOrder = CREATURES.filter((c) => c.element === group.element).map((c) => c.id);
      expect(group.creatures.map((c) => c.id)).toEqual(rosterOrder);
    }
  });

  it('is stable: the same input gives the same grouping every call', () => {
    const shape = (groups: ReturnType<typeof groupByElement>) =>
      groups.map((g) => [g.element, g.creatures.map((c) => c.id)]);

    expect(shape(groupByElement(CREATURES))).toEqual(shape(groupByElement(CREATURES)));
  });

  it('does not invent an empty header for an element it was given nothing of', () => {
    const emberOnly = CREATURES.filter((c) => c.element === 'ember');
    const groups = groupByElement(emberOnly);

    expect(groups.map((g) => g.element)).toEqual(['ember']);
    expect(groups[0]?.creatures).toHaveLength(emberOnly.length);
  });
});

describe('what a full album costs to draw', () => {
  it('keeps every creature inside its node budget', () => {
    for (const creature of CREATURES) {
      // Both states are on screen at once: caught cells and silhouettes.
      const worst = Math.max(nodeCount(creature, false), nodeCount(creature, true));
      expect(worst, `${creature.id} draws ${worst} SVG nodes`).toBeLessThanOrEqual(
        PER_CREATURE_BUDGET,
      );
    }
  });

  it('keeps the whole album inside its budget', () => {
    const total = CREATURES.reduce((sum, creature) => sum + nodeCount(creature, false), 0);
    expect(total, `the full album draws ${total} SVG nodes`).toBeLessThanOrEqual(ALBUM_BUDGET);
  });

  it('counts nested shapes, not just the top level', () => {
    // Most of the roster's geometry lives inside groups. A counter that only
    // measured `drawing.shapes.length` would report 2 for a creature that draws
    // 86 nodes, and this whole budget would be theatre.
    const drawn = drawCreature(CREATURES[0]!);
    expect(nodeCount(CREATURES[0]!, false)).toBeGreaterThan(drawn.shapes.length);
  });
});
