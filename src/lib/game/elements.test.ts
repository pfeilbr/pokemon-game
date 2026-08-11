import { describe, expect, it } from 'vitest';
import {
  ELEMENTS,
  ELEMENT_STYLE,
  NEUTRAL,
  NOT_VERY_EFFECTIVE,
  SUPER_EFFECTIVE,
  effectiveness,
  effectivenessLabel,
  strongAgainst,
  weakTo,
} from './elements';

describe('element wheel', () => {
  it('is neutral against itself', () => {
    for (const e of ELEMENTS) {
      expect(effectiveness(e, e)).toBe(NEUTRAL);
    }
  });

  it('gives every element exactly two strengths and two weaknesses', () => {
    for (const e of ELEMENTS) {
      expect(strongAgainst(e)).toHaveLength(2);
      expect(weakTo(e)).toHaveLength(2);
    }
  });

  it('is perfectly balanced - no element has a better overall matchup spread', () => {
    for (const attacker of ELEMENTS) {
      const total = ELEMENTS.reduce((sum, defender) => sum + effectiveness(attacker, defender), 0);
      // 2 + 2 + 1 + 1 + 0.5 + 0.5
      expect(total).toBe(7);
    }
  });

  it('mirrors strength and weakness', () => {
    for (const a of ELEMENTS) {
      for (const b of strongAgainst(a)) {
        expect(weakTo(b)).toContain(a);
        expect(effectiveness(b, a)).toBe(NOT_VERY_EFFECTIVE);
      }
    }
  });

  it('honours the intuitive matchups a kid will expect', () => {
    expect(effectiveness('aqua', 'ember')).toBe(SUPER_EFFECTIVE); // water douses fire
    expect(effectiveness('ember', 'leaf')).toBe(SUPER_EFFECTIVE); // fire burns plants
    expect(effectiveness('ember', 'frost')).toBe(SUPER_EFFECTIVE); // fire melts ice
    expect(effectiveness('leaf', 'stone')).toBe(SUPER_EFFECTIVE); // roots split rock
    expect(effectiveness('stone', 'spark')).toBe(SUPER_EFFECTIVE); // rock grounds lightning
    expect(effectiveness('spark', 'aqua')).toBe(SUPER_EFFECTIVE); // current through water
  });

  it('leaves exactly one neutral opponent per element', () => {
    for (const e of ELEMENTS) {
      const neutrals = ELEMENTS.filter((o) => o !== e && effectiveness(e, o) === NEUTRAL);
      expect(neutrals).toHaveLength(1);
    }
  });

  it('only ever returns the three known multipliers', () => {
    for (const a of ELEMENTS) {
      for (const b of ELEMENTS) {
        expect([SUPER_EFFECTIVE, NEUTRAL, NOT_VERY_EFFECTIVE]).toContain(effectiveness(a, b));
      }
    }
  });
});

describe('ELEMENT_STYLE', () => {
  it('covers every element with a valid hex colour and both languages', () => {
    for (const e of ELEMENTS) {
      const style = ELEMENT_STYLE[e];
      expect(style.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(style.deep).toMatch(/^#[0-9a-f]{6}$/i);
      expect(style.label.en.length).toBeGreaterThan(0);
      expect(style.label.zh.length).toBeGreaterThan(0);
      expect(style.icon.length).toBeGreaterThan(0);
    }
  });
});

describe('effectivenessLabel', () => {
  it('describes the three outcomes', () => {
    expect(effectivenessLabel(SUPER_EFFECTIVE)?.en).toMatch(/Super/);
    expect(effectivenessLabel(NOT_VERY_EFFECTIVE)?.en).toMatch(/Not very/);
    expect(effectivenessLabel(NEUTRAL)).toBeNull();
  });
});
