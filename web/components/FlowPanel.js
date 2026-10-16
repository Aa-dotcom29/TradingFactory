import { compact, num, pct, readTone, istStamp } from '@/lib/format';

// Renders the latest NSE OI-spurt snapshot: the build-up quadrant mix plus the
// biggest open-interest moves. Nothing here is inferred - it is the stored feed.
export default function FlowPanel({ flow }) {
  if (!flow || !flow.capturedAt) {
    return (
      <div className="empty">
        <strong>No flow snapshot yet</strong>
        The ingest worker will populate NSE OI spurts once it runs against the database.
      </div>
    );
  }

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 10 }}>
        <span className="small muted">Snapshot {istStamp(flow.capturedAt)} IST</span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(flow.quadrants || []).map((q) => (
            <span className={`pill ${readTone(q.label)}`} key={q.label}>
              {q.label} {q.n}
            </span>
          ))}
        </div>
      </div>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Contract</th>
              <th>Read</th>
              <th className="num">OI</th>
              <th className="num">Chg OI</th>
              <th className="num">Vol</th>
              <th className="num">LTP</th>
              <th className="num">Chg %</th>
            </tr>
          </thead>
          <tbody>
            {(flow.contracts || []).map((row, i) => (
              <tr key={`${row.contract || row.symbol}-${i}`}>
                <td>
                  <strong>{row.symbol}</strong>
                  {row.option_type ? (
                    <span className="muted">
                      {' '}
                      {num(row.strike)} {row.option_type}
                    </span>
                  ) : null}
                  {row.expiry ? <div className="small muted">exp {row.expiry}</div> : null}
                </td>
                <td>
                  <span className={`pill ${readTone(row.read)}`}>{row.read || '-'}</span>
                </td>
                <td className="num mono">{compact(row.oi)}</td>
                <td className={`num mono tone-${readTone(row.read)}`}>{compact(row.oi_change)}</td>
                <td className="num mono">{compact(row.volume)}</td>
                <td className="num mono">{row.price == null ? '-' : num(row.price, 2)}</td>
                <td className="num mono">{pct(row.price_change_pct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function FlowUnderlyings({ rows = [] }) {
  if (!rows.length) return null;
  return (
    <div className="table-scroll" style={{ marginTop: 12 }}>
      <table>
        <thead>
          <tr>
            <th>Underlying</th>
            <th>Read</th>
            <th className="num">OI</th>
            <th className="num">Chg OI</th>
            <th className="num">Volume</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.symbol}>
              <td>
                <strong>{row.symbol}</strong>
              </td>
              <td>
                <span className={`pill ${readTone(row.read)}`}>{row.read || '-'}</span>
              </td>
              <td className="num mono">{compact(row.oi)}</td>
              <td className={`num mono tone-${readTone(row.read)}`}>{compact(row.oi_change)}</td>
              <td className="num mono">{compact(row.volume)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
