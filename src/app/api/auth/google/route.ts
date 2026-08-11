import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { googleAvailable, googleCredentials } from '@/lib/server/env';

export const dynamic = 'force-dynamic';

export const OAUTH_STATE_COOKIE = 'mathmon_oauth_state';

/** The callback URL Google must have registered for this deployment. */
export function callbackUrl(request: Request): string {
  return new URL('/api/auth/google/callback', request.url).toString();
}

/** Kicks off the Google OAuth dance. */
export async function GET(request: Request) {
  if (!googleAvailable()) {
    return NextResponse.redirect(new URL('/login?error=unavailable', request.url));
  }
  const credentials = googleCredentials()!;

  // Random state, echoed back by Google and compared against this cookie, so a
  // third party cannot forge a callback.
  const state = randomBytes(16).toString('hex');
  (await cookies()).set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 600,
  });

  const authorise = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorise.searchParams.set('client_id', credentials.clientId);
  authorise.searchParams.set('redirect_uri', callbackUrl(request));
  authorise.searchParams.set('response_type', 'code');
  authorise.searchParams.set('scope', 'openid email profile');
  authorise.searchParams.set('state', state);
  authorise.searchParams.set('prompt', 'select_account');

  return NextResponse.redirect(authorise.toString());
}
