'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FaultProbe } from './FaultProbe';
import { useGame } from './GameProvider';
import { STRINGS } from '@/lib/i18n';

const NAV = [
  { href: '/', icon: '🏠', key: 'goHome' },
  { href: '/play', icon: '⚔️', key: 'battle' },
  { href: '/album', icon: '📗', key: 'album' },
  { href: '/progress', icon: '🏆', key: 'progress' },
] as const;

/** Header plus a bottom tab bar on small screens. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { profile, language, session, syncState, tr } = useGame();
  const pathname = usePathname();

  const syncLabel =
    syncState === 'saving'
      ? tr('syncing')
      : session.signedIn
        ? tr('savedToAccount')
        : tr('savedLocally');

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-5xl flex-col">
      {/* Renders nothing. It sits here, inside the page rather than the layout,
          because that is where `app/error.tsx` can catch what it throws - the
          same place a real page crash happens. See FaultProbe for how it is
          armed and why it cannot fire for a player. */}
      <FaultProbe />
      <header className="flex items-center justify-between gap-3 px-4 pt-4 pb-2">
        <Link href="/" className="flex items-center gap-2">
          <span className="text-2xl" aria-hidden>
            ⚡
          </span>
          <span className="text-lg font-black tracking-tight text-white sm:text-xl">
            {STRINGS.appShort[language]}
          </span>
        </Link>

        <div className="flex items-center gap-2">
          <span
            className="hidden items-center gap-1.5 rounded-full bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-300 sm:inline-flex"
            data-testid="sync-status"
          >
            <span
              aria-hidden
              className={`h-2 w-2 rounded-full ${
                syncState === 'saving'
                  ? 'animate-pulse bg-amber-300'
                  : session.signedIn
                    ? 'bg-emerald-400'
                    : 'bg-slate-500'
              }`}
            />
            {syncLabel}
          </span>

          {profile && !session.signedIn && session.accountsAvailable && (
            <Link
              href="/login"
              className="tap inline-flex items-center justify-center rounded-full bg-amber-400 px-4 text-sm font-extrabold text-slate-900"
            >
              {tr('signInToSave')}
            </Link>
          )}

          <Link
            href="/settings"
            aria-label={tr('settings')}
            className="tap flex h-11 w-11 items-center justify-center rounded-full bg-white/5 text-xl ring-1 ring-white/10"
          >
            ⚙️
          </Link>
        </div>
      </header>

      <main className="flex-1 px-4 pb-28 sm:pb-8">{children}</main>

      {/* Bottom tabs: thumb-reachable on a tablet, hidden once there is room. */}
      <nav
        className="fixed inset-x-0 bottom-0 z-20 border-t border-white/10 bg-slate-950/95 backdrop-blur sm:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <ul className="mx-auto flex max-w-lg">
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <li key={item.href} className="flex-1">
                <Link
                  href={item.href}
                  className={`flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-bold ${
                    active ? 'text-amber-300' : 'text-slate-400'
                  }`}
                >
                  <span className="text-2xl" aria-hidden>
                    {item.icon}
                  </span>
                  {STRINGS[item.key][language]}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
