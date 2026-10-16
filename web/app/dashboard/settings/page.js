import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { listMembers } from '@/lib/queries';
import { istDate } from '@/lib/format';
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
      <div>
        <h1 style={{ margin: '6px 0 2px', fontSize: 22 }}>Household settings</h1>
        <p className="muted small" style={{ margin: 0 }}>
          {user.household_name} - you are signed in as {user.email} ({user.role}).
        </p>
      </div>

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
