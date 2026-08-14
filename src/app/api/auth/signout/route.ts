import { jsonOk, route } from '@/lib/server/http';
import { clearSessionCookie } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

export const POST = route('POST /api/auth/signout', async () => {
  await clearSessionCookie();
  return jsonOk({ ok: true });
});
