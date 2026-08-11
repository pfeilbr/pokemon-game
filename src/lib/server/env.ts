import { hkdfSync } from 'node:crypto';

/**
 * Deployment configuration.
 *
 * Every variable is optional. With none set the game still runs - it just runs
 * in local-only mode, saving to the browser. That is what makes a zero-config
 * Vercel import work on the first click; accounts light up the moment a
 * database is attached.
 */

export function databaseUrl(): string | null {
  // Vercel's Postgres/Neon integrations inject one of these.
  return (
    process.env.DATABASE_URL ??
    process.env.POSTGRES_URL ??
    process.env.POSTGRES_PRISMA_URL ??
    null
  );
}

let warnedAboutSecret = false;

/**
 * The key that signs session cookies.
 *
 * Prefers an explicit AUTH_SECRET. If the deployment has a database but no
 * secret - the common case right after clicking "add Neon" in the Vercel UI -
 * one is derived from the database URL via HKDF so accounts work immediately
 * and sessions survive redeploys. That is a deliberate convenience with a
 * loud warning attached, not a recommendation: the derived key is only as
 * private as the connection string.
 */
export function authSecret(): Uint8Array | null {
  const explicit = process.env.AUTH_SECRET;
  if (explicit && explicit.length >= 16) {
    return new TextEncoder().encode(explicit);
  }

  const db = databaseUrl();
  if (!db) return null;

  if (!warnedAboutSecret) {
    warnedAboutSecret = true;
    console.warn(
      '[mathmon] AUTH_SECRET is not set; deriving a session key from DATABASE_URL. ' +
        'Set AUTH_SECRET (openssl rand -base64 32) to decouple the two.',
    );
  }
  return new Uint8Array(hkdfSync('sha256', db, 'mathmon-session-salt', 'mathmon-session-key', 32));
}

export function googleCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** True when this deployment can hold accounts at all. */
export function accountsAvailable(): boolean {
  return databaseUrl() !== null && authSecret() !== null;
}

export function googleAvailable(): boolean {
  return accountsAvailable() && googleCredentials() !== null;
}
