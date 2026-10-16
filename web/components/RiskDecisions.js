import { decisionTone, directionTone, istStamp, num } from '@/lib/format';

// Slice 5 output: the risk gate's audit trail. Every row is one judgement of one candidate,
// with the full check list behind it, so a rejection can be read gate by gate instead of
// trusting a single sentence. DEFERRED is deliberately its own colour: nothing failed, the
// market was simply shut.

function checksOf(decision) {
  const checks = decision && decision.payload && decision.payload.checks;
  return Array.isArray(checks) ? checks : [];
}

function tally(checks) {
  const out = { PASS: 0, FAIL: 0, DEFER: 0, SKIPPED: 0 };
  for (const check of checks) {
    if (out[check.status] !== undefined) out[check.status] += 1;
  }
  return out;
}

function planLine(decision) {
  const kind = decision.kind || 'PLAN';
  const parts = [kind];
  if (decision.instrument) parts.push(decision.instrument);
  const line = parts.join(' ');
  if (decision.entry == null) return line;
  return `${line} at ${num(decision.entry, 2)}`;
}

export default function RiskDecisions({ decisions = [], showHorizon = false }) {
  if (!decisions.length) {
    return (
      <div className="empty">
        <strong>No risk decisions yet</strong>
        The gate writes a row the first time it judges a candidate - approved, rejected or
        deferred. Until the signal builder raises a candidate there is nothing to judge.
      </div>
    );
  }

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Candidate</th>
            {showHorizon ? <th>Horizon</th> : null}
            <th>Decision</th>
            <th>Gates</th>
            <th>Why</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {decisions.map((decision) => {
            const checks = checksOf(decision);
            const counts = tally(checks);
            const failed = checks.filter((check) => check.status === 'FAIL');
            return (
              <tr key={decision.id}>
                <td>
                  <strong>{decision.symbol || 'unknown'}</strong>{' '}
                  {decision.direction ? (
                    <span className={`pill ${directionTone(decision.direction)}`}>{decision.direction}</span>
                  ) : null}
                  <div className="small muted mono">{planLine(decision)}</div>
                </td>
                {showHorizon ? (
                  <td>
                    <span className="pill muted">{decision.horizon}</span>
                  </td>
                ) : null}
                <td>
                  <span className={`pill ${decisionTone(decision.decision)}`}>{decision.decision}</span>
                  <div className="small muted">{decision.config_version}</div>
                </td>
                <td className="small muted">
                  {checks.length ? (
                    <>
                      <span className="tone-up">{counts.PASS} pass</span>
                      {counts.DEFER ? <span className="tone-warn"> - {counts.DEFER} defer</span> : null}
                      {counts.FAIL ? <span className="tone-down"> - {counts.FAIL} fail</span> : null}
                      {counts.SKIPPED ? <span> - {counts.SKIPPED} skipped</span> : null}
                      {failed.length ? (
                        <div className="tone-down">{failed.map((check) => check.gate).join(', ')}</div>
                      ) : null}
                    </>
                  ) : (
                    <span>no check list stored</span>
                  )}
                </td>
                <td>
                  {Array.isArray(decision.reasons) && decision.reasons.length ? (
                    <ul className="small muted" style={{ margin: 0, paddingLeft: 16 }}>
                      {decision.reasons.slice(0, 4).map((reason, index) => (
                        <li key={index}>{reason}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="muted small">-</span>
                  )}
                </td>
                <td className="small muted">{istStamp(decision.evaluated_at)} IST</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
