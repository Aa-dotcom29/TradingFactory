import { directionTone, num, pct, istStamp } from '@/lib/format';

export default function SignalList({ signals = [], horizonLabel = 'this horizon' }) {
  if (!signals.length) {
    return (
      <div className="empty">
        <strong>No published signals for {horizonLabel}</strong>
        Signals are published by the risk-gated engine (Slices 4-5). Until then this stays
        intentionally empty rather than showing placeholder trades.
      </div>
    );
  }

  return (
    <div className="stack">
      {signals.map((signal) => (
        <div className="card" key={signal.id} style={{ boxShadow: 'none' }}>
          <div className="row-between">
            <div>
              <strong style={{ fontSize: 16 }}>{signal.symbol}</strong>{' '}
              {signal.instrument ? <span className="muted">{signal.instrument}</span> : null}
              {signal.strike ? (
                <span className="muted">
                  {' '}
                  {num(signal.strike)} {signal.option_type || ''}
                </span>
              ) : null}
              <div className="small muted">
                {signal.strategy} - {istStamp(signal.published_at)} IST
              </div>
            </div>
            <span className={`pill ${directionTone(signal.direction)}`}>{signal.direction}</span>
          </div>
          <div className="stat-row" style={{ marginTop: 12, gridTemplateColumns: 'repeat(5, 1fr)' }}>
            <div className="stat">
              <div className="k">Entry</div>
              <div className="v mono">{signal.entry == null ? '-' : num(signal.entry, 2)}</div>
            </div>
            <div className="stat">
              <div className="k">Target</div>
              <div className="v mono">{signal.target == null ? '-' : num(signal.target, 2)}</div>
            </div>
            <div className="stat">
              <div className="k">Stop</div>
              <div className="v mono">{signal.stop == null ? '-' : num(signal.stop, 2)}</div>
            </div>
            <div className="stat">
              <div className="k">R:R</div>
              <div className="v mono">{signal.rr == null ? '-' : num(signal.rr, 2)}</div>
            </div>
            <div className="stat">
              <div className="k">Confidence</div>
              <div className="v mono">{signal.confidence == null ? '-' : pct(signal.confidence * 100, 0)}</div>
            </div>
          </div>
          <div className="small muted" style={{ marginTop: 10 }}>
            {signal.strategy_version} - engine {signal.engine_version}
          </div>
        </div>
      ))}
    </div>
  );
}
