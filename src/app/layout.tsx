import type { Metadata, Viewport } from 'next';
import { GameProvider } from '@/components/GameProvider';
import './globals.css';

export const metadata: Metadata = {
  title: 'Mathmon Battle League',
  description:
    'Catch monsters, win battles, and get faster at maths. A maths-powered creature battler for kids.',
  applicationName: 'Mathmon',
  appleWebApp: { capable: true, title: 'Mathmon', statusBarStyle: 'black-translucent' },
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
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
      </body>
    </html>
  );
}
