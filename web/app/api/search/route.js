import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { HORIZONS } from '@/lib/horizons';
import { WORKER_DOCS, WORKER_ORDER } from '@/lib/workerDocs';

export const dynamic = 'force-dynamic';

// The command palette's backing index. Pages and worker dossiers are static, so
// they always resolve even with no database. Signals and tracked names come
// from the database and simply contribute nothing when it is unavailable -
// search degrades to navigation rather than erroring.

const PAGES = [
  { title: 'Overview', sub: 'all horizons', href: '/dashboard' },
  ...HORIZONS.map((h) => ({ title: h.label, sub: h.blurb, href: `/dashboard/${h.key.toLowerCase()}` })),
  { title: 'Trades', sub: 'my journal', href: '/dashboard/trades' },
  { title: 'Workspace', sub: 'agents', href: '/dashboard/arcade' },
  { title: 'Settings', sub: 'household', href: '/dashboard/settings' },
];

function dirTone(direction) {
  const v = String(direction || '').toUpperCase();
  if (v === 'BULLISH') return 'up';
  if (v === 'BEARISH') return 'down';
  return 'muted';
}

export async function GET(request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });

  const q = String(new URL(request.url).searchParams.get('q') || '').trim().slice(0, 48);
  if (!q) return NextResponse.json({ groups: [] });
  const needle = q.toLowerCase();

  const pages = PAGES
    .filter((page) => `${page.title} ${page.sub}`.toLowerCase().includes(needle))
    .slice(0, 4)
    .map((page) => ({ title: page.title, sub: page.sub, href: page.href }));

  const workers = WORKER_ORDER
    .map((id) => WORKER_DOCS[id])
    .filter(Boolean)
    .filter((doc) => `${doc.id} ${doc.name} ${doc.blurb}`.toLowerCase().includes(needle))
    .slice(0, 5)
    .map((doc) => ({
      title: `${doc.id} ${doc.name}`,
      sub: doc.blurb,
      meta: doc.lane,
      href: `/dashboard/arcade/${doc.slug}`,
    }));

  let signals = [];
  let symbols = [];
  const sql = db();
  if (sql) {
    const like = `%${q}%`;
    try {
      const rows = await sql`
        select id, symbol, horizon, direction, strategy, published_at
        from signals
        where symbol ilike ${like} or strategy ilike ${like}
        order by published_at desc
        limit 8
      `;
      signals = rows.map((row) => ({
        title: `${row.symbol} ${row.direction}`,
        sub: `${row.horizon} - ${row.strategy}`,
        at: row.published_at,
        tone: dirTone(row.direction),
        href: `/dashboard/${String(row.horizon).toLowerCase()}#signal-${row.id}`,
      }));
    } catch {
      signals = [];
    }
    try {
      const rows = await sql`
        select symbol, horizon, direction, as_of
        from bias_verdicts
        where symbol ilike ${like}
        order by as_of desc
        limit 12
      `;
      const seen = new Set();
      for (const row of rows) {
        const key = `${row.symbol}|${row.horizon}`;
        if (seen.has(key)) continue;
        seen.add(key);
        symbols.push({
          title: row.symbol,
          sub: `${row.horizon} - last verdict ${row.direction}`,
          at: row.as_of,
          tone: dirTone(row.direction),
          href: `/dashboard/${String(row.horizon).toLowerCase()}`,
        });
        if (symbols.length >= 6) break;
      }
    } catch {
      symbols = [];
    }
  }

  const groups = [];
  if (pages.length) groups.push({ label: 'Pages', items: pages });
  if (workers.length) groups.push({ label: 'Workers', items: workers });
  if (symbols.length) groups.push({ label: 'Tracked names', items: symbols });
  if (signals.length) groups.push({ label: 'Signals', items: signals });

  return NextResponse.json({ groups });
}
