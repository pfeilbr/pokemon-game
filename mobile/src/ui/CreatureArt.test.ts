import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CREATURES } from '../engine';

/**
 * Guards the hand-port of the art renderer.
 *
 * `CreatureArt.tsx` was translated from the web client's SVG component by hand,
 * switch statement by switch statement. The failure mode that worries me is not
 * a crash - it is a creature quietly losing its crown or its tail because the
 * roster uses a spec value the port has no `case` for, which renders as `null`
 * and looks like art rather than a bug.
 *
 * So: every spec value any creature actually uses must have a branch here.
 */

const source = readFileSync(new URL('./CreatureArt.tsx', import.meta.url), 'utf8');

/** Spec fields drawn by a switch, and therefore at risk of a missing case. */
const SWITCHED_FIELDS = ['crown', 'tail', 'pattern', 'shape'] as const;

describe('creature art port', () => {
  it.each(SWITCHED_FIELDS)('draws every %s the roster uses', (field) => {
    const used = new Set(CREATURES.map((c) => c.art[field]));
    expect(used.size).toBeGreaterThan(0);

    for (const value of used) {
      // 'none' is the deliberate no-op: no crown, no tail, nothing to draw.
      if (value === 'none') continue;
      expect(source, `no branch draws ${field}="${value}"`).toMatch(new RegExp(`case '${value}':`));
    }
  });

  /**
   * Eyes are the one field not drawn by a switch. Both renderers special-case
   * three styles and let 'big' fall through to the ordinary round eye, so
   * asserting a `case` for every value - as an earlier version of this test did
   * - fails on a value that is correctly handled. Assert the actual shape.
   */
  it('special-cases the three distinctive eye styles and defaults the rest', () => {
    for (const style of ['sleepy', 'star', 'fierce']) {
      expect(source, `no branch draws eyes="${style}"`).toContain(`=== '${style}'`);
    }

    const defaulted = [...new Set(CREATURES.map((c) => c.art.eyes))].filter(
      (style) => !['sleepy', 'star', 'fierce'].includes(style),
    );
    // If a new eye style is added to the roster it lands here, which is the
    // signal to give it a branch rather than let it silently render as 'big'.
    expect(defaulted).toEqual(['big']);
  });

  it('handles every body shape in the arm-placement table', () => {
    // A missing entry here is a TypeScript error, but the table is indexed at
    // runtime by a value that came from data, so assert it covers the roster.
    const table = source.match(/BODY_HALF_WIDTH[^}]+}/s)?.[0] ?? '';
    for (const shape of new Set(CREATURES.map((c) => c.art.shape))) {
      expect(table, `BODY_HALF_WIDTH has no ${shape}`).toContain(`${shape}:`);
    }
  });

  it('keeps the same viewBox as the web renderer, so the geometry transfers', () => {
    expect(source).toContain('viewBox="0 0 100 100"');
  });
});
