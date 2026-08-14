import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { authSecret } from './env';

/**
 * Sessions.
 *
 * A signed JWT in an httpOnly cookie. No session table: the payload is tiny
 * (trainer id, display name, provider) and a serverless deployment should not
 * pay a database round trip just to learn who is calling.
 */

export const SESSION_COOKIE = 'mathmon_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 90; // 90 days - a child should not be logged out

export type SessionPayload = {
  trainerId: string;
  displayName: string;
  provider: 'pin' | 'google';
};

export async function createSessionToken(payload: SessionPayload): Promise<string | null> {
  const secret = authSecret();
  if (!secret) return null;

  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .setSubject(payload.trainerId)
    .sign(secret);
}

export async function readSession(): Promise<SessionPayload | null> {
  const secret = authSecret();
  if (!secret) return null;

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  try {
    // The algorithm is pinned rather than taken from the token's own header.
    // jose already refuses to hand a symmetric key to an asymmetric algorithm,
    // so this closes no hole today - it closes the one that opens the day the
    // key type changes and nobody re-reads this function.
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    const { trainerId, displayName, provider } = payload as Partial<SessionPayload>;
    if (typeof trainerId !== 'string' || typeof displayName !== 'string') return null;
    if (provider !== 'pin' && provider !== 'google') return null;
    return { trainerId, displayName, provider };
  } catch {
    // Expired or tampered with. Treat as signed out rather than erroring.
    return null;
  }
}

/**
 * The flags every cookie this app sets must carry.
 *
 * Exported so the OAuth state cookie inherits them rather than re-declaring a
 * near-copy: two hand-maintained flag lists are how one of them ends up
 * missing `httpOnly` without anyone noticing.
 */
export const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  secure: process.env.NODE_ENV === 'production',
} as const;

export async function setSessionCookie(token: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, { ...COOKIE_OPTIONS, maxAge: MAX_AGE_SECONDS });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, '', { ...COOKIE_OPTIONS, maxAge: 0 });
}
