/**
 * Backend client.
 *
 * Talks to the same Next.js API the web app uses, so accounts and saved
 * progress are shared between the two clients rather than forked.
 *
 * The base URL is build-time configuration, never a hardcoded host: set
 * EXPO_PUBLIC_API_URL when building. With none set the client runs in
 * local-only mode, which mirrors how the web app behaves with no database.
 */

export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? '';

export type SessionInfo = {
  signedIn: boolean;
  trainerName: string | null;
  provider: 'pin' | 'google' | null;
  accountsAvailable: boolean;
  googleAvailable: boolean;
};

export type BackendStatus =
  | { kind: 'not-configured' }
  | { kind: 'reachable'; session: SessionInfo }
  | { kind: 'unreachable'; reason: string };

/** Requests give up rather than hanging a splash screen forever. */
const TIMEOUT_MS = 8000;

export async function fetchSession(baseUrl = API_BASE_URL): Promise<BackendStatus> {
  if (!baseUrl) return { kind: 'not-configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/session`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return { kind: 'unreachable', reason: `HTTP ${response.status}` };

    const body = (await response.json()) as Partial<SessionInfo>;
    // Trust nothing off the wire: the shell must not crash on a bad payload.
    if (typeof body.accountsAvailable !== 'boolean') {
      return { kind: 'unreachable', reason: 'unexpected response shape' };
    }

    return {
      kind: 'reachable',
      session: {
        signedIn: body.signedIn === true,
        trainerName: typeof body.trainerName === 'string' ? body.trainerName : null,
        provider: body.provider === 'pin' || body.provider === 'google' ? body.provider : null,
        accountsAvailable: body.accountsAvailable,
        googleAvailable: body.googleAvailable === true,
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'network error';
    return { kind: 'unreachable', reason };
  } finally {
    clearTimeout(timer);
  }
}
