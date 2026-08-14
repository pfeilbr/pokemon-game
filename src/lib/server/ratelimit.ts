/**
 * Request throttling, above and beyond the per-account lockout.
 *
 * `loginWithPin` locks *an account* after five wrong PINs. That is the right
 * defence for a guessed PIN and no defence at all against volume: an attacker
 * who rotates the trainer name never trips it, because each name gets its own
 * fresh five. Nothing in the deployment sat between that and the database.
 *
 * What this is, honestly:
 *
 *   - A fixed window counter held in process memory. On Vercel each serverless
 *     instance keeps its own, so the effective limit is (limit x instances)
 *     and a cold start forgets everything. It is a speed bump, not a quota.
 *     A real one needs shared state, which would mean a second service for a
 *     game whose whole deployment story is "click import, no configuration".
 *   - Bounded: the table is capped, and once full it stops tracking new keys
 *     rather than growing. It fails *open* on purpose - a limiter that can be
 *     filled with spoofed keys until it denies everyone has been turned into
 *     the outage it was meant to prevent.
 *
 * What it is not: a defence against a distributed flood, and not a substitute
 * for the account lockout. Both are needed, and the lockout is the one that
 * matters for a 4-digit PIN.
 *
 * `now` is a parameter rather than a `Date.now()` call so a test can prove the
 * window opens and closes without sleeping.
 */

export type RateLimitRule = { limit: number; windowMs: number };

export type RateLimitVerdict = {
  allowed: boolean;
  remaining: number;
  /** Seconds until the current window rolls over. 0 when allowed. */
  retryAfterSeconds: number;
};

/**
 * Sign-in and sign-up attempts from one address per minute.
 *
 * Well above a child mistyping a PIN a few times, well below anything that
 * makes sweeping trainer names worthwhile. Keyed by address, never by name:
 * keying by name would let an attacker rotate names to escape it, and would
 * make the response depend on which name was tried - which is exactly the
 * enumeration signal loginWithPin exists to withhold.
 */
export const AUTH_RULE: RateLimitRule = { limit: 30, windowMs: 60_000 };

/**
 * Profile writes per signed-in trainer per minute.
 *
 * Keyed by trainer id, not address: a household or a school shares one address
 * and would otherwise throttle each other, while a runaway client can only
 * ever spend its own budget. Unauthenticated writes are refused at the session
 * check, before any of this.
 */
export const PROFILE_RULE: RateLimitRule = { limit: 120, windowMs: 60_000 };

/** Beyond this many tracked keys the limiter stops taking new ones. */
const MAX_TRACKED_KEYS = 10_000;

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

function sweep(now: number): void {
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}

/**
 * Counts one request against `key` and says whether it is allowed.
 *
 * Call once per request. Calling it twice charges twice.
 */
export function checkRateLimit(key: string, rule: RateLimitRule, now: number): RateLimitVerdict {
  const existing = windows.get(key);

  if (!existing || existing.resetAt <= now) {
    if (!existing && windows.size >= MAX_TRACKED_KEYS) {
      sweep(now);
      // Still full: allow rather than deny. See the note at the top - denying
      // here hands an attacker a switch that turns the game off for everyone.
      if (windows.size >= MAX_TRACKED_KEYS) {
        return { allowed: true, remaining: rule.limit - 1, retryAfterSeconds: 0 };
      }
    }
    windows.set(key, { count: 1, resetAt: now + rule.windowMs });
    return { allowed: true, remaining: rule.limit - 1, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  if (existing.count > rule.limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  return { allowed: true, remaining: rule.limit - existing.count, retryAfterSeconds: 0 };
}

/** Forgets every window. Tests only. */
export function resetRateLimits(): void {
  windows.clear();
}

/**
 * The best available identity for an unauthenticated caller.
 *
 * `x-vercel-forwarded-for` is set by the platform and cannot be spoofed by the
 * client, so it is preferred where it exists. `x-forwarded-for` is trusted only
 * as a fallback and only its first hop; behind no proxy at all it is
 * client-controlled, which is why nothing security-critical is keyed on it -
 * the account lockout is keyed on the account.
 */
export function clientKey(request: Request): string {
  const vercel = request.headers.get('x-vercel-forwarded-for');
  if (vercel) return vercel.split(',')[0]?.trim() || 'unknown';

  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown';

  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}
