'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    router.replace('/login');
    router.refresh();
  }

  return (
    <button className="btn ghost sm" type="button" onClick={onClick} disabled={busy}>
      {busy ? 'Signing out...' : 'Sign out'}
    </button>
  );
}
