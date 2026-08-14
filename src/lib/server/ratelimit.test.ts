// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUTH_RULE,
  PROFILE_RULE,
  checkRateLimit,
  clientKey,
  resetRateLimits,
} from './ratelimit';

/**
 * The throttle that sits above the per-account lockout.
 *
 * The lockout answers "five guesses at Leo's PIN". These tests answer "a
 * thousand guesses at a thousand names", which the lockout never sees because
 * every fresh name starts with a fresh five.
 *
 * Time is a parameter, so the window is proved to open and close without any
 * test sleeping.
 */

const RULE = { limit: 3, windowMs: 1000 };

beforeEach(() => {
  resetRateLimits();
});

describe('checkRateLimit', () => {
  it('allows up to the limit and refuses the next one', () => {
    for (let i = 0; i < RULE.limit; i += 1) {
      expect(checkRateLimit('a', RULE, 0).allowed).toBe(true);
    }
    expect(checkRateLimit('a', RULE, 0).allowed).toBe(false);
  });

  it('counts each key separately', () => {
    for (let i = 0; i < RULE.limit + 1; i += 1) checkRateLimit('a', RULE, 0);
    expect(checkRateLimit('b', RULE, 0).allowed).toBe(true);
  });

  it('opens a fresh window once the old one expires', () => {
    for (let i = 0; i < RULE.limit + 1; i += 1) checkRateLimit('a', RULE, 0);
    expect(checkRateLimit('a', RULE, 999).allowed).toBe(false);
    expect(checkRateLimit('a', RULE, 1000).allowed).toBe(true);
  });

  it('reports whole seconds to wait, never zero while refusing', () => {
    for (let i = 0; i < RULE.limit + 1; i += 1) checkRateLimit('a', RULE, 0);
    expect(checkRateLimit('a', RULE, 500).retryAfterSeconds).toBe(1);
    expect(checkRateLimit('a', RULE, 999).retryAfterSeconds).toBe(1);
  });

  it('counts down the remaining allowance', () => {
    expect(checkRateLimit('a', RULE, 0).remaining).toBe(2);
    expect(checkRateLimit('a', RULE, 0).remaining).toBe(1);
    expect(checkRateLimit('a', RULE, 0).remaining).toBe(0);
  });

  it('stops a name-rotating flood, which the account lockout cannot see', () => {
    // Each name gets its own fresh five failures from loginWithPin, so 200
    // names is 200 unlocked accounts and no lockout anywhere. The address is
    // the same throughout, which is what this catches.
    let allowed = 0;
    for (let i = 0; i < 200; i += 1) {
      if (checkRateLimit('pin:203.0.113.7', AUTH_RULE, 0).allowed) allowed += 1;
    }
    expect(allowed).toBe(AUTH_RULE.limit);
  });

  it('never refuses a request just because other keys are busy', () => {
    // The table is bounded, and the bound must not become a way to switch the
    // game off for everyone: filling it with junk keys still leaves a real one
    // able to play.
    for (let i = 0; i < 20_000; i += 1) checkRateLimit(`junk:${i}`, AUTH_RULE, 0);
    expect(checkRateLimit('pin:198.51.100.4', AUTH_RULE, 0).allowed).toBe(true);
  });
});

describe('the configured rules', () => {
  it('leaves a child far more room than a mistyped PIN needs', () => {
    expect(AUTH_RULE.limit).toBeGreaterThanOrEqual(10);
    expect(PROFILE_RULE.limit).toBeGreaterThanOrEqual(60);
  });

  it('keeps both windows short enough that a lockout is never the sign-in path', () => {
    expect(AUTH_RULE.windowMs).toBeLessThanOrEqual(60_000);
    expect(PROFILE_RULE.windowMs).toBeLessThanOrEqual(60_000);
  });
});

describe('clientKey', () => {
  function withHeaders(headers: Record<string, string>): Request {
    return new Request('http://localhost/api/auth/pin', { headers });
  }

  it('prefers the header the platform sets over the one the client can forge', () => {
    const request = withHeaders({
      'x-vercel-forwarded-for': '203.0.113.7',
      'x-forwarded-for': '10.0.0.1',
    });
    expect(clientKey(request)).toBe('203.0.113.7');
  });

  it('takes only the first hop of a forwarded chain', () => {
    expect(clientKey(withHeaders({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe(
      '203.0.113.7',
    );
  });

  it('falls back to x-real-ip, then to a single shared bucket', () => {
    expect(clientKey(withHeaders({ 'x-real-ip': '198.51.100.4' }))).toBe('198.51.100.4');
    expect(clientKey(withHeaders({}))).toBe('unknown');
  });

  it('never returns an empty key, which would merge every caller silently', () => {
    expect(clientKey(withHeaders({ 'x-forwarded-for': '  ' }))).toBe('unknown');
  });
});
