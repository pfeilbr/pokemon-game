import { describe, expect, it } from 'vitest';
import { TAP, colors, mix, space, tint } from './theme';

/**
 * The iOS half of the tap-target rule.
 *
 * `CLAUDE.md` fixes the minimum at 56px on the web (`@utility tap`); `TAP` is
 * how the same rule is spelled here, and `scripts/audit_a11y.py` measures every
 * `Pressable` against it. If `TAP` ever drifted down to Apple's 44pt guidance
 * the audit would keep passing while every button quietly shrank, so the floor
 * is asserted rather than assumed.
 */

const MINIMUM_TAP_PX = 56;

describe('TAP', () => {
  it('is at least the 56px the web client uses', () => {
    expect(TAP).toBeGreaterThanOrEqual(MINIMUM_TAP_PX);
  });

  it('is a whole number of points, so styles do not land on a half pixel', () => {
    expect(Number.isInteger(TAP)).toBe(true);
  });
});

describe('spacing tokens', () => {
  it('ascends, so `space.sm` is never bigger than `space.lg`', () => {
    const order = [space.xs, space.sm, space.md, space.lg, space.xl];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('tint', () => {
  it('appends a two-digit alpha channel', () => {
    expect(tint('#ff6b35', 1)).toBe('#ff6b35ff');
    expect(tint('#ff6b35', 0)).toBe('#ff6b3500');
    expect(tint('#ff6b35', 0.5)).toBe('#ff6b3580');
  });

  it('clamps rather than emitting a malformed colour', () => {
    // A style with `#ff6b35ff0` renders as nothing on iOS, silently.
    expect(tint('#ff6b35', 5)).toHaveLength(9);
    expect(tint('#ff6b35', -3)).toHaveLength(9);
  });
});

/**
 * `mix` exists so a surface built from an element colour is the *same* colour
 * wherever it is dropped. `tint` cannot do that: it hands back an alpha, and an
 * alpha takes its lightness from whatever is behind it. An element chip writes
 * its label in the very colour doing the tinting, so a translucent chip's
 * contrast moved with the card underneath it - which is what
 * `mobile/scripts/audit_contrast_ios.py` measured at 4.39:1 on one screen and
 * 2.95:1 on another. The opacity is the property under test here; the ratios
 * are the audit's job.
 */
describe('mix', () => {
  it('returns an opaque #rrggbb, never an alpha', () => {
    const mixed = mix('#ff6b35', 0.12, colors.bg);
    expect(mixed).toMatch(/^#[0-9a-f]{6}$/);
    expect(mixed).toHaveLength(7);
  });

  it('is the same colour whatever it is drawn on, which tint is not', () => {
    // The point of the fix, stated as a property: one call, one answer.
    expect(mix('#b08968', 0.12, colors.bg)).toBe(mix('#b08968', 0.12, colors.bg));
    expect(mix('#b08968', 0.12, colors.bg)).not.toBe(mix('#b08968', 0.12, colors.panel));
  });

  it('weight 0 is the base and weight 1 is the colour itself', () => {
    expect(mix('#ff6b35', 0, colors.bg)).toBe(colors.bg);
    expect(mix('#ff6b35', 1, colors.bg)).toBe('#ff6b35');
  });

  it('clamps rather than emitting a malformed colour', () => {
    expect(mix('#ff6b35', 5, colors.bg)).toBe('#ff6b35');
    expect(mix('#ff6b35', -3, colors.bg)).toBe(colors.bg);
  });
});
