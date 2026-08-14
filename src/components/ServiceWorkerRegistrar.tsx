'use client';

import { useEffect } from 'react';

/**
 * Registers `public/sw.js`, which is what makes the app survive losing signal.
 *
 * Renders nothing. Everything here is guarded, because this must never be the
 * reason a screen fails to appear: an old browser without `serviceWorker`, an
 * iOS private window where registration throws, or a host serving over plain
 * http all end up as a silent no-op and a game that simply works online.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    // Dev serves freshly compiled chunks on every keystroke, and a shell cache
    // in front of that is a bug generator rather than a feature.
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    /*
     * The static export is served from /<repo> on GitHub Pages, so the worker
     * URL and its scope both need that prefix - a worker registered at /sw.js
     * from a page at /mathmon/ would be refused for being out of scope. Next
     * inlines the configured basePath here at build time, so this is the same
     * value `next/link` uses rather than a second copy of it.
     */
    const base = process.env.__NEXT_ROUTER_BASEPATH ?? '';

    // Registration competes with the first paint for bandwidth, and the shell
    // precache is a handful of documents. Let the page settle first.
    const register = () => {
      navigator.serviceWorker.register(`${base}/sw.js`, { scope: `${base}/` }).catch(() => {
        // Unsupported, blocked by policy, or insecure origin. Online play is
        // unaffected; only the offline upgrade is missing.
      });
    };

    if (document.readyState === 'complete') {
      register();
      return;
    }
    window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);

  return null;
}
