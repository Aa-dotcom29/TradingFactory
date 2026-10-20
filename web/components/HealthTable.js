import { timeAgo } from '@/lib/format';

const TONE = {
  OK: 'up',
  HEALTHY: 'up',
  LIVE: 'up',
  CLOSED: 'muted',
  IDLE: 'muted',
  DEGRADED: 'warn',
  WARNING: 'warn',
  STALE: 'warn',
  ERROR: 'down',
  DOWN: 'down',
  FAILED: 'down',
  DISABLED: 'muted',
};

export default function HealthTable({ sources = [] }) {
  if (!sources.length) {
    return (
      <div className="empty">
        <strong>No source health yet</strong>
        The supervisor worker records per-source status on each cycle.
      </div>
    );
  }

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Source</th>
            <th>Status</th>
            <th>Detail</th>
            <th>Checked</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((row) => (
            <tr key={row.source}>
              <td>
                <strong>{row.source}</strong>
              </td>
              <td>
                <span className={`pill ${TONE[String(row.status).toUpperCase()] || 'muted'}`}>{row.status}</span>
              </td>
              <td className="small muted">{row.detail || '-'}</td>
              <td className="small muted">{timeAgo(row.checked_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
