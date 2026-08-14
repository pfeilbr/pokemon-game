// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { createProfile, normaliseProfile, type Profile } from '../game/progress';

/**
 * The server half of "a merge never costs a child what he earned".
 *
 * `scripts/audit_sync.py` proves the *client* merge is lossless. That is not
 * the whole story, because the client only merges what it reads on open. A tab
 * left signed in since before he played on the tablet holds a save that never
 * saw those creatures, and a plain `saveProfile` writes it straight over the
 * row. The next device to open does repair it - that is what the two-device E2E
 * walks through - but a tab that never reopens leaves the loss standing, and
 * the server should not need rescuing to begin with.
 *
 * Skipped unless TEST_DATABASE_URL is set, like every other test that talks SQL:
 *
 *   TEST_DATABASE_URL='postgres://postgres@127.0.0.1:5432/postgres?sslmode=disable' npm test
 */

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

const suite = url ? describe : describe.skip;

suite('a stale client cannot wipe the stored album', () => {
  let accounts: typeof import('./accounts');
  let trainerId: string;

  beforeAll(async () => {
    accounts = await import('./accounts');
    const created = await accounts.registerWithPin(`merge-${Date.now() % 100000}`, '1234');
    expect(created.ok, 'could not create a trainer to test with').toBe(true);
    if (created.ok) trainerId = created.trainerId;
  });

  /** What the child actually earned, on the device he was playing on. */
  const earned = (): Profile => {
    const p = createProfile({
      trainerName: 'Player',
      starterId: 'cindik',
      now: '2026-08-14T10:00:00.000Z',
    });
    return {
      ...p,
      caught: ['cindik', 'sproutle', 'bublet', 'pebblo', 'voltick'],
      badges: ['first-win', 'combo-5', 'collector-6'],
      xp: 491,
      battlesWon: 9,
      bestCombo: 7,
      updatedAt: '2026-08-14T10:00:00.000Z',
    };
  };

  /**
   * The stale tab. Note the LATER timestamp with LESS progress - that is not a
   * contrived case, it is what toggling the language on the laptop does: it
   * bumps updatedAt without earning anything.
   */
  const stale = (): Profile => {
    const p = createProfile({
      trainerName: 'Player',
      starterId: 'cindik',
      now: '2026-08-14T09:00:00.000Z',
    });
    return { ...p, caught: ['cindik'], xp: 10, updatedAt: '2026-08-14T11:00:00.000Z' };
  };

  it('keeps every creature and badge when a stale save arrives later', async () => {
    await accounts.saveProfile(trainerId, earned());

    await accounts.saveProfileMerged(trainerId, stale());

    const stored = normaliseProfile(await accounts.loadProfile(trainerId));
    expect(stored).not.toBeNull();
    // The whole point: the newer-but-emptier write must not be a discard.
    expect(stored?.caught).toEqual(
      expect.arrayContaining(['cindik', 'sproutle', 'bublet', 'pebblo', 'voltick']),
    );
    expect(stored?.badges).toEqual(expect.arrayContaining(['first-win', 'combo-5', 'collector-6']));
    expect(stored?.xp).toBe(491);
    expect(stored?.battlesWon).toBe(9);
    expect(stored?.bestCombo).toBe(7);
  });

  it('still accepts genuinely newer progress', async () => {
    await accounts.saveProfile(trainerId, earned());

    const later: Profile = {
      ...earned(),
      caught: [...earned().caught, 'chillcoil'],
      xp: 600,
      updatedAt: '2026-08-14T12:00:00.000Z',
    };
    await accounts.saveProfileMerged(trainerId, later);

    const stored = normaliseProfile(await accounts.loadProfile(trainerId));
    expect(stored?.caught).toContain('chillcoil');
    expect(stored?.xp).toBe(600);
  });

  it('stores the incoming save when the trainer has nothing yet', async () => {
    const fresh = await accounts.registerWithPin(`empty-${Date.now() % 100000}`, '4321');
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;

    await accounts.saveProfileMerged(fresh.trainerId, earned());

    const stored = normaliseProfile(await accounts.loadProfile(fresh.trainerId));
    expect(stored?.caught).toHaveLength(5);
    expect(stored?.xp).toBe(491);
  });
});
