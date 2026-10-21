'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { HORIZONS } from '@/lib/horizons';

export default function NavTabs() {
  const pathname = usePathname();
  const items = [{ key: 'OVERVIEW', label: 'Overview', sub: 'all horizons', href: '/dashboard' }].concat(
    HORIZONS.map((h) => ({ key: h.key, label: h.label, sub: h.blurb, href: `/dashboard/${h.key.toLowerCase()}` })),
  );
  items.push({ key: 'TRADES', label: 'Trades', sub: 'my journal', href: '/dashboard/trades' });
  items.push({ key: 'ARCADE', label: 'Workspace', sub: 'agents', href: '/dashboard/arcade' });
  items.push({ key: 'SETTINGS', label: 'Settings', sub: 'household', href: '/dashboard/settings' });

  return (
    <nav className="tabs" aria-label="Sections">
      {items.map((item) => {
        const active = pathname === item.href
          || (item.key === 'TRADES' && pathname.startsWith('/dashboard/trade/'));
        return (
          <Link key={item.key} href={item.href} className={`tab${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined}>
            {item.label}
            <span className="sub">{item.sub}</span>
          </Link>
        );
      })}
    </nav>
  );
}
