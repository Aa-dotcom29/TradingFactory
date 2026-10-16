import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { databaseConfigured } from '@/lib/db';
import NavTabs from '@/components/NavTabs';
import LogoutButton from '@/components/LogoutButton';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          <span>
            Trading Factory <small>market intelligence</small>
          </span>
        </div>
        <div className="spacer" />
        <div className="user-chip">
          <span>
            <strong>{user.email}</strong>
            <br />
            {user.household_name} - {user.role}
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
