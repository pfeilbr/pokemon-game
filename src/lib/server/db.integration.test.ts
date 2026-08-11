// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Integration tests against a real Postgres.
 *
 * Everything else in the suite is pure, but the account layer talks SQL, and
 * SQL bugs do not show up until a database is actually attached - which for
 * this project happens on someone else's Vercel project, after the code has
 * shipped. These tests close that gap.
 *
 * They are skipped unless TEST_DATABASE_URL is set, so `npm test` stays
 * dependency-free:
 *
 *   TEST_DATABASE_URL='postgres://postgres@127.0.0.1:5432/postgres?sslmode=disable' npm test
 */

const url = process.env.TEST_DATABASE_URL;

// Must be set before anything calls db(), which reads the environment lazily.
if (url) process.env.DATABASE_URL = url;

const suite = url ? describe : describe.skip;

suite('account persistence against Postgres', () => {
  let accounts: typeof import('./accounts');
  let dbModule: typeof import('./db');
  let progress: typeof import('../game/progress');

  beforeAll(async () => {
    accounts = await import('./accounts');
    dbModule = await import('./db');
    progress = await import('../game/progress');
  });

  beforeEach(async () => {
    const sql = await dbModule.db();
    await sql!`delete from trainers`;
  });

  afterAll(async () => {
    const sql = await dbModule.db();
    await sql?.end({ timeout: 5 });
  });

  it('creates its schema on first use', async () => {
    const sql = await dbModule.db();
    const rows = await sql!<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_name = 'trainers'
    `;
    const columns = rows.map((r) => r.column_name);
    for (const expected of [
      'id',
      'name_key',
      'display_name',
      'pin_hash',
      'google_sub',
      'email',
      'profile',
      'failed_logins',
      'locked_until',
    ]) {
      expect(columns, `missing column ${expected}`).toContain(expected);
    }
  });

  describe('PIN sign-up', () => {
    it('registers a new trainer', async () => {
      const result = await accounts.registerWithPin('Leo', '1234');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.displayName).toBe('Leo');
    });

    it('refuses a name that is already taken, case-insensitively', async () => {
      await accounts.registerWithPin('Leo', '1234');
      expect(await accounts.registerWithPin('Leo', '9999')).toEqual({
        ok: false,
        reason: 'taken',
      });
      expect(await accounts.registerWithPin('  LEO ', '9999')).toEqual({
        ok: false,
        reason: 'taken',
      });
    });

    it('rejects a malformed name or PIN before touching the database', async () => {
      expect(await accounts.registerWithPin('A', '1234')).toEqual({ ok: false, reason: 'invalid' });
      expect(await accounts.registerWithPin('Leo', '12')).toEqual({ ok: false, reason: 'invalid' });
      expect(await accounts.registerWithPin('Leo', 'abcd')).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });
  });

  describe('PIN sign-in', () => {
    beforeEach(async () => {
      await accounts.registerWithPin('Leo', '1234');
    });

    it('signs in with the right PIN', async () => {
      const result = await accounts.loginWithPin('Leo', '1234');
      expect(result.ok).toBe(true);
    });

    it('matches the name case-insensitively', async () => {
      expect((await accounts.loginWithPin('  leo  ', '1234')).ok).toBe(true);
    });

    it('rejects the wrong PIN', async () => {
      expect(await accounts.loginWithPin('Leo', '4321')).toEqual({
        ok: false,
        reason: 'mismatch',
      });
    });

    it('gives an unknown name the same answer as a wrong PIN, so names cannot be enumerated', async () => {
      const unknownName = await accounts.loginWithPin('Nobody', '1234');
      const wrongPin = await accounts.loginWithPin('Leo', '4321');
      expect(unknownName).toEqual(wrongPin);
    });

    it('locks the account after five wrong guesses', async () => {
      for (let attempt = 1; attempt < accounts.MAX_FAILED_LOGINS; attempt++) {
        expect(await accounts.loginWithPin('Leo', '0000')).toEqual({
          ok: false,
          reason: 'mismatch',
        });
      }
      expect(await accounts.loginWithPin('Leo', '0000')).toEqual({ ok: false, reason: 'locked' });

      // And the lock holds even against the correct PIN.
      expect(await accounts.loginWithPin('Leo', '1234')).toEqual({ ok: false, reason: 'locked' });
    });

    it('clears the failure count after a successful sign-in', async () => {
      await accounts.loginWithPin('Leo', '0000');
      await accounts.loginWithPin('Leo', '0000');
      expect((await accounts.loginWithPin('Leo', '1234')).ok).toBe(true);

      const sql = await dbModule.db();
      const rows = await sql!<{ failed_logins: number }[]>`
        select failed_logins from trainers where name_key = 'leo'
      `;
      expect(rows[0]!.failed_logins).toBe(0);
    });
  });

  describe('profile storage', () => {
    it('round-trips a real profile through jsonb without loss', async () => {
      const registered = await accounts.registerWithPin('Leo', '1234');
      expect(registered.ok).toBe(true);
      if (!registered.ok) return;

      const profile = progress.createProfile({
        trainerName: 'Leo',
        starterId: 'zaplet',
        now: '2026-08-11T12:00:00.000Z',
      });
      profile.xp = 1234;
      profile.caught = ['zaplet', 'bublet'];
      profile.badges = ['first-win'];
      profile.skillStats = { add1: { attempts: 10, correct: 9, totalMs: 15_000 } };

      expect(await accounts.saveProfile(registered.trainerId, profile)).toBe(true);

      const loaded = await accounts.loadProfile(registered.trainerId);
      expect(loaded).toEqual(profile);
      // And it survives the repair pass the API applies on the way in.
      expect(progress.normaliseProfile(loaded)).toEqual(profile);
    });

    it('returns null for a trainer with no profile yet', async () => {
      const registered = await accounts.registerWithPin('Leo', '1234');
      if (!registered.ok) throw new Error('setup failed');
      expect(await accounts.loadProfile(registered.trainerId)).toBeNull();
    });

    it('overwrites rather than appending on a second save', async () => {
      const registered = await accounts.registerWithPin('Leo', '1234');
      if (!registered.ok) throw new Error('setup failed');

      const first = progress.createProfile({ trainerName: 'Leo', starterId: 'cindik' });
      await accounts.saveProfile(registered.trainerId, first);

      const second = { ...first, xp: 999 };
      await accounts.saveProfile(registered.trainerId, second);

      const loaded = (await accounts.loadProfile(registered.trainerId)) as { xp: number };
      expect(loaded.xp).toBe(999);
    });

    it('reports failure for an unknown trainer instead of silently succeeding', async () => {
      const profile = progress.createProfile({ trainerName: 'Ghost', starterId: 'cindik' });
      expect(await accounts.saveProfile('00000000-0000-0000-0000-000000000000', profile)).toBe(
        false,
      );
      expect(await accounts.loadProfile('00000000-0000-0000-0000-000000000000')).toBeNull();
    });
  });

  describe('Google sign-in', () => {
    it('creates a trainer on first sign-in and reuses it after', async () => {
      const first = await accounts.upsertGoogleTrainer({
        sub: 'google-123',
        name: 'Leo',
        email: 'leo@example.com',
      });
      expect(first.ok).toBe(true);

      const second = await accounts.upsertGoogleTrainer({
        sub: 'google-123',
        name: 'Leo Renamed',
        email: 'leo.new@example.com',
      });
      expect(second.ok).toBe(true);
      if (first.ok && second.ok) {
        // Same account, so the album follows them.
        expect(second.trainerId).toBe(first.trainerId);
      }

      const sql = await dbModule.db();
      const rows = await sql!<{ email: string }[]>`select email from trainers`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.email).toBe('leo.new@example.com');
    });

    it('keeps separate Google accounts separate', async () => {
      const a = await accounts.upsertGoogleTrainer({ sub: 'sub-a', name: 'A', email: null });
      const b = await accounts.upsertGoogleTrainer({ sub: 'sub-b', name: 'B', email: null });
      if (a.ok && b.ok) expect(a.trainerId).not.toBe(b.trainerId);
    });

    it('falls back to a usable display name when Google sends none', async () => {
      const result = await accounts.upsertGoogleTrainer({ sub: 'sub-c', name: '', email: null });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.displayName).toBe('Trainer');
    });

    it('does not collide with a PIN account of the same name', async () => {
      await accounts.registerWithPin('Leo', '1234');
      const google = await accounts.upsertGoogleTrainer({
        sub: 'sub-d',
        name: 'Leo',
        email: null,
      });
      expect(google.ok).toBe(true);
    });
  });
});
