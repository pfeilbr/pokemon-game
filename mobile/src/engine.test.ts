import { describe, expect, it } from 'vitest';
import {
  CREATURES,
  ELEMENTS,
  STRINGS,
  createProfile,
  effectiveness,
  generateProblem,
  getCreature,
  movesFor,
  starters,
} from './engine';

/**
 * Guards the seam between the two clients.
 *
 * The engine's own behaviour is covered by the 194 tests at the repository
 * root; what is at risk *here* is the sharing itself - a moved file, a renamed
 * export or a path that resolves on Linux but not through Metro would break
 * the iOS client silently. These assertions fail loudly if the shared surface
 * this app depends on stops existing.
 */
describe('shared engine reaches the iOS client', () => {
  it('exposes the whole roster, not a copy of it', () => {
    expect(CREATURES).toHaveLength(18);
    expect(getCreature('cindik').name.en).toBe('Cindik');
  });

  it('carries both languages, which the client needs for a bilingual player', () => {
    for (const creature of CREATURES) {
      expect(creature.name.en).toMatch(/\S/);
      expect(creature.name.zh).toMatch(/\S/);
    }
    expect(STRINGS.appName.zh).toMatch(/\S/);
  });

  it('generates maths deterministically, so a battle replays the same on both clients', () => {
    const a = generateProblem('shared-seed', 4);
    const b = generateProblem('shared-seed', 4);
    expect(a).toEqual(b);
    expect(Number.isInteger(a.answer)).toBe(true);
    expect(a.answer).toBeGreaterThanOrEqual(0);
  });

  it('keeps the element wheel balanced', () => {
    for (const element of ELEMENTS) {
      const total = ELEMENTS.reduce((sum, other) => sum + effectiveness(element, other), 0);
      expect(total).toBe(7);
    }
  });

  it('offers a move kit per element', () => {
    for (const element of ELEMENTS) {
      expect(movesFor(element)).toHaveLength(4);
    }
  });

  it('creates a profile the backend will accept', () => {
    const profile = createProfile({ trainerName: 'Leo', starterId: starters()[0]!.id });
    expect(profile.version).toBe(1);
    expect(profile.caught.length).toBeGreaterThan(0);
    // The API stores this as jsonb, so it has to survive a round trip.
    expect(JSON.parse(JSON.stringify(profile))).toEqual(profile);
  });

  it('contains no browser or Node APIs that would break under Hermes', async () => {
    // A regression guard for the property that makes sharing possible at all.
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = new URL('../../src/lib/game/', import.meta.url).pathname;
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.includes('.test.'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = readFileSync(dir + file, 'utf8');
      expect(source, `${file} imports a Node builtin`).not.toMatch(/from ['"]node:/);
      // Globals, not member access: a local named `sample` is fine, `window.x`
      // referring to the browser global is not.
      expect(source, `${file} touches the DOM`).not.toMatch(
        /(?:^|[^.\w])(?:document|window|localStorage|navigator)\s*\./,
      );
      expect(source, `${file} uses Math.random`).not.toMatch(/Math\.random\(/);
    }
  });
});
