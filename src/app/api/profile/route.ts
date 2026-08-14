import { normaliseProfile } from '@/lib/game/progress';
import { loadProfile, saveProfile } from '@/lib/server/accounts';
import { jsonError, jsonOk, readJsonBody, route } from '@/lib/server/http';
import { PROFILE_RULE, checkRateLimit } from '@/lib/server/ratelimit';
import { readSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

export const GET = route('GET /api/profile', async () => {
  const session = await readSession();
  if (!session) return jsonError('unauthorised', 401);

  const profile = await loadProfile(session.trainerId);
  return jsonOk({ profile });
});

const put = route('PUT /api/profile', async (request: Request) => {
  // Authenticate before reading a byte of the body: an anonymous caller must
  // not be able to make the server buffer anything at all.
  const session = await readSession();
  if (!session) return jsonError('unauthorised', 401);

  // Keyed by trainer, so one runaway client spends only its own budget.
  const verdict = checkRateLimit(`profile:${session.trainerId}`, PROFILE_RULE, Date.now());
  if (!verdict.allowed) {
    return jsonError('rate_limited', 429, { 'retry-after': String(verdict.retryAfterSeconds) });
  }

  const body = await readJsonBody(request);
  if (!body.ok) {
    // One word per class of refusal, and no parser detail: how far a payload
    // got is information an attacker is welcome to guess at rather than read.
    if (body.reason === 'too_large' || body.reason === 'too_deep') {
      return jsonError('too_large', 413);
    }
    if (body.reason === 'unsupported_media_type') return jsonError('invalid', 415);
    return jsonError('invalid', 400);
  }

  // Never trust the client's shape. Normalising here means a tampered or
  // simply outdated payload cannot poison the stored save.
  const profile = normaliseProfile((body.value as { profile?: unknown })?.profile);
  if (!profile) return jsonError('invalid', 400);

  const saved = await saveProfile(session.trainerId, profile);
  if (!saved) return jsonError('unavailable', 503);

  return jsonOk({ ok: true });
});

export const PUT = put;

/** navigator.sendBeacon posts rather than puts, so accept both. */
export const POST = put;
