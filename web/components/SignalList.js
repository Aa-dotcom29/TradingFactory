'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  directionTone, num, pct, signed, scoreTone, istStamp, publishModeTone, signalStateTone,
  riskConfigTone, tradeOutcomeTone, tradeStatusTone,
} from '@/lib/format';
import TradeEnteredButton from '@/components/TradeEnteredButton';
import SignalEvidence from '@/components/SignalEvidence';
import SignalDrawer from '@/components/SignalDrawer';
import { TimeframeBadge } from '@/components/TimeframeAlignment';
import { isIndexSignal } from '@/lib/book';

// The published-signal feed is a client component so the household can narrow a
// long ledger without a server round trip: text, direction, lifecycle state and
// a few one-click views. The last filter is kept in localStorage and restored
// on the next visit, so "my view" survives a reload without any server state.
//
// Nothing here decides anything. The actionable flag, the risk-config status
// and the trade lookup all still come from the server rows passed in as props.
//
// A card is the summary a trader reads before acting: how big the move is
// expected to be, how much evidence backed it, what the gate checked, and
// whether the short and long timeframes agree. The full breakdown lives in
// the drawer, which opens on click.

const FILTER_KEY = 'tf-signal-filter';
const EMPTY_FILTER = { q: '', direction: 'ALL', state: 'ALL' };

const PRESETS = [
  { id: 'all', label: 'All', filter: EMPTY_FILTER },
  { id: 'actionable', label: 'Actionable', filter: { q: '', direction: 'ALL', state: 'ACTIONABLE' } },
  { id: 'bullish', label: 'Bullish', filter: { q: '', direction: 'BULLISH', state: 'ALL' } },
  { id: 'shadow', label: 'Shadow', filter: { q: '', direction: 'ALL', state: 'SHADOW' } },
  { id: 'closed', label: 'Closed', filter: { q: '', direction: 'ALL', state: 'CLOSED' } },
];

function lifecycleState(signal) {
  const state = String(signal.latest_state || '').toUpperCase();
  if (state === 'EXITED' || state === 'EXPIRED' || state === 'VOIDED') return 'CLOSED';
  if (String(signal.mode || '').toLowerCase() === 'shadow') return 'SHADOW';
  return 'OTHER';
}

function matchesFilter(signal, filter, trade) {
  const q = filter.q.trim().toLowerCase();
  if (q && !`${signal.symbol} ${signal.strategy}`.toLowerCase().includes(q)) return false;
  if (filter.direction !== 'ALL' && String(signal.direction || '').toUpperCase() !== filter.direction) {
    return false;
  }
  if (filter.state === 'ACTIONABLE' && !(signal.actionable === true && !trade)) return false;
  if (filter.state === 'SHADOW' && lifecycleState(signal) !== 'SHADOW') return false;
  if (filter.state === 'CLOSED' && lifecycleState(signal) !== 'CLOSED') return false;
  return true;
}

// The three evidence components the verdict was built from, in the order a
// reader wants them: what price did, what flow said, what the news said.
function componentPills(components) {
  if (!components || typeof components !== 'object') return null;
  const order = ['price', 'flow', 'news'];
  const keys = Object.keys(components);
  const sorted = [
    ...order.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !order.includes(key)),
  ];
  return (
    <span className="sig-components">
      {sorted.map((key) => {
        const component = components[key];
        const available = component && component.available !== false;
        const tone = available ? scoreTone(component && component.score) : 'muted';
        const title = component && component.detail ? `${key}: ${component.detail}` : key;
        return (
          <span className={`pill ${tone} sig-component`} key={key} title={title}>
            <span className="sig-component-name">{key}</span>{' '}
            {available && component && component.score != null
              ? signed(Number(component.score), 2)
              : 'n/a'}
          </span>
        );
      })}
    </span>
  );
}

function GateSummary({ risk }) {
  if (!risk) {
    return <span className="pill muted">no gate row</span>;
  }
  const passed = risk.passed === true || String(risk.decision || '').toUpperCase() === 'APPROVED';
  const reasons = Array.isArray(risk.reasons) ? risk.reasons : [];
  const first = reasons[0];
  const summary = typeof first === 'string'
    ? first
    : first ? (first.detail || first.reason || first.check || '') : '';
  return (
    <span className="sig-gate">
      <span className={`pill ${passed ? 'up' : 'down'}`}>
        {risk.decision || (passed ? 'APPROVED' : 'BLOCKED')}
      </span>
      {summary ? <span className="small muted sig-gate-note">{summary}</span> : null}
    </span>
  );
}

