import { describe, expect, it } from 'vitest';
import { TAP, space, tint } from './theme';

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
