'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { num, signed, pct, istStamp, directionTone, scoreTone, timeAgo } from '@/lib/format';
import TimeframeAlignment, { TimeframeBadge } from '@/components/TimeframeAlignment';

// The full analysis behind a published signal.
//
// A trader deciding whether to act on a plan needs more than the plan: which
// evidence produced the call, what the risk gate checked, what the structure
// looked like at the time, and what has happened since. That is all in here,
// read from the rows that existed at publication and the rows that exist now.
//
// Nothing in this panel decides anything. It shows what the machine saw and
// what it did, so the judgement stays with the person.

function Section({ title, note, children }) {
  return (
    <section className="drawer-section">
      <h3>{title}</h3>
      {note ? <p className="drawer-note">{note}</p> : null}
      {children}
    </section>
  );
}

function Kv({ rows }) {
  const list = (rows || []).filter(Boolean);
  if (!list.length) return <p className="small muted">Not recorded.</p>;
  return (
    <dl className="evidence-kv">
      {list.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd className="mono">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Reasons({ items, empty = 'No reasons recorded.' }) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return <p className="small muted">{empty}</p>;
  return (
    <ul className="evidence-list">
      {list.map((item, index) => (
        <li key={index}>
          {typeof item === 'string'
            ? item
            : (item.detail || item.reason || item.check || item.label || JSON.stringify(item))}
        </li>
      ))}
    </ul>
  );
}

function ComponentBreakdown({ components }) {
  const entries = Object.entries(components || {});
  if (!entries.length) return <p className="small muted">No component breakdown recorded.</p>;
  return (
    <div className="drawer-components">
      {entries.map(([key, component]) => {
        const available = component && component.available !== false;
        const tone = !available ? 'muted' : scoreTone(component && component.score);
        return (
          <div className={`drawer-component ${tone}`} key={key}>
            <div className="k">{key}</div>
            <div className="v mono">
              {available && component && component.score != null ? signed(Number(component.score), 3) : 'n/a'}
            </div>
            {component && component.confidence != null ? (
              <div className="tick">conf {pct(Number(component.confidence) * 100, 0)}</div>
            ) : null}
            {component && component.detail ? (
              <div className="small muted detail">{String(component.detail)}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export default function SignalDrawer({ signalId, open, onClose, onTradeEntered }) {
  const [state, setState] = useState({ status: 'idle', dossier: null, timeframes: null, riskContext: null });

  useEffect(() => {
    if (!open || !signalId) return undefined;
    let cancelled = false;
    setState({ status: 'loading', dossier: null, timeframes: null });

    fetch(`/api/signal/${signalId}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`dossier ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setState({
          status: 'ready',
          dossier: data.dossier,
          timeframes: data.timeframes || null,
          riskContext: data.riskContext || null,
        });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error', dossier: null, timeframes: null, riskContext: null });
      });

    return () => { cancelled = true; };
  }, [open, signalId]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  const { status, dossier, timeframes, riskContext } = state;
  const signal = dossier && dossier.signal;
  const quote = dossier && dossier.quote;
  const entry = signal && signal.entry != null ? Number(signal.entry) : null;
  const last = quote && quote.ltp != null ? Number(quote.ltp) : null;
  const livePnlPct = entry != null && last != null && entry !== 0
    ? ((last - entry) / entry) * 100
    : null;

  return (
    <div className="drawer-backdrop" onMouseDown={onClose} role="presentation">
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={signal ? `Full analysis for ${signal.symbol}` : 'Signal analysis'}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="drawer-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            {status === 'loading' ? (
              <>
                <h2 className="drawer-title">Loading analysis</h2>
                <p className="muted small">Reading the rows that existed at publication.</p>
              </>
            ) : signal ? (
              <>
                <h2 className="drawer-title">
                  {signal.symbol}
                  {signal.instrument ? <span className="muted"> {signal.instrument}</span> : null}
                  {signal.strike != null ? (
                    <span className="muted"> {num(signal.strike)} {signal.option_type || ''}</span>
                  ) : null}
                </h2>
                <p className="muted small">
                  {signal.horizon} - {signal.strategy} - published {istStamp(signal.published_at)} IST
                  {signal.published_at ? ` (${timeAgo(signal.published_at)})` : ''}
                </p>
              </>
            ) : (
              <>
                <h2 className="drawer-title">Analysis unavailable</h2>
                <p className="muted small">
                  {status === 'error'
                    ? 'The dossier could not be read. The panel below says which rows are missing.'
                    : 'No dossier was returned for this signal.'}
                </p>
              </>
            )}
          </div>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close analysis">x</button>
        </div>

        <div className="drawer-body">
          {status === 'loading' ? (
            <div className="stack">
              <div className="sk sk-line" style={{ width: '60%' }} />
              <div className="sk sk-line" style={{ width: '90%' }} />
              <div className="sk sk-line" style={{ width: '75%' }} />
            </div>
          ) : null}

          {signal ? (
            <>
              <div className="drawer-facts">
                <span className={`pill ${directionTone(signal.direction)}`}>{signal.direction}</span>
                {dossier.trade ? (
                  <span className={`pill ${dossier.trade.outcome ? 'up' : 'accent'}`}>
                    {dossier.trade.outcome || dossier.trade.status}
                  </span>
                ) : null}
                {timeframes ? <TimeframeBadge read={timeframes} /> : null}
              </div>

              <Section title="The plan" note="The levels this signal was published with. Execution is manual.">
                <div className="drawer-levels">
                  <div className="stat"><div className="k">Entry</div><div className="v mono">{signal.entry == null ? '-' : num(signal.entry, 2)}</div></div>
                  <div className="stat"><div className="k">Target</div><div className="v mono">{signal.target == null ? '-' : num(signal.target, 2)}</div></div>
                  <div className="stat"><div className="k">Stop</div><div className="v mono">{signal.stop == null ? '-' : num(signal.stop, 2)}</div></div>
                  <div className="stat"><div className="k">R:R</div><div className="v mono">{signal.rr == null ? '-' : num(signal.rr, 2)}</div></div>
                  <div className="stat"><div className="k">Bias score</div><div className={`v mono ${scoreTone(signal.score ?? (dossier.verdict && dossier.verdict.score))}`}>{dossier.verdict && dossier.verdict.score != null ? signed(Number(dossier.verdict.score), 3) : '-'}</div></div>
                  <div className="stat"><div className="k">Data conf.</div><div className="v mono">{signal.confidence == null ? '-' : pct(Number(signal.confidence) * 100, 0)}</div></div>
                </div>
                <Kv rows={[
                  ['strategy version', signal.strategy_version],
                  ['engine version', signal.engine_version],
                  ['model version', signal.model_version],
                  ['config version', signal.config_version],
                  ['setup key', signal.setup_key],
                ]} />
              </Section>

              <Section
                title="Why this signal was published"
                note="The bias verdict the builder consumed, read at publication time. A later verdict is never substituted for it."
              >
                {dossier.verdict ? (
                  <>
                    <div className="drawer-facts">
                      <span className={`pill ${directionTone(dossier.verdict.direction)}`}>{dossier.verdict.direction}</span>
                      <span className="small muted">
                        score <strong className={`mono ${scoreTone(dossier.verdict.score)}`}>{signed(Number(dossier.verdict.score), 3)}</strong>
                      </span>
                      <span className="small muted">
                        confidence <strong className="mono">{pct(Number(dossier.verdict.confidence) * 100, 0)}</strong>
                      </span>
                      {dossier.verdict.coverage != null ? (
                        <span className="small muted">
                          coverage <strong className="mono">{pct(Number(dossier.verdict.coverage) * 100, 0)}</strong>
                        </span>
                      ) : null}
                      <span className="small muted">as of {istStamp(dossier.verdict.as_of)} IST</span>
                    </div>
                    <ComponentBreakdown components={dossier.verdict.components} />
                    <h4 className="drawer-sub">Evidence items</h4>
                    <Reasons items={dossier.verdict.evidence} empty="The verdict carried no evidence items." />
                  </>
                ) : (
                  <p className="small muted">
                    No bias verdict exists at or before this signal&apos;s publication time. The
                    verdict that fed the builder cannot be shown, and no later one is used in its place.
                  </p>
                )}
              </Section>

              <Section
                title="Where price is now"
                note="The last stored quote for the underlying, against the plan that was published."
              >
                {quote && quote.ltp != null ? (
                  <>
                    <div className="drawer-levels">
                      <div className="stat">
                        <div className="k">Last price</div>
                        <div className="v mono">{num(Number(quote.ltp), 2)}</div>
                      </div>
                      <div className="stat">
                        <div className="k">Entry</div>
                        <div className="v mono">{entry == null ? '-' : num(entry, 2)}</div>
                      </div>
                      <div className="stat">
                        <div className="k">Against entry</div>
                        <div className={`v mono ${livePnlPct == null ? '' : livePnlPct >= 0 ? ' tone-up' : ' tone-down'}`}>
                          {livePnlPct == null ? '-' : `${livePnlPct >= 0 ? '+' : ''}${num(livePnlPct, 2)}%`}
                        </div>
                      </div>
                      <div className="stat">
                        <div className="k">Target</div>
                        <div className="v mono">{signal.target == null ? '-' : num(Number(signal.target), 2)}</div>
                      </div>
                      <div className="stat">
                        <div className="k">Stop</div>
                        <div className="v mono">{signal.stop == null ? '-' : num(Number(signal.stop), 2)}</div>
                      </div>
                    </div>
                    <p className="small muted" style={{ margin: '6px 0 0' }}>
                      {quote.provider ? `Source: ${quote.provider}. ` : ''}
                      {quote.captured_at ? `Captured ${istStamp(quote.captured_at)} IST.` : ''}
                      {livePnlPct == null ? ' No price yet, so the plan cannot be marked.' : ''}
                    </p>
                  </>
                ) : (
                  <p className="small muted">
                    No stored quote for {signal ? signal.symbol : 'this symbol'} yet, so the plan
                    cannot be marked against a price.
                  </p>
                )}
              </Section>

              <Section
                title="Household risk context"
                note="The state the gate read when it approved this. It is why the approval was safe."
              >
                {riskContext ? (
                  <div className="drawer-levels">
                    <div className="stat">
                      <div className="k">Open now</div>
                      <div className="v mono">{riskContext.openPositions}</div>
                    </div>
                    <div className="stat">
                      <div className="k">Closed 24h</div>
                      <div className="v mono">{riskContext.closed24h}</div>
                    </div>
                    <div className="stat">
                      <div className="k">P&amp;L 24h</div>
                      <div className={`v mono ${riskContext.pnl24h > 0 ? ' tone-up' : riskContext.pnl24h < 0 ? ' tone-down' : ''}`}>
                        {riskContext.pnl24h > 0 ? '+' : ''}{num(riskContext.pnl24h, 2)}%
                      </div>
                    </div>
                    <div className="stat">
                      <div className="k">Loss streak</div>
                      <div className={`v mono ${riskContext.lossStreak > 0 ? ' tone-warn' : ''}`}>
                        {riskContext.lossStreak}
                      </div>
                    </div>
                    <div className="stat">
                      <div className="k">Win rate</div>
                      <div className="v mono">
                        {riskContext.winRatePct == null ? '-' : `${riskContext.winRatePct}%`}
                      </div>
                    </div>
                    <div className="stat">
                      <div className="k">Settled total</div>
                      <div className="v mono">{riskContext.totalClosed}</div>
                    </div>
                  </div>
                ) : (
                  <p className="small muted">The risk context could not be read.</p>
                )}
              </Section>

              <Section
                title="The risk gate"
                note="Every check the gate ran before this signal could be published."
              >
                {dossier.risk ? (
                  <>
                    <div className="drawer-facts">
                      <span className={`pill ${dossier.risk.passed ? 'up' : 'down'}`}>
                        {dossier.risk.decision || (dossier.risk.passed ? 'APPROVED' : 'BLOCKED')}
                      </span>
                      <span className="small muted">evaluated {istStamp(dossier.risk.evaluated_at)} IST</span>
                      {dossier.risk.config_version ? (
                        <span className="small muted">config {dossier.risk.config_version}</span>
                      ) : null}
                    </div>
                    <Reasons items={dossier.risk.reasons} empty="The gate recorded no reason list." />
                  </>
                ) : (
                  <p className="small muted">
                    No risk decision row is linked to this signal. That is unusual for a published
                    signal and is reported as missing rather than inferred.
                  </p>
                )}
              </Section>

              <Section title="Lifecycle stage" note="Where the candidate sat in the pipeline when it was raised.">
                {dossier.stage ? (
                  <>
                    <div className="drawer-facts">
                      <span className="pill">{dossier.stage.stage}</span>
                      {dossier.stage.direction ? (
                        <span className={`pill ${directionTone(dossier.stage.direction)}`}>{dossier.stage.direction}</span>
                      ) : null}
                      <span className="small muted">as of {istStamp(dossier.stage.as_of)} IST</span>
                    </div>
                    <Reasons items={dossier.stage.reasons} empty="The stage recorded no reasons." />
                  </>
                ) : (
                  <p className="small muted">No lifecycle stage was recorded at or before publication.</p>
                )}
              </Section>

              <Section
                title="Timeframe alignment"
                note="5-minute and 15-minute structure, from stored quotes. Index names only."
              >
                <TimeframeAlignment read={timeframes} symbol={signal.symbol} />
              </Section>

              <Section
                title="Inputs at publication"
                note="The feature rows the pipeline was working from. These are the raw readings behind the verdict."
              >
                {Object.keys(dossier.features || {}).length ? (
                  <div className="drawer-features">
                    {Object.entries(dossier.features).map(([set, row]) => (
                      <details className="drawer-feature" key={set}>
                        <summary>
                          <span className="mono">{set}</span>
                          <span className="tick">{istStamp(row.as_of)} IST</span>
                        </summary>
                        <pre className="drawer-json mono">{JSON.stringify(row.values, null, 2)}</pre>
                      </details>
                    ))}
                  </div>
                ) : (
                  <p className="small muted">No feature rows were stored at or before publication.</p>
                )}
              </Section>

              {dossier.outcomes && dossier.outcomes.length ? (
                <Section title="Outcome" note="How the plan was settled, if it has been.">
                  <Kv rows={dossier.outcomes.map((o) => [
                    o.result,
                    `${o.pnl_pct == null ? 'no pnl' : `${num(Number(o.pnl_pct), 2)}%`} | exit ${o.exit == null ? '-' : num(Number(o.exit), 2)} | MFE ${o.mfe == null ? '-' : num(Number(o.mfe), 2)} | MAE ${o.mae == null ? '-' : num(Number(o.mae), 2)}`,
                  ])} />
                </Section>
              ) : null}

              {dossier.events && dossier.events.length ? (
                <Section title="Lifecycle events" note="Every state change recorded against this signal.">
                  <ul className="evidence-list">
                    {dossier.events.map((event, index) => (
                      <li key={`${event.at}-${index}`}>
                        <span className="mono">{istStamp(event.at)}</span>{' '}
                        {event.previous_state ? `${event.previous_state} -> ` : ''}
                        <strong>{event.new_state}</strong>
                        {event.reason ? <span className="muted"> - {event.reason}</span> : null}
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}

              {dossier.trade ? (
                <Section title="Your trade" note="The position you recorded for this signal.">
                  <Kv rows={[
                    ['entered', istStamp(dossier.trade.entered_at)],
                    ['entry price', dossier.trade.entry_price == null ? '-' : num(Number(dossier.trade.entry_price), 2)],
                    ['quantity', dossier.trade.quantity == null ? '-' : String(dossier.trade.quantity)],
                    ['status', dossier.trade.status],
                    ['outcome', dossier.trade.outcome || 'not settled'],
                  ]} />
                </Section>
              ) : null}

              <div className="drawer-links">
                <Link href={`/dashboard/bias/${String(signal.horizon).toLowerCase()}/${signal.symbol}`}>
                  Bias detail
                </Link>
                <Link href="/dashboard/arcade/w3">W3 Bias worker</Link>
                <Link href="/dashboard/arcade/w4">W4 Signal builder</Link>
                <Link href="/dashboard/arcade/w5">W5 Risk gate</Link>
                <Link href="/dashboard/arcade/w6">W6 Publisher</Link>
                {dossier.trade ? (
                  <Link href={`/dashboard/trade/${dossier.trade.id}`}>Open trade workspace</Link>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
