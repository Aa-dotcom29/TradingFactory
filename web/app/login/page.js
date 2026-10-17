import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { databaseConfigured } from '@/lib/db';
import LoginForm from './LoginForm';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Sign in - Trading Factory' };

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect('/dashboard');

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <span>Trading Factory</span>
        </div>
        <h1>Sign in</h1>
        <p className="hint">Family accounts only. Contact the household owner for access.</p>
        {!databaseConfigured && (
          <div className="banner error" style={{ marginBottom: 16 }}>
            DATABASE_URL is not set. Configure it and apply the schema before signing in.
          </div>
        )}
        <LoginForm disabled={!databaseConfigured} />
      </div>
    </div>
  );
}
