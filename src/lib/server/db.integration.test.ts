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

  /**
   * The three properties CLAUDE.md claims for the account layer, pinned so
   * they fail a build rather than a post-mortem. Prose does not fail a build.
   */
  describe('documented security properties', () => {
    beforeEach(async () => {
      await accounts.registerWithPin('Leo', '1234');
    });

    const sqlClient = async () => {
      const sql = await dbModule.db();
      if (!sql) throw new Error('no database');
      return sql;
    };

    /** Reads the lock bookkeeping straight out of the row. */
    const trainerRow = async () => {
      const sql = await sqlClient();
      const rows = await sql<
        { pin_hash: string; failed_logins: number; locked_until: Date | null }[]
      >`
        select pin_hash, failed_logins, locked_until from trainers where name_key = 'leo'
      `;
      const row = rows[0];
      if (!row) throw new Error('trainer missing');
      return row;
    };

    describe('lockout', () => {
      it('takes exactly five wrong PINs - four is not enough', async () => {
        for (let attempt = 1; attempt <= 4; attempt++) {
          expect(await accounts.loginWithPin('Leo', '0000'), `attempt ${attempt}`).toEqual({
            ok: false,
            reason: 'mismatch',
          });
        }
        expect(await accounts.loginWithPin('Leo', '0000')).toEqual({ ok: false, reason: 'locked' });
      });

      it('refuses the sixth attempt even with the correct PIN', async () => {
        for (let attempt = 1; attempt <= accounts.MAX_FAILED_LOGINS; attempt++) {
          await accounts.loginWithPin('Leo', '0000');
        }
        expect(await accounts.loginWithPin('Leo', '1234')).toEqual({ ok: false, reason: 'locked' });
        // And a correct PIN offered during the lock must not clear it.
        expect(await accounts.loginWithPin('Leo', '1234')).toEqual({ ok: false, reason: 'locked' });
      });

      it('locks for the documented fifteen minutes', async () => {
        const before = Date.now();
        for (let attempt = 1; attempt <= accounts.MAX_FAILED_LOGINS; attempt++) {
          await accounts.loginWithPin('Leo', '0000');
        }
        const lockedUntil = (await trainerRow()).locked_until;
        expect(lockedUntil).not.toBeNull();
        const minutes = (lockedUntil!.getTime() - before) / 60_000;
        // Wide band on purpose: this asserts "fifteen minutes, not fifteen
        // seconds or fifteen hours", and cannot flake on a slow machine.
        expect(minutes).toBeGreaterThan(accounts.LOCKOUT_MINUTES - 1);
        expect(minutes).toBeLessThanOrEqual(accounts.LOCKOUT_MINUTES + 1);
      });

      it('lets the correct PIN back in once the window has passed', async () => {
        for (let attempt = 1; attempt <= accounts.MAX_FAILED_LOGINS; attempt++) {
          await accounts.loginWithPin('Leo', '0000');
        }
        expect(await accounts.loginWithPin('Leo', '1234')).toEqual({ ok: false, reason: 'locked' });

        // Time is injected by ageing the row rather than by sleeping, so the
        // test is deterministic and instant.
        const sql = await sqlClient();
        await sql`update trainers set locked_until = now() - interval '1 second' where name_key = 'leo'`;

        expect((await accounts.loginWithPin('Leo', '1234')).ok).toBe(true);
      });

      it('still refuses while the window is open', async () => {
        const sql = await sqlClient();
        await sql`update trainers set locked_until = now() + interval '14 minutes' where name_key = 'leo'`;
        expect(await accounts.loginWithPin('Leo', '1234')).toEqual({ ok: false, reason: 'locked' });
      });

      it('resets the count on success, so a slow trickle never locks a child out', async () => {
        // Four wrong, one right, four wrong, one right: nine failures in all,
        // and without the reset the account would be locked twice over.
        for (let attempt = 1; attempt <= 4; attempt++) {
          await accounts.loginWithPin('Leo', '0000');
        }
        expect((await accounts.loginWithPin('Leo', '1234')).ok).toBe(true);
        expect((await trainerRow()).failed_logins).toBe(0);

        for (let attempt = 1; attempt <= 4; attempt++) {
          expect(await accounts.loginWithPin('Leo', '0000'), `second run ${attempt}`).toEqual({
            ok: false,
            reason: 'mismatch',
          });
        }
        expect((await accounts.loginWithPin('Leo', '1234')).ok).toBe(true);
      });
    });

    describe('the stored PIN', () => {
      it('is never the PIN, and differs between accounts sharing one', async () => {
        await accounts.registerWithPin('Mia', '1234');
        const sql = await sqlClient();
        const rows = await sql<{ name_key: string; pin_hash: string }[]>`
          select name_key, pin_hash from trainers order by name_key
        `;
        expect(rows).toHaveLength(2);

        const [leo, mia] = rows;
        for (const row of [leo!, mia!]) {
          expect(row.pin_hash).not.toContain('1234');
          expect(row.pin_hash.split(':')[0]).toMatch(/^[0-9a-f]{32}$/);
          expect(row.pin_hash.split(':')[1]).toMatch(/^[0-9a-f]{128}$/);
        }
        // Same PIN, different salt, therefore different stored value: one
        // cracked row does not crack the rest of the table.
        expect(leo!.pin_hash.split(':')[0]).not.toBe(mia!.pin_hash.split(':')[0]);
        expect(leo!.pin_hash).not.toBe(mia!.pin_hash);
        expect(await accounts.verifyPin('1234', mia!.pin_hash)).toBe(true);
      });
    });

    describe('trainer names cannot be enumerated through sign-in', () => {
      it('answers an unknown name exactly as it answers a wrong PIN', async () => {
        expect(await accounts.loginWithPin('Nobody', '1234')).toEqual(
          await accounts.loginWithPin('Leo', '4321'),
        );
      });

      it('answers a Google-only account the same way too', async () => {
        await accounts.upsertGoogleTrainer({ sub: 'sub-x', name: 'Gia', email: null });
        const sql = await sqlClient();
        await sql`update trainers set name_key = 'gia' where google_sub = 'sub-x'`;
        expect(await accounts.loginWithPin('Gia', '1234')).toEqual({
          ok: false,
          reason: 'mismatch',
        });
      });

      it('takes comparable time for an unknown name and a wrong PIN', async () => {
        // What this proves: the two paths are not separated by a whole key
        // derivation. A miss that skipped scrypt returned in about 1ms while a
        // wrong PIN spends ~45ms deriving, and that gap is measurable across
        // the public internet - it enumerates trainer names just as well as a
        // different error message would, however identical the bodies are.
        //
        // What it does NOT prove: constant-time behaviour. Cache effects,
        // allocator noise and network jitter are all out of reach of a test
        // like this, and a hostile observer with thousands of samples can see
        // things it cannot. The bound is deliberately loose - the unknown-name
        // path must take at least 40% of the wrong-PIN path - so it fails only
        // on an order-of-magnitude asymmetry, never on a slow or busy machine.
        // `setUp` runs outside the clock on purpose. An earlier version reset
        // the lock inside the timed region, which put one extra round trip on
        // the wrong-PIN side only - and a slow moment in Postgres was then
        // enough to fail the assertion for a reason that had nothing to do
        // with the property under test. Both timed regions are now exactly
        // one loginWithPin call.
        const median = async (setUp: () => Promise<void>, run: () => Promise<unknown>) => {
          await setUp();
          await run(); // warm the connection and the JIT before measuring
          const samples: number[] = [];
          for (let i = 0; i < 7; i++) {
            await setUp();
            const started = performance.now();
            await run();
            samples.push(performance.now() - started);
          }
          samples.sort((a, b) => a - b);
          return samples[3]!;
        };

        // Keeps the account out of lockout so every sample takes one path.
        const clearLock = async () => {
          const sql = await sqlClient();
          await sql`update trainers set failed_logins = 0, locked_until = null where name_key = 'leo'`;
        };

        const unknownName = await median(clearLock, () => accounts.loginWithPin('Nobody', '1234'));
        const wrongPin = await median(clearLock, () => accounts.loginWithPin('Leo', '4321'));

        expect(unknownName / wrongPin).toBeGreaterThan(0.4);
      });
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
  /**
   * The server half of "a merge never costs a child what he earned".
   *
   * `scripts/audit_sync.py` proves the *client* merge is lossless, but the
   * client only merges what it reads on open. A tab left signed in since before
   * he played on the tablet holds a save that never saw those creatures, and a
   * plain `saveProfile` writes it straight over the row. The next device to
   * open repairs it - that is what the two-device E2E walks through - but a tab
   * that never reopens leaves the loss standing.
   *
   * These live in this file rather than their own because this file owns the
   * `delete from trainers` in `beforeEach`. Vitest parallelises across files, so
   * a separate file that created a trainer once and reused it across tests had
   * the row deleted underneath it mid-run - green on a direct `npm test` and red
   * under the preflight, purely on timing. Sharing the lifecycle removes the
   * race rather than narrowing it.
   */
  describe('a stale client cannot wipe the stored album', () => {
    /** What the child actually earned, on the device he was playing on. */
    const earned = () => ({
      ...progress.createProfile({
        trainerName: 'Player',
        starterId: 'cindik',
        now: '2026-08-14T10:00:00.000Z',
      }),
      caught: ['cindik', 'sproutle', 'bublet', 'pebblo', 'voltick'],
      badges: ['first-win', 'combo-5', 'collector-6'],
      xp: 491,
      battlesWon: 9,
      bestCombo: 7,
      updatedAt: '2026-08-14T10:00:00.000Z',
    });

    /**
     * The stale tab. Note the LATER timestamp with LESS progress - not a
     * contrived case, but exactly what toggling the language on the laptop
     * does: it bumps updatedAt without earning anything.
     */
    const stale = () => ({
      ...progress.createProfile({
        trainerName: 'Player',
        starterId: 'cindik',
        now: '2026-08-14T09:00:00.000Z',
      }),
      caught: ['cindik'],
      xp: 10,
      updatedAt: '2026-08-14T11:00:00.000Z',
    });

    const newTrainer = async (name: string): Promise<string> => {
      const created = await accounts.registerWithPin(name, '1234');
      expect(created.ok, 'could not create a trainer to test with').toBe(true);
      return created.ok ? created.trainerId : '';
    };

    it('keeps every creature and badge when a stale save arrives later', async () => {
      const id = await newTrainer('MergeOne');
      await accounts.saveProfile(id, earned());

      await accounts.saveProfileMerged(id, stale());

      const stored = progress.normaliseProfile(await accounts.loadProfile(id));
      expect(stored).not.toBeNull();
      // The whole point: the newer-but-emptier write must not be a discard.
      expect(stored?.caught).toEqual(
        expect.arrayContaining(['cindik', 'sproutle', 'bublet', 'pebblo', 'voltick']),
      );
      expect(stored?.badges).toEqual(
        expect.arrayContaining(['first-win', 'combo-5', 'collector-6']),
      );
      expect(stored?.xp).toBe(491);
      expect(stored?.battlesWon).toBe(9);
      expect(stored?.bestCombo).toBe(7);
    });

    it('still accepts genuinely newer progress', async () => {
      const id = await newTrainer('MergeTwo');
      await accounts.saveProfile(id, earned());

      await accounts.saveProfileMerged(id, {
        ...earned(),
        caught: [...earned().caught, 'chillcoil'],
        xp: 600,
        updatedAt: '2026-08-14T12:00:00.000Z',
      });

      const stored = progress.normaliseProfile(await accounts.loadProfile(id));
      expect(stored?.caught).toContain('chillcoil');
      expect(stored?.xp).toBe(600);
    });

    it('stores the incoming save when the trainer has nothing yet', async () => {
      const id = await newTrainer('MergeThree');

      await accounts.saveProfileMerged(id, earned());

      const stored = progress.normaliseProfile(await accounts.loadProfile(id));
      expect(stored?.caught).toHaveLength(5);
      expect(stored?.xp).toBe(491);
    });
  });
});
