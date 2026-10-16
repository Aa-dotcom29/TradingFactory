import { compact, istStamp, num } from '@/lib/format';

// Slice 2 output: the per-symbol option-flow features the flow worker derives from the NSE
// OI-spurt snapshot. It reports what open interest did (CE and PE change, put-call ratio and
// the build-up quadrant mix) and deliberately stops short of a direction call.

export default function FlowFeatures({ data, limit = 10 }) {
  const rows = (data?.rows || []).slice(0, limit);

  if (!rows.length) {
    return (
      <div className="empty">
        <strong>No flow features yet</strong>
        The flow worker reduces the NSE OI-spurt snapshot into per-symbol features once it runs
        against the database.
      </div>
    );
  }

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 10 }}>
        <span className="small muted">Derived at {istStamp(data.asOf)} IST</span>
        <span className="small muted">CE / PE open-interest change</span>
      </div>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th className="num">CE OI chg</th>
              <th className="num">PE OI chg</th>
              <th className="num">PCR</th>
              <th>Build-up mix</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const v = row.values || {};
              return (
                <tr key={row.symbol}>
                  <td>
                    <strong>{row.symbol}</strong>
                    <div className="small muted">
                      {num(v.optionCount)} opt
                      {v.futureCount ? ` + ${num(v.futureCount)} fut` : ''}
                      {v.underlyingRead ? ` - ${v.underlyingRead}` : ''}
                    </div>
                  </td>
                  <td className="num mono">{compact(v.ceOiChange)}</td>
                  <td className="num mono">{compact(v.peOiChange)}</td>
                  <td className="num mono">{v.pcrOiChange == null ? '-' : num(v.pcrOiChange, 2)}</td>
                  <td>
                    <span className="pill up">LB {num(v.longBuildup)}</span>{' '}
                    <span className="pill down">SB {num(v.shortBuildup)}</span>{' '}
                    <span className="pill up">SC {num(v.shortCovering)}</span>{' '}
                    <span className="pill down">LU {num(v.longUnwinding)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
