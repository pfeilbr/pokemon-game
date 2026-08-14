/*
 * Mathmon's service worker: the part that makes "offline-first" true in the
 * browser rather than only true on paper.
 *
 * The game itself has never needed the network. The engine is pure, the profile
 * lives in localStorage, and `accountsAvailable()` already gates everything that
 * talks to a server. The one thing that still required a signal was the *shell*:
 * the HTML document and its JS/CSS. Add the app to an iPad home screen, get in a
 * car, lose the bars, and a child who owns a perfectly playable game gets a
 * blank page. This file closes exactly that gap and nothing else.
 *
 * Three strategies, one rule each:
 *
 *   /_next/static/*  cache-first. Those filenames contain a content hash, so a
 *                    given URL can never mean two different bytes. Going to the
 *                    network for them would be pure latency.
 *   navigations      network-first, falling back to the cached document. Online
 *                    a child always gets the newest deploy; offline he gets the
 *                    last one that reached him. Never a browser error page.
 *   /api/*           NOT CACHED, not even opportunistically. Those are session
 *                    and profile endpoints. A stale "you are signed in", or a
 *                    profile from two days ago replayed as if it were current,
 *                    is worse than an honest network failure - and the client
 *                    already degrades gracefully when they fail, because that is
 *                    what the zero-config deployment does every single day.
 */

/*
 * Cache version. Bump this whenever the strategies or the precache list below
 * change.
 *
 * Eviction: `activate` deletes every cache whose name is not the current one,
 * and a service worker only re-activates when its own bytes change - which
 * bumping this constant guarantees. So a new deploy drops the whole previous
 * shell in one step, rather than leaving a child pinned on an old build with no
 * way to ask for a new one. The alternative failure is silent and permanent,
 * which is why the version lives in a constant a human must touch rather than
 * being inferred from anything clever.
 *
 * Note that a stale *document* cannot survive a deploy anyway (navigations are
 * network-first) and a stale hashed asset cannot exist at all (the hash is in
 * the URL). What this eviction actually collects is the orphaned assets of
 * builds nobody will ever load again.
 */
const VERSION = 'v1';
const CACHE = `mathmon-shell-${VERSION}`;

/*
 * Where this worker is served from, which is also the app's base path.
 *
 * The static-export deployment lives under /<repo> on GitHub Pages, so every
 * URL below has to carry that prefix. Deriving it from the worker's own
 * location means the same file is correct on Vercel (base "") and on Pages
 * (base "/mathmon") with nothing injected at build time.
 */
const BASE = self.location.pathname.replace(/\/sw\.js$/, '');

/** Absolute URL for an app-relative path. */
const at = (path) => new URL(BASE + path, self.location.origin).href;

/*
 * The screens a child can reach with no signal. `/login` is deliberately absent:
 * it is the one screen that genuinely needs a server, and precaching it would
 * promise something the deployment cannot keep.
 */
const SHELL_ROUTES = ['/', '/start', '/play', '/album', '/progress', '/settings'];

/** Non-hashed static files the shell references by a fixed name. */
const SHELL_FILES = ['/manifest.webmanifest', '/icon.svg'];

/**
 * Hashed build assets referenced by a document.
 *
 * A precache list of chunk filenames cannot be written by hand - they change
 * every build - and this repo would rather read them off the shipped HTML than
 * grow a build step and a generated manifest to hold a copy of them.
 */
const assetPattern = () =>
  new RegExp(`${BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/_next/static/[^"'\\\\\\s>)]+`, 'g');

function assetsIn(html) {
  return new Set(
    (html.match(assetPattern()) ?? []).map((path) => new URL(path, self.location).href),
  );
}

/*
 * A response that followed a redirect cannot be handed back to a navigation -
 * the browser rejects it outright with "a redirected response was used". The
 * static export serves directory URLs (`/album` -> `/album/`), so this is not
 * hypothetical. Copying the body strips the redirect flag.
 */
async function replayable(response) {
  const body = await response.blob();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Fetches every shell document, caches it, and caches the assets it names. */
async function precacheShell() {
  const cache = await caches.open(CACHE);
  const assets = new Set(SHELL_FILES.map(at));

  for (const route of SHELL_ROUTES) {
    const url = at(route);
    try {
      // `cache: 'reload'` so installing a new worker cannot precache the very
      // documents the HTTP cache is holding from the previous deploy.
      const response = await fetch(url, { cache: 'reload', credentials: 'same-origin' });
      if (!response.ok) continue;
      const html = await response.clone().text();
      const page = await replayable(response);
      await cache.put(url, page.clone());
      // The export redirects `/album` to `/album/`; store both keys so a
      // navigation to either one is served rather than half of them missing.
      if (response.url && response.url !== url) await cache.put(response.url, page);
      for (const asset of assetsIn(html)) assets.add(asset);
    } catch {
      // Installing while already offline is allowed to be incomplete. The
      // runtime handlers below fill the cache in as soon as there is a network.
    }
  }

  await Promise.all(
    [...assets].map((url) =>
      cache.add(new Request(url, { cache: 'reload', credentials: 'same-origin' })).catch(() => {}),
    ),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell());
  // Take over as soon as the shell is stored instead of waiting for every tab
  // to close. Documents are network-first and assets are content-hashed, so
  // there is no version to mix up - and a child does not know what "close all
  // tabs to update" means.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

const isApi = (url) => url.pathname === `${BASE}/api` || url.pathname.startsWith(`${BASE}/api/`);

const isBuildAsset = (url) => url.pathname.startsWith(`${BASE}/_next/static/`);

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirstDocument(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request.url, await replayable(response.clone())).catch(() => {});
    return response;
  } catch (error) {
    const url = new URL(request.url);
    // Try the exact URL, then the other spelling of it: the two deployments
    // disagree about trailing slashes (`trailingSlash: true` in the export),
    // and a cache miss here would show a child a browser error page.
    const alternative = url.pathname.endsWith('/')
      ? url.pathname.replace(/\/$/, '')
      : `${url.pathname}/`;
    const cached =
      (await cache.match(request.url, { ignoreSearch: true })) ??
      (await cache.match(new URL(alternative, url.origin).href, { ignoreSearch: true })) ??
      // Last resort: the dashboard. It is the wrong screen for the URL, but it
      // is the game, and the router will put him right on the next tap.
      (await cache.match(at('/')));
    if (cached) return cached;
    throw error;
  }
}

async function networkFirstFile(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Anything not ours is none of our business - handing it to the default
  // network path keeps the worker's surface as small as it is auditable.
  if (url.origin !== self.location.origin) return;

  // The whole point of the rule at the top of this file.
  if (isApi(url)) return;

  // React Server Component payloads. Offline these must fail: the App Router
  // catches the failure and falls back to a full page navigation, which this
  // worker then serves from the precached shell. Answering one from cache would
  // hand the router a payload from a different build instead.
  if (url.searchParams.has('_rsc')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstDocument(request));
    return;
  }

  if (isBuildAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(networkFirstFile(request));
});
