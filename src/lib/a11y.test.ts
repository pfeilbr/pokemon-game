import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The tap-target floor, asserted against the stylesheet itself.
 *
 * `CLAUDE.md` says "Every tap target is at least 56px (`tap` utility)". The
 * player is seven and his aim is worse than an adult's, so the number is a
 * usability floor rather than a style preference - which is exactly why nobody
 * would think to check it after shrinking a utility to make a header fit.
 *
 * These tests parse `globals.css` rather than restating the value. A test that
 * hardcoded `3.5rem` would keep passing while the real utility shrank, which is
 * the failure it is supposed to catch. `scripts/audit_a11y.py` reads the same
 * declaration for the same reason: one source of truth, checked from both ends.
 */

const MINIMUM_TAP_PX = 56;

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

/** `3.5rem` -> 56, `56px` -> 56. Anything else is a value we refuse to guess at. */
function toPx(value: string): number {
  const match = /^([0-9]*\.?[0-9]+)(px|rem|em)?$/.exec(value.trim());
  expect(match, `cannot interpret the length ${value}`).not.toBeNull();
  const size = Number(match![1]);
  const unit = match![2] ?? 'px';
  return unit === 'px' ? size : size * 16;
}

function utilityBody(name: string): string {
  const match = new RegExp(`@utility\\s+${name}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `no \`@utility ${name}\` block in globals.css`).not.toBeNull();
  return match![1]!;
}

function declaration(body: string, property: string): string {
  const match = new RegExp(`(?:^|;|\\{)\\s*${property}\\s*:\\s*([^;]+);`).exec(body);
  expect(match, `the \`tap\` utility declares no ${property}`).not.toBeNull();
  return match![1]!;
}

describe('the tap utility', () => {
  it('exists', () => {
    expect(css).toMatch(/@utility\s+tap\s*\{/);
  });

  it('is at least 56px tall', () => {
    expect(toPx(declaration(utilityBody('tap'), 'min-height'))).toBeGreaterThanOrEqual(
      MINIMUM_TAP_PX,
    );
  });

  it('is at least 56px wide', () => {
    // A 56px-tall sliver is still a target a child misses sideways.
    expect(toPx(declaration(utilityBody('tap'), 'min-width'))).toBeGreaterThanOrEqual(
      MINIMUM_TAP_PX,
    );
  });
});

describe('reduced motion', () => {
  /**
   * The whole web client leans on this one block - no component checks
   * `prefers-reduced-motion` itself, which is only safe while the global rule
   * exists and still neutralises both kinds of movement. The iOS client has no
   * equivalent, which is why `mobile/src/screens/BattleScreen.tsx` asks
   * `AccessibilityInfo` directly.
   */
  it('is honoured globally, for animations and transitions alike', () => {
    const match = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
    expect(match, 'no global prefers-reduced-motion block in globals.css').not.toBeNull();
    expect(match![1]).toMatch(/animation-duration\s*:/);
    expect(match![1]).toMatch(/transition-duration\s*:/);
  });
});
