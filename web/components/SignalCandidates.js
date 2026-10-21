import {
  directionTone, stageTone, candidateStatusTone, istStamp, num, pct,
} from '@/lib/format';
import Provenance from '@/components/Provenance';

// Slice 4 output: concrete tradeable proposals that are still waiting for the
// non-bypassable risk gate. Approved, rejected and superseded attempts are not
// shown here; they live in the risk-gate audit trail below. Keeping only the
// queued row is what stops one setup from appearing twice.

function contractLine(candidate) {
  if (candidate.kind === 'OPTION') {
    return `${candidate.option_type || ''} ${num(candidate.strike)}${candidate.expiry ? ` ${candidate.expiry}` : ''}`;
  }
  return candidate.instrument || 'spot / futures level';
}

export default function SignalCandidates({ candidates = [], showHorizon = false }) {
  if (!candidates.length) {
    return (
      <div className="empty">
        <strong>No trade candidates waiting for the gate</strong>
        A candidate appears here only between READY and the risk decision. Approved signals move
        to the published list, and rejected or superseded attempts stay in the risk-gate history.
      </div>
    );
  }

  return (
    <div className="stack">
      {candidates.map((candidate) => (
        <div className="card" key={candidate.id} style={{ boxShadow: 'none' }}>
          <div className="row-between">
            <div>
              <strong style={{ fontSize: 16 }}>{candidate.symbol}</strong>{' '}
              <span className="muted mono">{contractLine(candidate)}</span>
              <div className="small muted">
                {showHorizon ? `${candidate.horizon} - ` : ''}
                {istStamp(candidate.as_of)} IST
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <span className={`pill ${directionTone(candidate.direction)}`}>{candidate.direction}</span>
              <span className={`pill ${candidateStatusTone(candidate.status)}`}>
                {String(candidate.status || '').replace(/_/g, ' ')}
              </span>
              <Provenance value={candidate.provenance} />
            </div>
          </div>

          <div className="stat-row" style={{ marginTop: 12, gridTemplateColumns: 'repeat(5, 1fr)' }}>
            <div className="stat">
              <div className="k">Entry</div>
              <div className="v mono">{candidate.entry == null ? '-' : num(candidate.entry, 2)}</div>
            </div>
            <div className="stat">
              <div className="k">Target</div>
              <div className="v mono">{candidate.target == null ? '-' : num(candidate.target, 2)}</div>
            </div>
            <div className="stat">
              <div className="k">Stop</div>
              <div className="v mono">{candidate.stop == null ? '-' : num(candidate.stop, 2)}</div>
            </div>
            <div className="stat">
              <div className="k">R:R</div>
              <div className="v mono">{candidate.rr == null ? '-' : num(candidate.rr, 2)}</div>
            </div>
            <div className="stat">
              <div className="k">Confidence</div>
              <div className="v mono">{candidate.confidence == null ? '-' : pct(candidate.confidence * 100, 0)}</div>
            </div>
          </div>

          <div className="row-between" style={{ marginTop: 10 }}>
            <span className={`pill ${candidate.liquidity_ok ? 'up' : 'muted'}`}>
              {candidate.liquidity_ok ? 'liquidity ok' : 'liquidity unverified'}
            </span>
            <span className={`pill ${stageTone('READY')}`}>{candidate.kind}</span>
          </div>

          {Array.isArray(candidate.reasons) && candidate.reasons.length ? (
            <ul className="small muted" style={{ margin: '10px 0 0', paddingLeft: 16 }}>
              {candidate.reasons.map((reason, index) => <li key={index}>{reason}</li>)}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}
