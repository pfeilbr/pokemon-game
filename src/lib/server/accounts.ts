import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { type TrainerRow, db } from './db';

/**
 * Trainer accounts.
 *
 * Two ways in: a trainer name plus a 4-digit PIN, or Google. The PIN exists
 * because a seven-year-old can type four digits unaided but cannot manage a
 * password or a parent's Google account.
 *
 * A 4-digit PIN is only 10,000 combinations, so the hash alone is not the
 * defence - the lockout below is. PINs are scrypt-hashed with a per-account
 * salt so a database leak does not expose them, and five wrong guesses lock
 * the account for fifteen minutes, which turns an exhaustive search into
 * roughly a month of sustained attempts per account.
 */

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(pin, salt, KEY_LENGTH);
  return `${salt}:${derived.toString('hex')}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;

  const derived = await scryptAsync(pin, salt, KEY_LENGTH);
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (expectedBuffer.length !== derived.length) return false;
  return timingSafeEqual(derived, expectedBuffer);
}

/** Trainer names are matched case- and space-insensitively. */
export function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function isValidPin(pin: string): boolean {
  return /^\d{4}$/.test(pin);
}

export function isValidName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length >= 2 && trimmed.length <= 16;
}

export type AuthResult =
  | { ok: true; trainerId: string; displayName: string }
  | { ok: false; reason: 'taken' | 'invalid' | 'mismatch' | 'locked' | 'unavailable' };

export async function registerWithPin(name: string, pin: string): Promise<AuthResult> {
  if (!isValidName(name) || !isValidPin(pin)) return { ok: false, reason: 'invalid' };

  const sql = await db();
  if (!sql) return { ok: false, reason: 'unavailable' };

  const id = randomUUID();
  const key = nameKey(name);
  const hash = await hashPin(pin);

  // Let the unique index decide the race rather than checking then inserting.
  const inserted = await sql<{ id: string }[]>`
    insert into trainers (id, name_key, display_name, pin_hash)
    values (${id}, ${key}, ${name.trim()}, ${hash})
    on conflict (name_key) do nothing
    returning id
  `;

  if (inserted.length === 0) return { ok: false, reason: 'taken' };
  return { ok: true, trainerId: id, displayName: name.trim() };
}

export async function loginWithPin(name: string, pin: string): Promise<AuthResult> {
  if (!isValidName(name) || !isValidPin(pin)) return { ok: false, reason: 'invalid' };

  const sql = await db();
  if (!sql) return { ok: false, reason: 'unavailable' };

  const rows = await sql<TrainerRow[]>`
    select * from trainers where name_key = ${nameKey(name)} limit 1
  `;
  const trainer = rows[0];
  // Same answer whether the name exists or the PIN is wrong, so the endpoint
  // cannot be used to enumerate trainer names.
  if (!trainer?.pin_hash) return { ok: false, reason: 'mismatch' };

  if (trainer.locked_until && trainer.locked_until.getTime() > Date.now()) {
    return { ok: false, reason: 'locked' };
  }

  if (!(await verifyPin(pin, trainer.pin_hash))) {
    const failures = trainer.failed_logins + 1;
    const lockUntil =
      failures >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null;
    await sql`
      update trainers
      set failed_logins = ${failures >= MAX_FAILED_LOGINS ? 0 : failures},
          locked_until = ${lockUntil}
      where id = ${trainer.id}
    `;
    return { ok: false, reason: lockUntil ? 'locked' : 'mismatch' };
  }

  await sql`update trainers set failed_logins = 0, locked_until = null where id = ${trainer.id}`;
  return { ok: true, trainerId: trainer.id, displayName: trainer.display_name };
}

/** Finds or creates the trainer behind a Google account. */
export async function upsertGoogleTrainer(params: {
  sub: string;
  name: string;
  email: string | null;
}): Promise<AuthResult> {
  const sql = await db();
  if (!sql) return { ok: false, reason: 'unavailable' };

  const displayName = params.name.trim().slice(0, 16) || 'Trainer';

  const rows = await sql<{ id: string; display_name: string }[]>`
    insert into trainers (id, display_name, google_sub, email)
    values (${randomUUID()}, ${displayName}, ${params.sub}, ${params.email})
    on conflict (google_sub) do update set email = excluded.email, updated_at = now()
    returning id, display_name
  `;

  const trainer = rows[0];
  if (!trainer) return { ok: false, reason: 'unavailable' };
  return { ok: true, trainerId: trainer.id, displayName: trainer.display_name };
}

export async function loadProfile(trainerId: string): Promise<unknown | null> {
  const sql = await db();
  if (!sql) return null;
  const rows = await sql<{ profile: unknown }[]>`
    select profile from trainers where id = ${trainerId} limit 1
  `;
  return rows[0]?.profile ?? null;
}

export async function saveProfile(trainerId: string, profile: unknown): Promise<boolean> {
  const sql = await db();
  if (!sql) return false;
  const rows = await sql<{ id: string }[]>`
    update trainers
    set profile = ${sql.json(profile as never)}, updated_at = now()
    where id = ${trainerId}
    returning id
  `;
  return rows.length > 0;
}
