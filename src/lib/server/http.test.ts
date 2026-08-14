// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  MAX_BODY_BYTES,
  MAX_JSON_DEPTH,
  jsonDepth,
  jsonError,
  jsonOk,
  readJsonBody,
  route,
} from './http';

/**
 * The request/response layer.
 *
 * Next.js App Router route handlers have no body size limit of their own, so
 * everything asserted here is the app's own work rather than the framework's.
 * These run with no database, which is the point: a 50MB PUT never reaches the
 * database, so the defence has to be testable without one.
 */

function jsonRequest(body: string, contentType = 'application/json'): Request {
  return new Request('http://localhost/api/profile', {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body,
  });
}

/** A request whose size is only discoverable by reading it. */
function streamedRequest(chunks: string[], contentType = 'application/json'): Request {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request('http://localhost/api/profile', {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: stream,
    // Required by undici for a streaming request body.
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

describe('readJsonBody', () => {
  it('accepts an ordinary profile payload', async () => {
    const result = await readJsonBody(jsonRequest(JSON.stringify({ profile: { xp: 10 } })));
    expect(result).toEqual({ ok: true, value: { profile: { xp: 10 } } });
  });

  it('refuses a body larger than the limit before parsing it', async () => {
    // 50MB, the payload the audit was written for. Declared honestly, so this
    // is refused on the content-length alone.
    const body = `{"profile":"${'x'.repeat(50 * 1024 * 1024)}"}`;
    const result = await readJsonBody(jsonRequest(body));
    expect(result).toEqual({ ok: false, reason: 'too_large' });
  });

  it('refuses an oversized body that does not declare its length', async () => {
    // A streamed body carries no content-length, so only the running total
    // catches it. Without that the header check is trivially bypassed.
    const chunk = 'x'.repeat(8 * 1024);
    const chunks = ['{"profile":"', ...Array<string>(32).fill(chunk), '"}'];
    const result = await readJsonBody(streamedRequest(chunks));
    expect(result).toEqual({ ok: false, reason: 'too_large' });
  });

  it('accepts a body right up to the limit', async () => {
    const padding = 'x'.repeat(MAX_BODY_BYTES - 32);
    const result = await readJsonBody(jsonRequest(JSON.stringify({ profile: padding })));
    expect(result.ok).toBe(true);
  });

  it('refuses a deeply nested body without parsing it', async () => {
    // Small enough to pass every size check and still recursive to parse.
    const depth = MAX_JSON_DEPTH + 50;
    const bomb = '['.repeat(depth) + ']'.repeat(depth);
    expect(bomb.length).toBeLessThan(MAX_BODY_BYTES);
    const result = await readJsonBody(jsonRequest(bomb));
    expect(result).toEqual({ ok: false, reason: 'too_deep' });
  });

  it('accepts nesting up to the limit', async () => {
    const nested = '['.repeat(MAX_JSON_DEPTH) + ']'.repeat(MAX_JSON_DEPTH);
    expect(await readJsonBody(jsonRequest(nested))).toEqual({ ok: true, value: expect.anything() });
  });

  it('refuses a body that is not JSON at all', async () => {
    expect(await readJsonBody(jsonRequest('{not json'))).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(await readJsonBody(jsonRequest(''))).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a body whose content type is not JSON', async () => {
    // A cross-site form POST cannot set application/json, so requiring it is a
    // second lock on the same door SameSite=Lax already holds shut.
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      expect(await readJsonBody(jsonRequest('{}', type))).toEqual({
        ok: false,
        reason: 'unsupported_media_type',
      });
    }
  });

  it('accepts the content type navigator.sendBeacon sends, with a charset', async () => {
    const result = await readJsonBody(jsonRequest('{"profile":{}}', 'application/json; charset=utf-8'));
    expect(result.ok).toBe(true);
  });

  it('refuses bytes that are not valid UTF-8', async () => {
    const request = new Request('http://localhost/api/profile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
    });
    expect(await readJsonBody(request)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('jsonDepth', () => {
  it('counts bracket nesting', () => {
    expect(jsonDepth('{}')).toBe(1);
    expect(jsonDepth('{"a":{"b":[1]}}')).toBe(3);
    expect(jsonDepth('1')).toBe(0);
  });

  it('ignores brackets inside strings, including escaped quotes', () => {
    expect(jsonDepth('{"a":"[[[[[["}')).toBe(1);
    expect(jsonDepth('{"a":"\\"[[["}')).toBe(1);
  });

  it('does not recurse, so a bomb cannot blow the stack while measuring it', () => {
    const bomb = '['.repeat(200_000) + ']'.repeat(200_000);
    expect(jsonDepth(bomb)).toBe(200_000);
  });
});

describe('responses', () => {
  it('marks every answer no-store', async () => {
    expect(jsonOk({ ok: true }).headers.get('cache-control')).toBe('no-store');
    expect(jsonError('invalid', 400).headers.get('cache-control')).toBe('no-store');
  });

  it('says only the one word, with no detail attached', async () => {
    const body = (await jsonError('unavailable', 503).json()) as Record<string, unknown>;
    expect(body).toEqual({ error: 'unavailable' });
  });
});

describe('route', () => {
  it('passes a successful answer through untouched', async () => {
    const handler = route('test', async () => jsonOk({ ok: true }));
    const response = await handler(new Request('http://localhost/api/test'));
    expect(response.status).toBe(200);
  });

  it('turns a thrown database error into "unavailable", not a stack trace', async () => {
    // What a dropped connection actually looks like: postgres.js hangs the
    // query and its parameters - which include a PIN hash - off the error.
    const leaky = Object.assign(new Error('connection terminated'), {
      query: 'insert into trainers (id, name_key, display_name, pin_hash) values ($1,$2,$3,$4)',
      parameters: ['id', 'leo', 'Leo', 'deadbeef:cafe'],
    });
    const handler = route('test', async () => {
      throw leaky;
    });

    const response = await handler(new Request('http://localhost/api/test'));
    expect(response.status).toBe(503);

    const text = await response.text();
    expect(text).toBe('{"error":"unavailable"}');
    expect(text).not.toContain('pin_hash');
    expect(text).not.toContain('connection terminated');
    expect(text).not.toContain('deadbeef');
  });

  it('uses the caller-supplied fallback when there is one', async () => {
    const handler = route(
      'test',
      async () => {
        throw new Error('boom');
      },
      () => new Response(null, { status: 302, headers: { location: '/login?error=unavailable' } }),
    );
    const response = await handler(new Request('http://localhost/api/test'));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login?error=unavailable');
  });
});
