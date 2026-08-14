import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { googleAvailable, googleCredentials } from '@/lib/server/env';
import { route } from '@/lib/server/http';
import { COOKIE_OPTIONS } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

export const OAUTH_STATE_COOKIE = 'mathmon_oauth_state';

/** The callback URL Google must have registered for this deployment. */
export function callbackUrl(request: Request): string {
  return new URL('/api/auth/google/callback', request.url).toString();
}

/** A failed start goes back to the login screen, never to a framework error page. */
function toLogin(request: Request, reason: string): NextResponse {
  return NextResponse.redirect(new URL(`/login?error=${reason}`, request.url), {
    headers: { 'cache-control': 'no-store' },
  });
}

/** Kicks off the Google OAuth dance. */
export const GET = route(
  'GET /api/auth/google',
  async (request: Request) => {
    if (!googleAvailable()) return toLogin(request, 'unavailable');
    const credentials = googleCredentials()!;

    // Random state, echoed back by Google and compared against this cookie, so a
    // third party cannot forge a callback.
    const state = randomBytes(16).toString('hex');
    (await cookies()).set(OAUTH_STATE_COOKIE, state, { ...COOKIE_OPTIONS, maxAge: 600 });

    const authorise = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorise.searchParams.set('client_id', credentials.clientId);
    authorise.searchParams.set('redirect_uri', callbackUrl(request));
    authorise.searchParams.set('response_type', 'code');
    authorise.searchParams.set('scope', 'openid email profile');
    authorise.searchParams.set('state', state);
    authorise.searchParams.set('prompt', 'select_account');

    return NextResponse.redirect(authorise.toString(), {
      headers: { 'cache-control': 'no-store' },
    });
  },
  (request) => toLogin(request, 'unavailable'),
);
