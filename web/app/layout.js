import { Rajdhani, JetBrains_Mono } from 'next/font/google';
import './globals.css';

// Two families, two jobs. Rajdhani (a squared technical face) carries language:
// headings, labels, prose. JetBrains Mono carries every number, ticker and
// timestamp, so digits line up in a column and magnitudes compare by position.
const rajdhani = Rajdhani({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-rajdhani',
  display: 'swap',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-jetbrains',
  display: 'swap',
});

export const metadata = {
  title: 'Trading Factory',
  description: 'Family market intelligence dashboard for Indian equity and F&O',
  applicationName: 'Trading Factory',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Trading Factory' },
};

export const viewport = {
  themeColor: '#060a0e',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${rajdhani.variable} ${jetbrains.variable}`}>
      <body>{children}</body>
    </html>
  );
}
