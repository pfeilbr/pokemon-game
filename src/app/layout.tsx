import type { Metadata, Viewport } from 'next';
import { GameProvider } from '@/components/GameProvider';
import { ServiceWorkerRegistrar } from '@/components/ServiceWorkerRegistrar';
import './globals.css';

/**
 * Next prefixes `basePath` onto the assets it emits itself - scripts, CSS,
 * `next/image` - but NOT onto hrefs handed to it through `metadata`. On a
 * project Pages site served from /<repo>, a hardcoded `/manifest.webmanifest`
 * therefore resolves to the domain root and 404s, which silently costs the app
 * its icon and its installability - the one deployment shape where "add to home
 * screen" is the whole point. Read from the same env var `next.config.ts` uses,
 * so the two can never disagree; empty for the Vercel build, which is served
 * from the root.
 */
const basePath = process.env.PAGES_BASE_PATH ?? '';

export const metadata: Metadata = {
  title: 'Mathmon Battle League',
  description:
    'Catch monsters, win battles, and get faster at maths. A maths-powered creature battler for kids.',
  applicationName: 'Mathmon',
  appleWebApp: { capable: true, title: 'Mathmon', statusBarStyle: 'black-translucent' },
  manifest: `${basePath}/manifest.webmanifest`,
  icons: {
    icon: [{ url: `${basePath}/icon.svg`, type: 'image/svg+xml' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#0b1120',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-[100dvh] bg-slate-950 text-slate-100 antialiased">
        <GameProvider>{children}</GameProvider>
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
