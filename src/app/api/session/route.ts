import { NextResponse } from 'next/server';
import { accountsAvailable, googleAvailable } from '@/lib/server/env';
import { readSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/** Tells the client who is signed in and which sign-in methods this deploy has. */
export async function GET() {
  const session = await readSession();
  return NextResponse.json(
    {
      signedIn: session !== null,
      trainerName: session?.displayName ?? null,
      provider: session?.provider ?? null,
      accountsAvailable: accountsAvailable(),
      googleAvailable: googleAvailable(),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
