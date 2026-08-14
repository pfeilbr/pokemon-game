import { NextResponse } from 'next/server';

/**
 * The HTTP surface: what every API route does *before* it trusts a request,
 * and what it is allowed to say back.
 *
 * `accounts.ts` protects the account. This file protects the process. They are
 * separate concerns and were found by separate audits - `scripts/audit_auth.py`
 * covers the PIN, the lockout and the cookie; `scripts/audit_api.py` covers the
 * request/response layer below.
 *
 * Three things live here because all six routes need them and none of them is
 * provided by the framework:
 *
 *  1. A bounded body reader. Next.js App Router route handlers have no request
 *     size limit at all - the Pages Router's 1MB `bodyParser.sizeLimit` did not
 *     survive the move. `await request.json()` therefore buffers and parses
 *     whatever arrives, so a single 50MB `PUT /api/profile` is enough to spend
 *     a serverless instance's whole memory allowance on JSON nobody asked for.
 *
 *  2. A depth check that runs on the *text*, before `JSON.parse` sees it. Size
 *     alone does not bound cost: `[[[[...]]]]` is cheap to send and recursive
 *     to parse. Scanning characters is O(n) and cannot itself recurse.
 *
 *  3. A fixed error vocabulary. The iOS client in mobile/src/api.ts switches on
 *     these exact strings, and a sign-in failure that arrives as an unknown
 *     word degrades to "unavailable" - which tells a locked-out child to try
 *     again rather than to wait. Changing AUTH_ERRORS is a cross-client change.
 */

/**
 * The largest request body any route will read.
 *
 * A normalised profile is a few kilobytes: `normaliseProfile` rebuilds it from
 * a fixed key list with a capped attempt window, so nothing legitimate is
 * close to this. 64 KiB leaves an order of magnitude of headroom and still
 * fits a hostile body inside one buffer.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/** Deepest nesting accepted. A real profile nests four levels. */
export const MAX_JSON_DEPTH = 32;

/**
 * Session-bearing answers must never be cached by a proxy.
 *
 * `dynamic = 'force-dynamic'` tells Next not to *render* the route ahead of
 * time; it says nothing to an intermediary about storing the response. Without
 * this a shared cache can hand one child's trainer name to the next.
 */
export const NO_STORE = { 'cache-control': 'no-store' } as const;

/**
 * The only words a sign-in failure is allowed to use.
 *
 * `mismatch` deliberately covers both "no such trainer" and "wrong PIN": the
 * server refuses to distinguish them so the endpoint cannot enumerate which
 * children exist. Nothing here may grow a word that splits those two.
 */
export const AUTH_ERRORS = ['mismatch', 'locked', 'taken', 'invalid', 'unavailable'] as const;
export type AuthError = (typeof AUTH_ERRORS)[number];

/** The only words a profile request failure is allowed to use. */
export const PROFILE_ERRORS = [
  'unauthorised',
  'invalid',
  'too_large',
  'rate_limited',
  'unavailable',
] as const;
export type ProfileError = (typeof PROFILE_ERRORS)[number];

export type ApiError = AuthError | ProfileError;

/** A refusal, in the documented vocabulary, uncacheable. */
export function jsonError(
  error: ApiError,
  status: number,
  headers: Record<string, string> = {},
): NextResponse {
  return NextResponse.json({ error }, { status, headers: { ...NO_STORE, ...headers } });
}

/** A successful answer, uncacheable. */
export function jsonOk(body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, { headers: NO_STORE });
}

/**
 * Logs a server-side failure without logging its payload.
 *
 * Deliberately not `console.error(error)`. postgres.js hangs `query` and
 * `parameters` off its errors as own enumerable properties, and Node prints
 * own properties when it formats an Error - so the obvious call would put the
 * parameters of `insert into trainers ... values (..., pin_hash)` into the
 * platform log on every database hiccup. Only the message travels.
 */
export function logServerError(scope: string, error: unknown): void {
  const message = error instanceof Error ? error.message : 'unknown error';
  console.error(`[mathmon] ${scope} failed: ${message}`);
}

export type BodyFailure = 'too_large' | 'too_deep' | 'malformed' | 'unsupported_media_type';
export type BodyResult = { ok: true; value: unknown } | { ok: false; reason: BodyFailure };

function isJsonContentType(header: string | null): boolean {
  if (!header) return false;
  const type = header.split(';')[0]?.trim().toLowerCase() ?? '';
  return type === 'application/json' || type.endsWith('+json');
}

/**
 * The maximum bracket nesting in a JSON document, counted over the raw text.
 *
 * String-aware, so `{"a":"[[[["}` is depth 1 rather than depth 5. Exported for
 * the tests; the interesting case is that this never recurses, which is the
 * whole point of measuring before parsing.
 */
export function jsonDepth(text: string): number {
  let depth = 0;
  let deepest = 0;
  let inString = false;
  let escaped = false;

  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') {
      depth += 1;
      if (depth > deepest) deepest = depth;
    } else if (ch === '}' || ch === ']') depth -= 1;
  }
  return deepest;
}

/** Reads at most `limit` bytes, cancelling the stream rather than buffering more. */
async function readBounded(request: Request, limit: number): Promise<Uint8Array | 'too_large'> {
  // An honest client declares its size, which lets us refuse before reading a
  // byte. A dishonest one is caught by the running total below, so this is an
  // optimisation rather than the defence.
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return 'too_large';

  const body = request.body;
  if (!body) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return 'too_large';
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Reads a JSON request body, bounded in bytes and in depth.
 *
 * Replaces `await request.json()` everywhere. Never throws: a route turns the
 * reason into one word of its own vocabulary rather than surfacing a parser
 * message, which would tell an attacker exactly how far their payload got.
 */
export async function readJsonBody(
  request: Request,
  limit: number = MAX_BODY_BYTES,
  maxDepth: number = MAX_JSON_DEPTH,
): Promise<BodyResult> {
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return { ok: false, reason: 'unsupported_media_type' };
  }

  let bytes: Uint8Array | 'too_large';
  try {
    bytes = await readBounded(request, limit);
  } catch {
    // A truncated or aborted upload. Indistinguishable from a malformed one
    // from here, and treated the same.
    return { ok: false, reason: 'malformed' };
  }
  if (bytes === 'too_large') return { ok: false, reason: 'too_large' };
  if (bytes.byteLength === 0) return { ok: false, reason: 'malformed' };

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (jsonDepth(text) > maxDepth) return { ok: false, reason: 'too_deep' };

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

/**
 * Wraps a route handler so no failure escapes it.
 *
 * An uncaught throw in a route handler is answered by the framework, not by
 * us: in development that body is a stack trace, and in every environment it
 * is outside the vocabulary the iOS client understands. A dropped database
 * connection is the ordinary way this happens, and the honest answer to it is
 * "unavailable" - the same word an undeployed database already gets.
 */
export function route(
  scope: string,
  handler: (request: Request) => Promise<Response>,
  onError: (request: Request) => Response = () => jsonError('unavailable', 503),
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    try {
      return await handler(request);
    } catch (error) {
      logServerError(scope, error);
      return onError(request);
    }
  };
}
