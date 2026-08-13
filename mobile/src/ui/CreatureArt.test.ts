import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CREATURES, type Shape, drawCreature } from '../engine';

/**
 * Guards the seam between the shared drawing model and this client's renderer.
 *
 * The geometry itself is tested in `src/lib/game/art.test.ts` at the repository
 * root, and both clients now draw from it - so "this creature lost its crown on
 * iOS only" is no longer possible by construction.
 *
 * What is still possible, and is what this file checks: the engine emits a
 * primitive kind that the react-native-svg renderer has no branch for. That
 * renders as nothing, and nothing looks like art rather than a bug.
 */

const source = readFileSync(new URL('./CreatureArt.tsx', import.meta.url), 'utf8');

/** Every distinct primitive kind the whole roster actually produces. */
function kindsUsed(): Set<string> {
  const kinds = new Set<string>();
  const walk = (shapes: readonly Shape[]) => {
    for (const shape of shapes) {
      kinds.add(shape.kind);
      if (shape.kind === 'group') walk(shape.children);
    }
  };
  for (const creature of CREATURES) walk(drawCreature(creature).shapes);
  return kinds;
}

describe('the iOS renderer covers the drawing model', () => {
  it('has a branch for every primitive the roster emits', () => {
    const kinds = kindsUsed();
    expect(kinds.size).toBeGreaterThan(2);

    for (const kind of kinds) {
      expect(source, `no case renders a '${kind}'`).toContain(`case '${kind}':`);
    }
  });

  it('draws from the shared model rather than its own geometry', () => {
    // A path literal here would mean the geometry had started to fork again,
    // which is exactly what moving it into the engine was meant to end.
    expect(source).toContain('drawCreature');
    expect(source, 'a hardcoded path has crept back in').not.toMatch(/d="M\d/);
  });

  it('resolves gradient references rather than passing them through as fills', () => {
    // `grad:mm-cindik-body` is not a colour; handing it to SVG unresolved makes
    // every creature render black.
    expect(source).toContain('GRADIENT_REF');
    expect(source).toContain('url(#');
  });

  it('renders every creature to a non-trivial shape list', () => {
    for (const creature of CREATURES) {
      const drawing = drawCreature(creature);
      expect(drawing.gradients.length).toBeGreaterThan(0);
      expect(drawing.shapes.length).toBeGreaterThan(0);
    }
  });
});
