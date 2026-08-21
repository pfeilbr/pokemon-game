import type { RemoteSave } from '../api';
import { type Profile, reconcile } from '../engine';

/**
 * Coming back to the app.
 *
 * The gap this closes: the server used to be read on launch and on sign-in and
 * at no other moment. A React Native app is one process that lives for weeks,
 * so "launch" can be a fortnight ago. A child who played on the laptop and then
 * picked up the iPad — where the app had been backgrounded since breakfast —
 * saw the album as it stood at breakfast, and the only way out was to force-quit
 * an app, which a seven-year-old does not know how to do and should not have to.
 * A stale album does not read as "stale". It reads as his creatures being gone.
 *
 * Both halves of the answer are pure functions and live here rather than in
 * `GameContext`, so what is under test is the decision — did this fire, and did
 * it change exactly one thing about the save — rather than whether a component
 * re-rendered.
 *
 * Three things this must never become:
 *
 * 1. **A gate.** The device save is what the game plays from; that is the
 *    promise in `CLAUDE.md` and in `mobile/README.md`, and signing in is an
 *    upgrade on top of it. So nothing here blocks a screen, nothing here shows
 *    a spinner, and a pull that fails changes nothing and says nothing. A child
 *    on a train must not be able to tell that a request was even attempted.
 * 2. **A second merge rule.** The answer to "whose save wins" is `reconcile`,
 *    in the shared engine, reached through `mobile/src/engine.ts` — the same
 *    function the web client resolves a sign-in with. A phone and a browser
 *    that disagreed about which save is newer would lose an album between them,
 *    which is precisely the bug the merge was written to end.
 * 3. **A loop.** See `applyRemoteSave` for why a converged pair of devices goes
 *    quiet instead of pushing at each other.
 */

/** React Native's `AppStateStatus`, restated so this module imports no platform. */
export type AppPhase = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';

/**
 * How long since the last time the server actually answered before a return to
 * the foreground is worth another request.
 *
 * One minute. The number is bounded on both sides:
 *
 * - It has to be long enough that flicking between apps is free. Switching to
 *   the camera and back takes seconds, and a child does that repeatedly; at one
 *   minute a burst of switching costs one request, not one per switch.
 * - It has to be short enough that a hand-off is never stale. The case this
 *   exists for is *another device has been played on since*, which takes a
 *   session on that device — minutes at least. There is nothing a child can
 *   earn on the laptop inside sixty seconds that the iPad then shows wrongly
 *   for long, because the next foreground after that minute picks it up.
 *
 * For scale: `SYNC_DEBOUNCE_MS` is 1.2 seconds, so a single battle already
 * mirrors the save to the server several times over. A refresh capped at one
 * per minute cannot be a meaningful share of this app's traffic or of its
 * battery, which is the only reason to have a floor at all.
 */
export const FOREGROUND_REFRESH_MIN_MS = 60_000;

export type RefreshInput = {
  /** The phase the app was in before this event. */
  previous: AppPhase;
  /** The phase it is in now. */
  next: AppPhase;
  signedIn: boolean;
  /** When the server last answered, from `Date.now()`. Null if it never has. */
  lastPullAt: number | null;
  now: number;
  /** True while the debounced mirror-to-server is still waiting to fire. */
  pushQueued: boolean;
};

/** Why the answer was what it was. Diagnostic; nothing renders it. */
export type RefreshReason = 'pull' | 'not-a-foreground' | 'local-only' | 'too-soon' | 'push-queued';

export type RefreshPlan = { pull: boolean; reason: RefreshReason };

/**
 * Whether an app-state change is worth a read of the server.
 *
 * The gates are ordered by how strong the objection is.
 *
 * `local-only` comes first and is absolute: a player with no account issues no
 * requests at all, ever. Not a failed one, not a cheap one. That is what makes
 * an account an upgrade rather than a thing the app quietly needs.
 *
 * `push-queued` is the one worth explaining. `GameContext` debounces its push
 * by `SYNC_DEBOUNCE_MS`, so a queued push means this device holds changes the
 * server has not heard yet — it is the *ahead* device, not the stale one.
 * Pulling first would fetch a server copy that predates those changes, merge
 * them back in (correctly — `reconcile` merges), and then push, which is two
 * round trips to reach the state the one already-queued push reaches by itself.
 * Skipping is not a lost refresh: the push fires 1.2 seconds later, and the
 * next foreground finds `pushQueued` false.
 *
 * A foreground is any transition *into* `active` from something else.
 * Deliberately not "from `background`": on iPad the app-switcher path back can
 * be `background → inactive → active`, and requiring the previous phase to be
 * `background` would silently never fire there. `inactive → active` also covers
 * the trivial cases — a notification banner pulled down and dismissed — but
 * those are what the interval floor is for.
 */
