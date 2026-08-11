import { NextResponse } from 'next/server';
import { normaliseProfile } from '@/lib/game/progress';
import { loadProfile, saveProfile } from '@/lib/server/accounts';
import { readSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await readSession();
  if (!session) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });

  const profile = await loadProfile(session.trainerId);
  return NextResponse.json({ profile }, { headers: { 'cache-control': 'no-store' } });
}

export async function PUT(request: Request) {
  const session = await readSession();
  if (!session) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }

  // Never trust the client's shape. Normalising here means a tampered or
  // simply outdated payload cannot poison the stored save.
  const profile = normaliseProfile((body as { profile?: unknown })?.profile);
  if (!profile) return NextResponse.json({ error: 'bad profile' }, { status: 400 });

  const saved = await saveProfile(session.trainerId, profile);
  if (!saved) return NextResponse.json({ error: 'not saved' }, { status: 500 });

  return NextResponse.json({ ok: true });
}

/** navigator.sendBeacon posts rather than puts, so accept both. */
export const POST = PUT;
