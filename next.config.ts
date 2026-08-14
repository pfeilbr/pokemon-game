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
        // Headers are served by the host, so they only exist for the real
        // deployment. On a static host these are set by the host, if at all.
        async headers() {
          return [
            {
              source: '/:path*',
              headers: [
                { key: 'X-Content-Type-Options', value: 'nosniff' },
                { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
                { key: 'X-Frame-Options', value: 'DENY' },
              ],
            },
          ];
        },
      }),
};

export default nextConfig;
