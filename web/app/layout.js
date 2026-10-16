import './globals.css';

export const metadata = {
  title: 'Trading Factory',
  description: 'Family market intelligence dashboard for Indian equity and F&O',
  applicationName: 'Trading Factory',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Trading Factory' },
};

export const viewport = {
  themeColor: '#0b1220',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
