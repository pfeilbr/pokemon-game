import { accountsAvailable, googleAvailable } from '@/lib/server/env';
import { jsonOk, route } from '@/lib/server/http';
import { readSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/** Tells the client who is signed in and which sign-in methods this deploy has. */
export const GET = route('GET /api/session', async () => {
  const session = await readSession();
  return jsonOk({
    signedIn: session !== null,
    trainerName: session?.displayName ?? null,
    provider: session?.provider ?? null,
    accountsAvailable: accountsAvailable(),
    googleAvailable: googleAvailable(),
  });
});
