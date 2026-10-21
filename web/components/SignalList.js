import {
  directionTone, num, pct, signed, scoreTone, istStamp, publishModeTone, signalStateTone,
  riskConfigTone, tradeOutcomeTone, tradeStatusTone,
} from '@/lib/format';
import TradeEnteredButton from '@/components/TradeEnteredButton';

export default function SignalList({
  signals = [], horizonLabel = 'this horizon', tradesBySignal = {},
}) {
  if (!signals.length) {
    return (
      <div className="empty">
        <strong>No published signals for {horizonLabel}</strong>
        A candidate is only published once the risk gate approves it. In shadow mode the message
        is composed and recorded but deliberately not delivered, so an empty list is expected
        until the pipeline has judged a candidate.
      </div>
    );
  }

  return (
    <div className="stack">
      {signals.map((signal) => {
        const trade = tradesBySignal[signal.id];
        const state = String(signal.latest_state || '').toUpperCase();
        const configStatus = String(signal.risk_config_status || '').toLowerCase();
        const blocked = !trade && signal.actionable === false;
        const blockedReason = state === 'VOIDED'
          ? (signal.latest_reason || 'This signal was voided and is not actionable.')
          : configStatus === 'retired'
            ? `Risk config ${signal.risk_config_version || '(unknown)'} is retired; this signal is archival, not actionable.`
            : configStatus === 'candidate'
              ? 'The risk config that wrote this signal is not approved; it is not actionable.'
              : (state === 'EXITED' || state === 'EXPIRED')
                ? `This signal already ${state.toLowerCase()}; it is not actionable.`
                : '';
        return (
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
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <span className={`pill ${directionTone(signal.direction)}`}>{signal.direction}</span>
              <span className={`pill ${publishModeTone(signal.mode)}`}>
                {signal.mode === 'shadow' ? 'shadow - paper only' : 'delivered'}
              </span>
              {state && state !== 'PUBLISHED' && state !== 'SHADOWED' ? (
                <span className={`pill ${signalStateTone(state)}`}>{state}</span>
              ) : null}
              {configStatus === 'retired' || configStatus === 'candidate' ? (
                <span className={`pill ${riskConfigTone(configStatus)}`}>
                  {configStatus} config
                </span>
              ) : null}
            </div>
          </div>
          <div className="stat-row" style={{ marginTop: 12, gridTemplateColumns: 'repeat(6, 1fr)' }}>
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
              <div className="k" title="Bias score at publication: -1 bearish to +1 bullish">Bias score</div>
              <div className={`v mono ${scoreTone(signal.score)}`}>
                {signal.score == null ? '-' : signed(signal.score, 2)}
              </div>
            </div>
            <div className="stat">
              <div className="k" title="How complete and fresh the evidence was, not a win probability">
                Data conf.
              </div>
              <div className="v mono">{signal.confidence == null ? '-' : pct(signal.confidence * 100, 0)}</div>
            </div>
          </div>
          <div className="small muted" style={{ marginTop: 10 }}>
            {signal.strategy_version} - engine {signal.engine_version}
          </div>

          <div className="row-between" style={{ marginTop: 12 }}>
            <div className="small muted">
              {trade ? (
                <>
                  Entered {istStamp(trade.entered_at)} IST
                  {trade.outcome ? (
                    <>
                      {' '}
                      <span className={`pill ${tradeOutcomeTone(trade.outcome)}`}>
                        {trade.outcome}
                      </span>
                    </>
                  ) : (
                    <>
                      {' '}
                      <span className={`pill ${tradeStatusTone(trade.status)}`}>
                        {trade.status}
                      </span>
                    </>
                  )}
                </>
              ) : (
                blockedReason || 'Plan only. Execution is manual.'
              )}
            </div>
            <TradeEnteredButton
              signalId={signal.id}
              tradeId={trade ? trade.id : null}
              compact
              disabled={blocked}
              disabledReason={blockedReason}
            />
          </div>
        </div>
        );
      })}
    </div>
  );
}
