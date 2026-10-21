import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { databaseConfigured } from '@/lib/db';
import { publishSummary } from '@/lib/publish';
import { getHealth, getNews } from '@/lib/queries';
import { arcadeTotals, buildArcadeWorkers } from '@/lib/arcade';
import NavTabs from '@/components/NavTabs';
import LogoutButton from '@/components/LogoutButton';
import RailStatus from '@/components/RailStatus';
import HeartbeatStrip from '@/components/HeartbeatStrip';
import CommandPalette from '@/components/CommandPalette';
import ThemeToggle from '@/components/ThemeToggle';
import NewsBulletin from '@/components/NewsBulletin';
import ScrollReveal from '@/components/ScrollReveal';

export const dynamic = 'force-dynamic';

// The rail is the one loud element in the interface: identity on the left,
// live state on the right. Everything else on the page stays quiet so this
// strip is where the eye lands first.
//
// The bulletin sits directly under it: a running line of what is happening
// right now, so the state of the world is visible without opening a page.
export default async function DashboardLayout({ children }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const mode = publishSummary();
  const [health, news] = await Promise.all([getHealth(), getNews(18)]);
  const workers = buildArcadeWorkers(health.sources || []);
  const heartbeat = {
    configured: health.configured,
    error: health.error,
    workers,
    totals: arcadeTotals(workers),
    at: new Date().toISOString(),
  };

  return (
    <>
      <header className="rail">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <span>Trading Factory</span>
          <span className="sub">market intelligence</span>
        </div>

        <div className="spacer" />

        <CommandPalette />

        <RailStatus mode={mode} />

        <HeartbeatStrip initial={heartbeat} />

        <ThemeToggle />

        <div className="user-chip">
          <span>
            <strong>{user.email}</strong>
            {user.household_name} / {user.role}
          </span>
          <LogoutButton />
        </div>
      </header>

      <NewsBulletin items={news} />

      <NavTabs />

      <main className="wrap">
        {!databaseConfigured && (
          <div className="banner error" style={{ marginBottom: 16 }}>
            DATABASE_URL is not configured on this server, so live data cannot be loaded.
          </div>
        )}
        {children}
      </main>

      <ScrollReveal />
    </>
  );
}