// The instrument string the harness writes comes in two shapes:
//
//   "UNDERLYING EXPIRY STRIKE TYPE"  ->  "RELIANCE 27-Oct-2026 1240 CE"
//   "SYMBOL spot/futures"             ->  "TCS spot/futures"
//
// Rendering either as one string made the strike unreadable and repeated the
// symbol, so the parts are separated and each is set at the size it deserves.
// When the underlying is the same name as the signal symbol - which it always
// is - it is dropped rather than printed twice. Anything that does not match
// either shape is shown whole rather than guessed at.
function splitInstrument(instrument, symbol) {
  const text = String(instrument || '').trim();
  if (!text) return null;
  const parts = text.split(/\s+/);
  const type = parts[parts.length - 1];
  const strike = parts[parts.length - 2];

  if (parts.length >= 4 && /^\d+(\.\d+)?$/.test(strike) && /^(CE|PE|CALL|PUT)$/i.test(type)) {
    const underlying = parts.slice(0, parts.length - 3).join(' ');
    const sameAsSymbol = String(symbol || '').trim().toUpperCase() === underlying.toUpperCase();
    return {
      underlying: sameAsSymbol ? null : underlying,
      expiry: parts[parts.length - 3],
      contract: `${num(Number(strike))} ${type.toUpperCase()}`,
      descriptor: null,
    };
  }

  if (parts.length === 2 && /^(spot\/futures|spot|futures|equity|cash)$/i.test(parts[1])) {
    return { underlying: null, expiry: null, contract: null, descriptor: parts[1] };
  }

  return { underlying: text, expiry: null, contract: null, descriptor: null };
}

