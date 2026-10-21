'use client';

import { useState } from 'react';

// Opens the focus workspace in a new tab. The tab is reserved synchronously on
// click, before the POST, so a pop-up blocker still sees a user gesture. If the
// request fails the blank tab is closed instead of being left orphaned.
export default function TradeEnteredButton({
  signalId, tradeId = null, compact = false, disabled = false, disabledReason = '',
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // An existing journal entry stays reachable even if the signal was later voided; the guard
  // only blocks creating a new entry from a non-actionable signal.
  const blocked = disabled && !tradeId;

  async function openWorkspace() {
    if (blocked) return;
    setError('');

    if (tradeId) {
      window.open(`/dashboard/trade/${tradeId}`, '_blank', 'noopener,noreferrer');
      return;
    }

    const tab = window.open('', '_blank');
    if (!tab) {
      setError('Allow pop-ups to open the trade workspace.');
      return;
    }
    tab.opener = null;

    setBusy(true);
    try {
      const res = await fetch('/api/trades', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signalId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.trade || !data.trade.id) {
        tab.close();
        setError(data.error || 'Could not record the trade entry.');
        return;
      }
      tab.location.href = `/dashboard/trade/${data.trade.id}`;
    } catch {
      tab.close();
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="trade-cta">
      <button
        type="button"
        className={`btn ${tradeId ? 'ghost' : ''} ${compact ? 'sm' : ''}`.trim()}
        onClick={openWorkspace}
        disabled={busy || blocked}
        title={blocked
          ? (disabledReason || 'This signal is not actionable.')
          : 'Opens the live trade workspace in a new tab'}
      >
        {blocked ? 'Not actionable' : busy ? 'Opening...' : tradeId ? 'Open trade' : 'Trade entered'}
      </button>
      {error ? <span className="form-error trade-cta-error">{error}</span> : null}
    </span>
  );
}
