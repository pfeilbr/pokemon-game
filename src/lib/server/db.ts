import postgres from 'postgres';
import { databaseUrl } from './env';

/**
 * Postgres access.
 *
 * Works against any Postgres connection string - Neon (what Vercel's free tier
 * hands you), Supabase, or a local server. The schema is created on first use
 * rather than through a migration step, because there is exactly one table and
 * asking the user to run a migration before their child can play is a worse
 * trade than a cached CREATE TABLE IF NOT EXISTS.
 */

type Sql = ReturnType<typeof postgres>;

let client: Sql | null = null;
let ready: Promise<void> | null = null;

function connect(): Sql | null {
  const url = databaseUrl();
  if (!url) return null;
  if (client) return client;

  client = postgres(url, {
    // Serverless functions are short-lived; a big pool just exhausts the
    // database's connection limit.
    max: 1,
    idle_timeout: 20,
    connect_timeout: 15,
    ssl: url.includes('sslmode=disable') ? false : 'require',
    onnotice: () => {},
  });
  return client;
}

const SCHEMA = `
  create table if not exists trainers (
    id            text primary key,
    name_key      text unique,
    display_name  text not null,
    pin_hash      text,
    google_sub    text unique,
    email         text,
    profile       jsonb,
    failed_logins integer not null default 0,
    locked_until  timestamptz,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
  );
`;

/** Returns a ready-to-use client, or null when no database is configured. */
export async function db(): Promise<Sql | null> {
  const sql = connect();
  if (!sql) return null;

  // Memoised so the schema check costs one round trip per warm instance.
  ready ??= (async () => {
    await sql.unsafe(SCHEMA);
  })().catch((error) => {
    // Let the next request retry rather than caching a failure forever.
    ready = null;
    throw error;
  });

  await ready;
  return sql;
}

export type TrainerRow = {
  id: string;
  name_key: string | null;
  display_name: string;
  pin_hash: string | null;
  google_sub: string | null;
  email: string | null;
  profile: unknown;
  failed_logins: number;
  locked_until: Date | null;
};
