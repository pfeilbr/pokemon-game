import { decodeJwt } from 'jose';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { upsertGoogleTrainer } from '@/lib/server/accounts';
import { googleAvailable, googleCredentials } from '@/lib/server/env';
import { createSessionToken, setSessionCookie } from '@/lib/server/session';
import { OAUTH_STATE_COOKIE } from '../route';

export const dynamic = 'force-dynamic';

function fail(request: Request, reason: string) {
  return NextResponse.redirect(new URL(`/login?error=${reason}`, request.url));
}

export async function GET(request: Request) {
  if (!googleAvailable()) return fail(request, 'unavailable');
  const credentials = googleCredentials()!;

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  const jar = await cookies();
  const expectedState = jar.get(OAUTH_STATE_COOKIE)?.value;
  jar.set(OAUTH_STATE_COOKIE, '', { path: '/', maxAge: 0 });

  // Reject anything that did not originate from our own redirect.
  if (!code || !state || !expectedState || state !== expectedState) {
    return fail(request, 'state');
  }

  let idToken: string;
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        redirect_uri: new URL('/api/auth/google/callback', request.url).toString(),
        grant_type: 'authorization_code',
      }),
    });
    if (!response.ok) return fail(request, 'exchange');

    const tokens = (await response.json()) as { id_token?: string };
    if (!tokens.id_token) return fail(request, 'exchange');
    idToken = tokens.id_token;
  } catch {
    return fail(request, 'exchange');
  }

  // The token came straight from Google's endpoint over TLS in response to our
  // own client secret, so decoding is sufficient here - there is no untrusted
  // hop to re-verify a signature against.
  const claims = decodeJwt(idToken) as { sub?: string; name?: string; email?: string };
  if (!claims.sub) return fail(request, 'claims');

  const result = await upsertGoogleTrainer({
    sub: claims.sub,
    name: claims.name ?? claims.email?.split('@')[0] ?? 'Trainer',
    email: claims.email ?? null,
  });
  if (!result.ok) return fail(request, result.reason);

  const token = await createSessionToken({
    trainerId: result.trainerId,
    displayName: result.displayName,
    provider: 'google',
  });
  if (!token) return fail(request, 'unavailable');

  await setSessionCookie(token);
  return NextResponse.redirect(new URL('/', request.url));
}
