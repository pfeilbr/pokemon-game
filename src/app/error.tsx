'use client';

import { ErrorRecovery } from '@/components/ErrorRecovery';

/**
 * The route-segment error boundary.
 *
 * Every page in this app is a client component that renders engine values -
 * `getCreature(partnerFor(profile))` on the dashboard, a whole battle reducer
 * on `/play` - and the engine throws on invalid data by design. Without this
 * file that throw is an unhandled render error, and an unhandled render error
 * in the App Router unmounts the tree and leaves a blank white page.
 *
 * Being at `app/` it covers every page below it, including any added later,
 * which is deliberate: a boundary you have to remember to add per route is a
 * boundary that will be missing from exactly the route that breaks.
 *
 * Errors thrown by the root layout itself escape this one - they happen above
 * it - which is what `app/global-error.tsx` is for.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorRecovery error={error} reset={reset} />;
}
