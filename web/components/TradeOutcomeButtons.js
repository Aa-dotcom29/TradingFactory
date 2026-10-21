'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const OPTIONS = [
  { value: 'SUCCESS', label: 'Success', tone: 'up' },
  { value: 'FAIL', label: 'Fail', tone: 'down' },
  { value: 'OUTPERFORM', label: 'Outperform', tone: 'up' },
  { value: 'NEUTRAL', label: 'Neutral', tone: 'muted' },
];

export default function TradeOutcomeButtons({ tradeId, currentOutcome = null, status = 'OPEN' }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const selected = String(currentOutcome || '').toUpperCase();

  async function mark(outcome) {
    setBusy(outcome);
    setError('');
    try {
      const res = await fetch(`/api/trades/${tradeId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outcome, note: note || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Could not save the outcome.');
        return;
      }
      router.refresh();
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="outcome-grid">
        {OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`btn sm ${selected === option.value ? '' : 'ghost'}`}
            onClick={() => mark(option.value)}
            disabled={Boolean(busy)}
            aria-pressed={selected === option.value}
            title={`Mark this trade as ${option.label.toLowerCase()}`}
          >
            {busy === option.value ? 'Saving...' : option.label}
          </button>
        ))}
      </div>

      <div className="field" style={{ margin: 0 }}>
        <label htmlFor={`trade-note-${tradeId}`}>Outcome note (optional)</label>
        <input
          id={`trade-note-${tradeId}`}
          type="text"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={500}
          placeholder="What decided the exit?"
        />
      </div>

      <div className="row-between">
        <span className="small muted">
          {status === 'CLOSED'
            ? 'This is your mark, separate from the evaluator.'
            : 'Marking an outcome closes the trade in your journal.'}
        </span>
        {status === 'CLOSED' ? (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => mark('OPEN')}
            disabled={Boolean(busy)}
          >
            {busy === 'OPEN' ? 'Reopening...' : 'Reopen'}
          </button>
        ) : null}
      </div>

      {error ? <p className="form-error" style={{ margin: 0 }}>{error}</p> : null}
    </div>
  );
}
