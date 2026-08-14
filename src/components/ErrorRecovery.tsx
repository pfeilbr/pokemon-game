'use client';

import Link from 'next/link';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Language } from '@/lib/game/progress';
import { t } from '@/lib/i18n';
import { languageFromSave, recoveryPlan } from '@/lib/recovery';
import { STORAGE_KEY, clearLocal } from '@/lib/storage/client';
import { Button } from './ui';

/**
 * What a child sees instead of a blank page.
 *
 * The engine throws on invalid data by design (`getCreature` throws on an
 * unknown id) and repairs it at the boundary instead - that is the right call,
 * and CLAUDE.md says so. The cost is that a React render *can* throw, and an
 * unhandled render error in the App Router is a white screen. The player is
 * seven, often alone with a tablet: a white screen is indistinguishable from
 * the game having been taken away, and there is nobody nearby who will think to
 * open devtools.
 *
 * So this screen has exactly three jobs, in order:
 *
 *   1. Say, in the player's own language, that nothing is lost.
 *   2. Offer a big obvious "try again" - most render crashes are transient.
 *   3. Always keep a way home. A crash must never strand him on one screen.
 *
 * It is deliberately standalone: no `AppShell`, no `useGame`, no creature art.
 * Everything it does not render is something that cannot crash it in turn, and
 * a fallback that throws is a white screen with extra steps. The same component
 * therefore serves both `app/error.tsx` (inside the layout, context available)
 * and `app/global-error.tsx` (the layout itself is gone), which is why it reads
 * the language from storage rather than from React context.
 */

/**
 * Failed retries in this tab.
 *
 * Not in component state: React may hand a fresh error to the same boundary or
 * remount it, and a counter that silently reset would keep hiding the only
 * remaining exit from a child stuck in a repeating crash. sessionStorage is
 * per-tab, dies with the tab, and holds no game data.
 */
const RETRY_KEY = 'mathmon.crash.retries';

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // A save edited in another tab changes the language this screen should use.
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

function readRetries(): number {
  try {
    const raw = window.sessionStorage.getItem(RETRY_KEY);
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

function bumpRetries(): void {
  try {
    window.sessionStorage.setItem(RETRY_KEY, String(readRetries() + 1));
  } catch {
    // Private mode, or a full quota. The counter is a nicety; the exits are not.
  }
  notify();
}

function clearRetries(): void {
  try {
    window.sessionStorage.removeItem(RETRY_KEY);
  } catch {
    // Same as above: nothing here is worth a second crash.
  }
}

function readLanguage(): Language {
  try {
    return languageFromSave(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return 'en';
  }
}

export function ErrorRecovery({ error, reset }: { error?: unknown; reset: () => void }) {
  // Read through `useSyncExternalStore` rather than in an effect: these are
  // external stores, and it is the one hook that reads them without either a
  // hydration mismatch or a flash of the wrong language.
  const language = useSyncExternalStore(subscribe, readLanguage, () => 'en' as Language);
  const failedRetries = useSyncExternalStore(subscribe, readRetries, () => 0);
  const [confirmingErase, setConfirmingErase] = useState(false);

  const plan = recoveryPlan(failedRetries);

  useEffect(() => {
    // The child cannot read a stack trace and must not be shown one. A parent
    // with a console can.
    if (error) console.error('Mathmon crashed:', error);
  }, [error]);

  return (
    <main
      data-testid="crash-recovery"
      className="mx-auto flex min-h-[100dvh] w-full max-w-lg flex-col items-center justify-center gap-5 px-5 py-10 text-center"
    >
      <span className="text-7xl" aria-hidden>
        🩹
      </span>

      <h1 className="text-2xl font-black text-white sm:text-3xl">{t('crashTitle', language)}</h1>

      {/* The reassurance is the point of the screen, so it is not small print. */}
      <p className="text-base font-semibold text-slate-300">{t('crashBody', language)}</p>

      <div className="flex w-full flex-col gap-3">
        {plan.canRetry && (
          <Button
            size="lg"
            full
            data-testid="crash-try-again"
            onClick={() => {
              bumpRetries();
              reset();
            }}
          >
            {t('tryAgain', language)}
          </Button>
        )}

        {plan.canGoHome && (
          <Link
            href="/"
            data-testid="crash-go-home"
            onClick={clearRetries}
            className="tap inline-flex w-full items-center justify-center rounded-2xl border border-white/15 bg-white/5 px-5 py-3.5 text-lg font-extrabold text-slate-200"
          >
            {t('goHome', language)}
          </Link>
        )}
      </div>

      {/* The destructive door only exists once the safe one has failed, and it
          still takes two deliberate taps and a sentence that names the cost.
          Nothing on this screen ever clears the save on its own: a child who
          loses his album to an automatic "repair" has lost more than the
          crash ever took from him. */}
      {plan.offerErase &&
        (confirmingErase ? (
          <div className="panel flex w-full flex-col gap-3 p-4" data-testid="crash-erase-confirm">
            <p className="text-sm font-bold text-rose-300">{t('eraseSaveWarning', language)}</p>
            <div className="flex gap-2">
              <Button variant="ghost" full onClick={() => setConfirmingErase(false)}>
                {t('back', language)}
              </Button>
              <Button
                variant="danger"
                full
                data-testid="crash-erase-confirmed"
                onClick={() => {
                  clearLocal();
                  clearRetries();
                  // A full reload, not `reset()`: the point is to start from
                  // nothing, and in-memory state is part of the nothing.
                  window.location.reload();
                }}
              >
                {t('deleteProgress', language)}
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            data-testid="crash-still-stuck"
            onClick={() => setConfirmingErase(true)}
            className="tap flex w-full items-center justify-center text-sm text-slate-500 underline"
          >
            {t('stillStuck', language)}
          </button>
        ))}
    </main>
  );
}
