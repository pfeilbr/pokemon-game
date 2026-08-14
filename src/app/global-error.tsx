'use client';

import { ErrorRecovery } from '@/components/ErrorRecovery';
import './globals.css';

/**
 * The last boundary: it catches what `app/error.tsx` cannot.
 *
 * `error.tsx` lives *inside* the root layout, so anything the layout itself
 * throws - `GameProvider`, the service-worker registrar, a bad metadata read -
 * goes straight past it and blanks the page. This file replaces the whole
 * document instead, which is why it has to supply its own `<html>` and
 * `<body>`: React has thrown the layout's away.
 *
 * The styling is repeated here rather than shared with the layout for the same
 * reason the recovery screen avoids `AppShell`: the less this file depends on,
 * the fewer ways it has to fail while it is failing.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="min-h-[100dvh] bg-slate-950 text-slate-100 antialiased">
        <ErrorRecovery error={error} reset={reset} />
      </body>
    </html>
  );
}
