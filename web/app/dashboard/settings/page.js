import { redirect } from 'next/navigation';
import { getCurrentUser, authDisabled } from '@/lib/auth';
import { listMembers } from '@/lib/queries';
import { istDate } from '@/lib/format';
import StatusBanner from '@/components/StatusBanner';
import AddMemberForm from './AddMemberForm';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Settings - Trading Factory' };

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const members = await listMembers(user.household_id);
  const isOwner = user.role === 'owner';

  return (
    <div className="stack">
      <div className="page-head">
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1>Household settings</h1>
          <p className="muted small" style={{ margin: '5px 0 0' }}>
            {user.household_name} - you are signed in as {user.email} ({user.role}).
          </p>
        </div>
      </div>

      {authDisabled() ? (
        <StatusBanner
          tone="down"
          headline="Authentication disabled"
          facts={[
            { k: 'node env', v: process.env.NODE_ENV || 'development' },
            { k: 'members', v: members.length },
          ]}
          note="This instance signs every visitor in without a password. The bypass is hard-gated on NODE_ENV !== 'production', so a deployed build cannot have it enabled - but do not expose this instance to a network while it is running."
        />
      ) : (
        <StatusBanner
          tone="up"
          headline="Authentication enabled"
          facts={[
            { k: 'members', v: members.length },
            { k: 'your role', v: user.role },
          ]}
          note="Every page requires a session cookie. Sessions are stored server-side and the database only ever holds a hash of the cookie token."
        />
      )}

      <section className="card">
        <h2>Members</h2>
        <p className="hint">Everyone here shares this household&apos;s dashboard.</p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Added</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td>{m.email}</td>
                  <td>
                    <span className={`pill ${m.role === 'owner' ? 'accent' : 'muted'}`}>{m.role}</span>
                  </td>
                  <td className="small muted">{istDate(m.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {isOwner ? (
        <section className="card">
          <h2>Add a member</h2>
          <p className="hint">Creates a login in this household. Use a password of at least 10 characters.</p>
          <AddMemberForm />
        </section>
      ) : (
        <div className="banner">Only the household owner can add members.</div>
      )}
    </div>
  );
}
