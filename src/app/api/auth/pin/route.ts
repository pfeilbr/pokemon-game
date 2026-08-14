import { loginWithPin, registerWithPin } from '@/lib/server/accounts';
import { accountsAvailable } from '@/lib/server/env';
import { jsonError, jsonOk, readJsonBody, route } from '@/lib/server/http';
import { AUTH_RULE, checkRateLimit, clientKey } from '@/lib/server/ratelimit';
import { createSessionToken, setSessionCookie } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/** Trainer-name + 4-digit-PIN sign-up and sign-in. */
export const POST = route('POST /api/auth/pin', async (request: Request) => {
  if (!accountsAvailable()) return jsonError('unavailable', 503);

  // The account lockout stops five guesses at *one* name. This stops a
  // thousand guesses at a thousand names, which the lockout never sees.
  // Keyed by address only, so the answer cannot depend on which name was
  // tried - the endpoint still refuses to say which children exist.
  const verdict = checkRateLimit(`pin:${clientKey(request)}`, AUTH_RULE, Date.now());
  if (!verdict.allowed) {
    // 'locked' rather than a new word: the vocabulary is a cross-client
    // contract (mobile/src/api.ts), and "wait a bit" is exactly what a
    // throttled caller should be told.
    return jsonError('locked', 429, { 'retry-after': String(verdict.retryAfterSeconds) });
  }

  const body = await readJsonBody(request);
  if (!body.ok) {
    // Every malformed request is 'invalid', the same word a bad PIN gets, so
    // the shape of a refusal never depends on whether the name exists.
    const status = body.reason === 'too_large' || body.reason === 'too_deep' ? 413 : 400;
    return jsonError('invalid', status);
  }

  const raw = body.value as { name?: unknown; pin?: unknown; mode?: unknown } | null;
  if (typeof raw !== 'object' || raw === null) return jsonError('invalid', 400);

  const name = typeof raw.name === 'string' ? raw.name : '';
  const pin = typeof raw.pin === 'string' ? raw.pin : '';
  const mode = raw.mode === 'register' ? 'register' : 'login';

  const result =
    mode === 'register' ? await registerWithPin(name, pin) : await loginWithPin(name, pin);

  if (!result.ok) {
    const status = result.reason === 'unavailable' ? 503 : result.reason === 'locked' ? 429 : 400;
    return jsonError(result.reason, status);
  }

  const token = await createSessionToken({
    trainerId: result.trainerId,
    displayName: result.displayName,
    provider: 'pin',
  });
  if (!token) return jsonError('unavailable', 503);

  await setSessionCookie(token);
  return jsonOk({ ok: true, trainerName: result.displayName });
});
