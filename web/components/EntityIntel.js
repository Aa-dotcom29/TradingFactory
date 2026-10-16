import { istStamp, num, signed, sentimentTone, severityTone } from '@/lib/format';

// Slice 2 output: cross-item news pressure by entity. The news worker rolls the last 48 hours
// of scored headlines into one row per entity, so a cluster of coverage shows up as a single
// number instead of dozens of separate headlines. Nothing is inferred here - it is read back
// from the stored news.entity.v1 feature rows.

function clip(text, max = 68) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function pressureTone(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'muted';
  if (n >= 0.2) return 'up';
  if (n <= -0.2) return 'down';
  return 'muted';
}

export default function EntityIntel({ data, limit = 8 }) {
  const entities = (data?.entities || []).slice(0, limit);

  if (!entities.length) {
    return (
      <div className="empty">
        <strong>No entity pressure yet</strong>
        The news worker rolls scored headlines into per-entity features once it runs against the
        database.
      </div>
    );
  }

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 10 }}>
        <span className="small muted">Rolled at {istStamp(data.asOf)} IST</span>
        <span className="small muted">48h window</span>
      </div>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Entity</th>
              <th className="num">News</th>
              <th className="num">Net</th>
              <th>Severity</th>
              <th className="num">Pressure</th>
            </tr>
          </thead>
          <tbody>
            {entities.map((row) => {
              const v = row.values || {};
              const lead = Array.isArray(v.topTitles) ? v.topTitles[0] : null;
              return (
                <tr key={row.symbol}>
                  <td>
                    <strong>{row.symbol}</strong>
                    {lead ? (
                      <div className="small muted" title={lead.title}>
                        {clip(lead.title)}
                      </div>
                    ) : null}
                  </td>
                  <td className="num mono">{num(v.itemCount)}</td>
                  <td className={`num mono tone-${sentimentTone(v.netSentiment)}`}>{signed(v.netSentiment, 2)}</td>
                  <td>
                    <span className={`pill ${severityTone(v.maxSeverity)}`}>{v.maxSeverity || '-'}</span>
                  </td>
                  <td className={`num mono tone-${pressureTone(v.pressure)}`}>{signed(v.pressure, 2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