function SignalCard({
  signal, trade, evidence, timeframes, onOpen,
}) {
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

  const verdict = evidence && evidence.verdict;
  const score = verdict && verdict.score != null ? Number(verdict.score) : null;
  const confidence = verdict && verdict.confidence != null ? Number(verdict.confidence) : null;
  const instrument = splitInstrument(signal.instrument, signal.symbol);

  return (
    <div
      className={`card sig-card${blocked ? ' sig-blocked' : ''}`}
      onClick={() => onOpen(signal.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(signal.id);
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`Open full analysis for ${signal.symbol}`}
    >
      <div className="row-between sig-head">
        <div style={{ minWidth: 0 }}>
          <div className="sig-title">
            <strong className="sig-symbol">{signal.symbol}</strong>
            {instrument ? (
              <>
                {instrument.underlying ? (
                  <span className="sig-underlying">{instrument.underlying}</span>
                ) : null}
                {instrument.expiry ? <span className="sig-expiry">{instrument.expiry}</span> : null}
                {instrument.contract ? (
                  <span className="sig-strike mono">{instrument.contract}</span>
                ) : null}
                {instrument.descriptor ? (
                  <span className="sig-expiry">{instrument.descriptor}</span>
                ) : null}
              </>
            ) : signal.strike != null ? (
              <span className="sig-strike mono">
                {num(signal.strike)} {signal.option_type || ''}
              </span>
            ) : null}
          </div>
          <div className="sig-sub">
            {signal.strategy} - {istStamp(signal.published_at)} IST
          </div>
        </div>
        <div className="sig-pills">
          <span className={`pill ${directionTone(signal.direction)}`}>{signal.direction}</span>
          <span className={`pill ${publishModeTone(signal.mode)}`}>
            {signal.mode === 'shadow' ? 'shadow - paper only' : 'delivered'}
          </span>
          {state && state !== 'PUBLISHED' && state !== 'SHADOWED' ? (
            <span className={`pill ${signalStateTone(state)}`}>{state}</span>
          ) : null}
          {configStatus === 'retired' || configStatus === 'candidate' ? (
            <span className={`pill ${riskConfigTone(configStatus)}`}>{configStatus} config</span>
          ) : null}
        </div>
      </div>

      <div className="sig-confirm">
        <div className="sig-confirm-item">
          <div className="k">Bias score</div>
          <div className={`v mono ${scoreTone(score)}`}>
            {score == null ? '-' : signed(score, 3)}
          </div>
        </div>
        <div className="sig-confirm-item">
          <div className="k" title="How complete and fresh the evidence was, not a win probability">
            Data conf.
          </div>
          <div className="v mono">{confidence == null ? '-' : pct(confidence * 100, 0)}</div>
        </div>
        <div className="sig-confirm-item">
          <div className="k">Evidence behind it</div>
          <div className="v sig-components-cell">
            {verdict ? componentPills(verdict.components) : <span className="muted small">no verdict</span>}
          </div>
        </div>
        <div className="sig-confirm-item">
          <div className="k">Risk gate</div>
          <div className="v sig-gate-cell">
            {evidence ? <GateSummary risk={evidence.risk} /> : <span className="muted small">-</span>}
          </div>
        </div>
        {timeframes ? (
          <div className="sig-confirm-item">
            <div className="k">5m / 15m</div>
            <div className="v"><TimeframeBadge read={timeframes} /></div>
          </div>
        ) : null}
      </div>

      <div className="stat-row sig-levels">
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
          <div className="k">Version</div>
          <div className="v mono small">{signal.strategy_version}</div>
        </div>
        <div className="stat">
          <div className="k">Engine</div>
          <div className="v mono small">{signal.engine_version}</div>
        </div>
      </div>

      <div className="row-between sig-foot" onClick={(event) => event.stopPropagation()}>
        <div className="small muted">
          {trade ? (
            <>
              Entered {istStamp(trade.entered_at)} IST
              {trade.outcome ? (
                <> <span className={`pill ${tradeOutcomeTone(trade.outcome)}`}>{trade.outcome}</span></>
              ) : (
                <> <span className={`pill ${tradeStatusTone(trade.status)}`}>{trade.status}</span></>
              )}
            </>
          ) : (
            blockedReason || 'Plan only. Execution is manual.'
          )}
        </div>
        <div className="sig-actions">
          <button type="button" className="sig-open" onClick={() => onOpen(signal.id)}>
            Full analysis
          </button>
          <TradeEnteredButton
            signalId={signal.id}
            tradeId={trade ? trade.id : null}
            compact
            disabled={blocked}
            disabledReason={blockedReason}
          />
        </div>
      </div>

      <SignalEvidence evidence={evidence} />
    </div>
  );
}

export default function SignalList({
  signals = [],
  horizonLabel = 'this horizon',
  tradesBySignal = {},
  evidenceBySignal = {},
  timeframesBySymbol = {},
}) {
  const [filter, setFilter] = useState(EMPTY_FILTER);
  const [drawerId, setDrawerId] = useState(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(FILTER_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        setFilter({
          q: typeof parsed.q === 'string' ? parsed.q : '',
          direction: typeof parsed.direction === 'string' ? parsed.direction : 'ALL',
          state: typeof parsed.state === 'string' ? parsed.state : 'ALL',
        });
      }
    } catch {
      /* a corrupt preference is ignored, not repaired with invented values */
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(FILTER_KEY, JSON.stringify(filter));
    } catch {
      /* storage may be unavailable; filtering still works, it just is not remembered */
    }
  }, [filter]);

  const filtered = useMemo(
    () => signals.filter((signal) => matchesFilter(signal, filter, tradesBySignal[signal.id])),
    [signals, filter, tradesBySignal],
  );

  // The book is equity, mutual funds and ETFs. Index derivatives are separated
  // out of the main list into their own folded panel: they are real published
  // signals, but this household does not trade them, and offering an index
  // option next to a company plan would be misleading.
  const book = filtered.filter((signal) => !isIndexSignal(signal));
  const indexSignals = filtered.filter((signal) => isIndexSignal(signal));

  // Active means the server says the plan can still be acted on, or the person
  // has already entered it. Everything else is history and lives in the
  // collapsed archive below.
  const active = book.filter((signal) => signal.actionable !== false);
  const archived = book.filter((signal) => signal.actionable === false);
  const indexActive = indexSignals.filter((signal) => signal.actionable !== false);
  const indexArchived = indexSignals.filter((signal) => signal.actionable === false);

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

  const showArchive = archived.length > 0;
  const showIndex = indexSignals.length > 0;

  return (
    <div className="stack">
      <div className="signal-filters" role="search">
        <label className="signal-search">
          <span className="sr-only">Filter signals by symbol or strategy</span>
          <input
            type="text"
            value={filter.q}
            onChange={(event) => setFilter((f) => ({ ...f, q: event.target.value }))}
            placeholder="Symbol or strategy"
            autoComplete="off"
            spellCheck="false"
          />
        </label>
        <label className="signal-select">
          <span className="sr-only">Direction</span>
          <select
            value={filter.direction}
            onChange={(event) => setFilter((f) => ({ ...f, direction: event.target.value }))}
          >
            <option value="ALL">All directions</option>
            <option value="BULLISH">Bullish</option>
            <option value="BEARISH">Bearish</option>
            <option value="NEUTRAL">Neutral</option>
          </select>
        </label>
        <label className="signal-select">
          <span className="sr-only">State</span>
          <select
            value={filter.state}
            onChange={(event) => setFilter((f) => ({ ...f, state: event.target.value }))}
          >
            <option value="ALL">All states</option>
            <option value="ACTIONABLE">Actionable</option>
            <option value="SHADOW">Shadow</option>
            <option value="CLOSED">Closed</option>
          </select>
        </label>
        <div className="signal-presets" role="group" aria-label="Saved views">
          {PRESETS.map((preset) => {
            const activeView = filter.q.trim() === preset.filter.q
              && filter.direction === preset.filter.direction
              && filter.state === preset.filter.state;
            return (
              <button
                type="button"
                key={preset.id}
                className={`view-chip${activeView ? ' active' : ''}`}
                onClick={() => setFilter({ ...preset.filter })}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        <span className="tick nowrap">
          {filtered.length !== signals.length
            ? `${filtered.length} of ${signals.length}`
            : `${active.length} active`}
        </span>
      </div>

      {!active.length && (showArchive || showIndex) ? (
        <div className="empty">
          <strong>No active signals in this view</strong>
          {`${book.length} book signal(s) match, but none of them is active right now.`}
        </div>
      ) : null}

      {active.map((signal) => (
        <SignalCard
          key={signal.id}
          signal={signal}
          trade={tradesBySignal[signal.id]}
          evidence={evidenceBySignal[signal.id]}
          timeframes={timeframesBySymbol[signal.symbol] || null}
          onOpen={setDrawerId}
        />
      ))}

      {showArchive ? (
        <details className="sig-archive">
          <summary>
            <span className="sig-archive-title">Archive</span>
            <span className="small muted">
              {archived.length} non-actionable signal(s): voided, exited, expired, or written by a
              retired risk config.
            </span>
          </summary>
          <div className="stack sig-archive-body">
            {archived.map((signal) => (
              <SignalCard
                key={signal.id}
                signal={signal}
                trade={tradesBySignal[signal.id]}
                evidence={evidenceBySignal[signal.id]}
                timeframes={timeframesBySymbol[signal.symbol] || null}
                onOpen={setDrawerId}
              />
            ))}
          </div>
        </details>
      ) : null}

      {showIndex ? (
        <details className="sig-archive">
          <summary>
            <span className="sig-archive-title">Index signals</span>
            <span className="small muted">
              {indexSignals.length} signal(s) on NIFTY, BANKNIFTY, MIDCPNIFTY or SENSEX. These are
              index derivatives, not part of the equity / mutual fund / ETF book, so they are kept
              out of the list above. Nothing is dropped: they are published and stored like any
              other signal.
            </span>
          </summary>
          <div className="stack sig-archive-body">
            {indexActive.map((signal) => (
              <SignalCard
                key={signal.id}
                signal={signal}
                trade={tradesBySignal[signal.id]}
                evidence={evidenceBySignal[signal.id]}
                timeframes={timeframesBySymbol[signal.symbol] || null}
                onOpen={setDrawerId}
              />
            ))}
            {indexArchived.map((signal) => (
              <SignalCard
                key={signal.id}
                signal={signal}
                trade={tradesBySignal[signal.id]}
                evidence={evidenceBySignal[signal.id]}
                timeframes={timeframesBySymbol[signal.symbol] || null}
                onOpen={setDrawerId}
              />
            ))}
          </div>
        </details>
      ) : null}

      <SignalDrawer
        signalId={drawerId}
        open={Boolean(drawerId)}
        onClose={() => setDrawerId(null)}
      />
    </div>
  );
}
