import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { databaseConfigured } from '@/lib/db';
import { publishSummary } from '@/lib/publish';
import NavTabs from '@/components/NavTabs';
import LogoutButton from '@/components/LogoutButton';
import RailStatus from '@/components/RailStatus';

export const dynamic = 'force-dynamic';

// The rail is the one loud element in the interface: identity on the left,
// live state on the right. Everything else on the page stays quiet so this
// strip is where the eye lands first.
export default async function DashboardLayout({ children }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const mode = publishSummary();

  return (
    <>
      <header className="rail">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <span>Trading Factory</span>
          <span className="sub">market intelligence</span>
        </div>

        <div className="spacer" />

        <RailStatus mode={mode} />

        <div className="user-chip">
          <span>
            <strong>{user.email}</strong>
            {user.household_name} / {user.role}
          </span>
          <LogoutButton />
        </div>
      </header>

      <NavTabs />

      <main className="wrap">
        {!databaseConfigured && (
          <div className="banner error" style={{ marginBottom: 16 }}>
            DATABASE_URL is not configured on this server, so live data cannot be loaded.
          </div>
        )}
        {children}
      </main>
    </>
  );
}
