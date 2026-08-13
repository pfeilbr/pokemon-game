import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSession } from './api';

/**
 * The client half of the API contract.
 *
 * A phone is on a worse network than a laptop and will meet every one of these
 * cases, so none of them may crash the app: no URL configured, the server down,
 * an HTML error page from a proxy, or a payload that does not match.
 */

const ok = (body: unknown) =>
  vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });

afterEach(() => vi.unstubAllGlobals());

describe('fetchSession', () => {
  it('reports local-only mode when no API URL is configured', async () => {
    expect(await fetchSession('')).toEqual({ kind: 'not-configured' });
  });

  it('parses a healthy response from the real endpoint shape', async () => {
    vi.stubGlobal(
      'fetch',
      ok({
        signedIn: false,
        trainerName: null,
        provider: null,
        accountsAvailable: true,
        googleAvailable: false,
      }),
    );

    const result = await fetchSession('https://example.test');
    expect(result.kind).toBe('reachable');
    if (result.kind === 'reachable') {
      expect(result.session.accountsAvailable).toBe(true);
      expect(result.session.signedIn).toBe(false);
    }
  });

  it('normalises a trailing slash rather than requesting a double slash', async () => {
    const fetchMock = ok({ accountsAvailable: false });
    vi.stubGlobal('fetch', fetchMock);

    await fetchSession('https://example.test/');
    expect(fetchMock.mock.calls[0]![0]).toBe('https://example.test/api/session');
  });

  it('treats an HTTP error as unreachable instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) }),
    );
    expect(await fetchSession('https://example.test')).toEqual({
      kind: 'unreachable',
      reason: 'HTTP 502',
    });
  });

  it('survives a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const result = await fetchSession('https://example.test');
    expect(result).toEqual({ kind: 'unreachable', reason: 'offline' });
  });

  it('survives a response that is not the JSON we expect', async () => {
    // A captive portal or proxy returning HTML is the classic phone failure.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token <');
        },
      }),
    );
    expect((await fetchSession('https://example.test')).kind).toBe('unreachable');
  });

  it('rejects a well-formed response missing the field it depends on', async () => {
    vi.stubGlobal('fetch', ok({ signedIn: true }));
    expect(await fetchSession('https://example.test')).toEqual({
      kind: 'unreachable',
      reason: 'unexpected response shape',
    });
  });

  it('coerces hostile field types instead of trusting them', async () => {
    vi.stubGlobal(
      'fetch',
      ok({ accountsAvailable: true, signedIn: 'yes', provider: 'evil', trainerName: 42 }),
    );
    const result = await fetchSession('https://example.test');
    expect(result.kind).toBe('reachable');
    if (result.kind === 'reachable') {
      expect(result.session.signedIn).toBe(false);
      expect(result.session.provider).toBeNull();
      expect(result.session.trainerName).toBeNull();
    }
  });
});