export function planRefresh(input: RefreshInput): RefreshPlan {
  if (input.next !== 'active' || input.previous === 'active') {
    return { pull: false, reason: 'not-a-foreground' };
  }
  if (!input.signedIn) return { pull: false, reason: 'local-only' };
  if (input.pushQueued) return { pull: false, reason: 'push-queued' };

  if (input.lastPullAt !== null) {
    const elapsed = input.now - input.lastPullAt;
    // A negative elapsed means the device clock moved backwards, which on this
    // codebase's own evidence really happens. The floor is a courtesy to the
    // battery, not a safeguard, so a bad clock must not be able to wedge it
    // shut - fall through and refresh.
    if (elapsed >= 0 && elapsed < FOREGROUND_REFRESH_MIN_MS) {
      return { pull: false, reason: 'too-soon' };
    }
  }

  return { pull: true, reason: 'pull' };
}

/**
 * JSON with every object's keys in a fixed order.
 *
 * Used for one question only: does the server already hold exactly this save?
 * Reference identity answers it whenever `reconcile` hands back one of the two
 * objects it was given, but not when it hands back the *device's* object and
 * the server's copy happens to be an equal-but-separate one - which is the
 * steady state of a synced pair, arriving fresh off the wire on every read.
 * Treating that as "the server is behind" would put a PUT on the end of every
 * single foreground refresh, forever, on every device. That is the loop this
 * feature could most easily have shipped with.
 *
 * Sorted rather than raw `JSON.stringify` so the answer cannot depend on the
 * order two code paths happened to build the same fields in. A profile is small
 * and `normaliseProfile` bounds its shape by construction, so this is cheap.
 */
function canonical(profile: Profile): string {
  return JSON.stringify(profile, (_key, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : value,
  );
}

/** Is what the server holds already this save? A missing server copy is not. */
function serverHas(winner: Profile, server: Profile | null): boolean {
  if (server === null) return false;
  return winner === server || canonical(winner) === canonical(server);
}

export type PullOutcome = {
  /** What the game plays from after this pull. Never null if it was not before. */
  profile: Profile | null;
  /** Whether the device save actually changed and has to be rewritten. */
  writeDevice: boolean;
  /** Whether the server is the side that is behind. */
  pushBack: boolean;
};

/**
 * What a server answer means for the save on this device.
 *
 * `reconcile` does the deciding, and it is the shared one. Everything this adds
 * is the two booleans, and both are reference comparisons against what
 * `reconcile` returned, which is the contract `mergeEarned` publishes: it
 * returns the base profile *itself* when the other side has nothing to add.
 * That is what stops a loop, and it is worth being explicit about because a
 * refresh is exactly where one would form:
 *
 * - Server ahead, device has nothing extra → the winner *is* the server's
 *   object, so `pushBack` is false. One GET, no PUT. This is the hand-off case
 *   the whole feature exists for, and it costs a single request.
 * - Device ahead → the server does not hold this save, so it is pushed once.
 *   The server then does hold it, so the next foreground pulls back a copy
 *   equal to what is already here and pushes nothing. Two devices converge in
 *   one round each and then go quiet; they cannot ping-pong, because after the
 *   first exchange neither has anything the other lacks. "Does the server hold
 *   this?" is `serverHas` rather than a bare `!==`, and the difference is not
 *   cosmetic - see the note there.
 * - Both diverged → the winner is a new object, unequal to both, so the device
 *   is rewritten and the server is caught up. Merged, never replaced: whatever
 *   either side caught is in the union.
 *
 * And the miss: `unavailable` returns the caller's own profile object
 * untouched, with both booleans false. No write, no request, no state change,
 * nothing said. A flat network is indistinguishable from never having asked.
 *
 * `none` — reachable, but this account has no save stored — is deliberately
 * *not* a miss. It is the first sign-in on a fresh account, and the device is
 * the only copy that exists, so the server is the one that needs catching up.
 * Collapsing the two, as a plain `Profile | null` would, is what would turn a
 * dead network into a pointless upload attempt on every foreground.
 */
export function applyRemoteSave(local: Profile | null, remote: RemoteSave): PullOutcome {
  if (remote.kind === 'unavailable') {
    return { profile: local, writeDevice: false, pushBack: false };
  }

  const server = remote.kind === 'profile' ? remote.profile : null;
  const winner = reconcile(local, server);

  return {
    profile: winner,
    writeDevice: winner !== null && winner !== local,
    pushBack: winner !== null && !serverHas(winner, server),
  };
}
