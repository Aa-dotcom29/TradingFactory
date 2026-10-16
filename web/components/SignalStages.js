import { istStamp, num, signed, directionTone, stageTone } from '@/lib/format';

// Slice 4 output: where each name sits in its trade lifecycle. The stage is a small state
// machine (IDLE -> WATCH -> BUILDING -> READY), so the panel shows "what is forming" all the
// time rather than only on the tick a signal fires. Every row carries the reasons behind its
// stage, read straight back from the stored transition.

function planCell(plan) {
  if (!plan || typeof plan !== 'object') {
    return <span className="muted small">no plan yet</span>;
  }
  const liquid = plan.liquidity && plan.liquidity.ok;
  const label = plan.kind === 'OPTION'
    ? `${plan.optionType || ''} ${num(plan.strike)}${plan.expiry ? ` ${plan.expiry}` : ''}`
    : `${num(plan.spot)} level`;

  return (
    <span>
      <span className={`pill ${liquid ? 'up' : 'muted'}`}>{plan.kind}</span>{' '}
      <span className="mono small">{label}</span>
      <div className="small muted">
        entry {num(plan.entry, 2)} / stop {num(plan.stop, 2)} / target {num(plan.target, 2)}
        {plan.rr == null ? '' : ` (R:R ${num(plan.rr, 2)})`}
      </div>
    </span>
  );
}

function reasonsCell(reasons) {
  if (!Array.isArray(reasons) || !reasons.length) return <span className="muted small">-</span>;
  return (
    <ul style={{ margin: 0, paddingLeft: 16 }} className="small muted">
      {reasons.map((reason, index) => <li key={index}>{reason}</li>)}
    </ul>
  );
}

export default function SignalStages({ rows = [], showHorizon = false }) {
  if (!rows.length) {
    return (
      <div className="empty">
        <strong>No signal lifecycle yet</strong>
        The signal builder moves each name from IDLE to WATCH to BUILDING to READY as bias and
        liquidity allow. It appears once the bias meter has produced a verdict to build from.
      </div>
    );
  }

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Symbol</th>
            {showHorizon ? <th>Horizon</th> : null}
            <th>Stage</th>
            <th>Bias</th>
            <th className="num">Score</th>
            <th className="num">Confidence</th>
            <th>Plan</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.horizon || 'INTRADAY'}-${row.symbol}`}>
              <td>
                <strong>{row.symbol}</strong>
                <div className="small muted">{istStamp(row.as_of)} IST</div>
              </td>
              {showHorizon ? (
                <td>
                  <span className="pill muted">{row.horizon}</span>
                </td>
              ) : null}
              <td>
                <span className={`pill ${stageTone(row.stage)}`}>{row.stage}</span>
                {row.previous_stage && row.previous_stage !== row.stage ? (
                  <div className="small muted">from {row.previous_stage}</div>
                ) : null}
              </td>
              <td>
                <span className={`pill ${directionTone(row.direction)}`}>{row.direction}</span>
              </td>
              <td className={`num mono tone-${directionTone(row.direction)}`}>{signed(row.score, 3)}</td>
              <td className="num mono">{num(Number(row.confidence) * 100, 0)}%</td>
              <td>{planCell(row.plan)}</td>
              <td>{reasonsCell(row.reasons)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
