'use client';

import { useEffect, useState } from 'react';
import { getCreature } from '@/lib/game/creatures';

/**
 * A deliberate render crash, for proving the error boundary.
 *
 * An error boundary nobody has ever seen catch anything is decoration. The
 * only honest way to test one is to make a component throw for real, inside a
 * real production build, and watch what the child gets - so this is the thing
 * that throws.
 *
 * Why it is armed the way it is
 * -----------------------------
 * The obvious hook, `?crash=1`, is a *link*: it can be bookmarked, shared,
 * mistyped into existence, or restored by a browser on startup. A hook a
 * seven-year-old can reach by accident is not a test hook.
 *
 * Both of these must hold instead, and neither survives a link:
 *
 *   1. `navigator.webdriver` is true. The browser sets it, not the page, and it
 *      is true only under an automation harness (Playwright, WebDriver). A
 *      child's tablet reports false, always.
 *   2. `window.__mathmonFaultProbe` was set to the exact sentinel *before* this
 *      component mounted, which off a test harness means someone typed it into
 *      a devtools console on purpose.
 *
 * Why it does not simply `throw new Error('boom')`
 * ------------------------------------------------
 * The failure this app can really have is the one CLAUDE.md describes: the
 * engine throws on invalid data (`getCreature` throws on an unknown id) and the
 * boundary repairs it. Calling `getCreature` with an id this build does not
 * have reproduces that exactly - a creature removed from the roster while a
 * save, a URL or a service-worker-cached page still names it - rather than a
 * synthetic error that no real code path could produce.
 *
 * And if both guards somehow held for a real player, the worst that happens is
 * the recovery screen, which offers "try again" and a way home and touches
 * nothing that is saved.
 */

declare global {
  interface Window {
    __mathmonFaultProbe?: string;
  }
}

const SENTINEL = 'render-crash';

/** An id no build has ever had, so the roster can never accidentally define it. */
const MISSING_CREATURE_ID = '__fault-probe-creature-that-does-not-exist__';

function armed(): boolean {
  if (typeof window === 'undefined') return false;
  if (!window.navigator?.webdriver) return false;
  return window.__mathmonFaultProbe === SENTINEL;
}

export function FaultProbe() {
  const [fire, setFire] = useState(false);

  // Checked in an effect, not during render: reading `window` while rendering
  // would make the server and client markup disagree on every page. The effect
  // runs after mount, sets state, and the *next* render throws - which is an
  // ordinary render error, caught by an ordinary error boundary, exactly like
  // the real thing would be.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (armed()) setFire(true);
  }, []);

  if (fire) getCreature(MISSING_CREATURE_ID);
  return null;
}
