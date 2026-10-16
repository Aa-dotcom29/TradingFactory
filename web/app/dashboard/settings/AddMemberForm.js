'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function AddMemberForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('member');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const res = await fetch('/api/members', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, role }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Could not add member.');
      } else {
        setMessage(`Added ${email}.`);
        setEmail('');
        setPassword('');
        setRole('member');
        router.refresh();
      }
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} style={{ maxWidth: 420 }}>
      {error && <p className="form-error">{error}</p>}
      {message && <p className="small tone-up">{message}</p>}
      <div className="field">
        <label htmlFor="member-email">Email</label>
        <input
          id="member-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="member-password">Temporary password</label>
        <input
          id="member-password"
          type="text"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={10}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="member-role">Role</label>
        <select id="member-role" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="member">Member</option>
          <option value="owner">Owner</option>
        </select>
      </div>
      <button className="btn" type="submit" disabled={busy}>
        {busy ? 'Adding...' : 'Add member'}
      </button>
    </form>
  );
}
