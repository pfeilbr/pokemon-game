import { NextResponse } from 'next/server';
import { loginWithPin, registerWithPin } from '@/lib/server/accounts';
import { accountsAvailable } from '@/lib/server/env';
import { createSessionToken, setSessionCookie } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/** Trainer-name + 4-digit-PIN sign-up and sign-in. */
export async function POST(request: Request) {
  if (!accountsAvailable()) {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }

  let body: { name?: unknown; pin?: unknown; mode?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name : '';
  const pin = typeof body.pin === 'string' ? body.pin : '';
  const mode = body.mode === 'register' ? 'register' : 'login';

  const result =
    mode === 'register' ? await registerWithPin(name, pin) : await loginWithPin(name, pin);

  if (!result.ok) {
    const status = result.reason === 'unavailable' ? 503 : result.reason === 'locked' ? 429 : 400;
    return NextResponse.json({ error: result.reason }, { status });
  }

  const token = await createSessionToken({
    trainerId: result.trainerId,
    displayName: result.displayName,
    provider: 'pin',
  });
  if (!token) return NextResponse.json({ error: 'unavailable' }, { status: 503 });

  await setSessionCookie(token);
  return NextResponse.json({ ok: true, trainerName: result.displayName });
}
