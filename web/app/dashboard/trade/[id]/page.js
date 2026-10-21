import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import {
  getTradeEntry, getLatestQuote, getQuoteSeries, getOptionSeries,
  getFlowFeature, getFlowContracts, getExactOptionContract, getBiasVerdict,
  getSignalEvents, getEvaluatorOutcome, getTapeAnalytics,
} from '@/lib/queries';
import {
  optionContractKey, computeMomentum, computeTradePnl, computeTheta,
  findContract, normaliseOptionType,
} from '@/lib/trade';
import { aggregateFootprint, normaliseDepth } from '@/lib/tape';
import {
  directionTone, num, pct, signed, istStamp, timeAgo, readTone, scoreTone,
  resultTone, resultLabel, tradeOutcomeTone, tradeStatusTone,
} from '@/lib/format';
import Provenance from '@/components/Provenance';
import LiveRefresh from '@/components/LiveRefresh';
import TradeOutcomeButtons from '@/components/TradeOutcomeButtons';
import PriceSparkline from '@/components/PriceSparkline';
import FootprintPanel from '@/components/FootprintPanel';
import OrderBookPanel from '@/components/OrderBookPanel';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Trade workspace - Trading Factory' };

function Stat({ k, v, tone = '' }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className={`v ${tone}`.trim()}>{v}</div>
    </div>
  );
}

function componentScore(component) {
  if (!component || component.available === false || component.score === null || component.score === undefined) {
    return 'n/a';
  }
  return signed(component.score, 2);
}

// Evidence and reasons are strings today, but the JSONB columns are open. Render
// an object as its useful fields instead of letting React throw on it.
function textOf(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.detail) return String(value.detail);
    if (value.reason) return String(value.reason);
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
}

export default async function TradeWorkspacePage({ params }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const email = String(user.email || '').trim().toLowerCase();
  const trade = await getTradeEntry(id, email);
  if (!trade) notFound();

  const snapshot = trade.snapshot || {};
  const plan = snapshot.plan || {};
  const optionType = normaliseOptionType(trade.option_type);
  const isOption = Boolean(trade.strike && optionType);
  const position = String(plan.position || (trade.direction === 'BEARISH' ? 'SHORT' : 'LONG')).toUpperCase();
  const expiry = plan.expiry || null;
  const contractKey = isOption
    ? optionContractKey({
      symbol: trade.symbol, expiry, strike: trade.strike, optionType,
    })
    : null;

  const [quote, quoteSeries, optionSeries, flowFeature, flowContracts, exactContract, bias, events, evaluatorOutcome, tape, optionTape] = await Promise.all([
    getLatestQuote(trade.symbol),
    getQuoteSeries(trade.symbol, 120),
    contractKey ? getOptionSeries(contractKey, 120) : Promise.resolve([]),
    getFlowFeature(trade.symbol),
    getFlowContracts(trade.symbol, 6),
    isOption && expiry
      ? getExactOptionContract({
        symbol: trade.symbol, strike: trade.strike, optionType, expiry,
      })
      : Promise.resolve(null),
    getBiasVerdict(trade.horizon, trade.symbol),
    getSignalEvents(trade.signal_id, 6),
    getEvaluatorOutcome(trade.signal_id),
    getTapeAnalytics(trade.symbol, { contract: null, minutes: 30 }),
    isOption && contractKey
      ? getTapeAnalytics(trade.symbol, { contract: contractKey, minutes: 30 })
      : Promise.resolve(null),
  ]);

  const flowValues = (flowFeature && flowFeature.values) || {};
  const topContracts = Array.isArray(flowValues.topContracts) ? flowValues.topContracts : [];
  const displayedContracts = topContracts.length
    ? topContracts
    : flowContracts.map((contract) => ({
      ...contract,
      oiChange: contract.oi_change,
      priceChangePct: contract.price_change_pct,
    }));
  const fallbackContract = isOption
    ? findContract([...topContracts, ...flowContracts], { strike: trade.strike, optionType, expiry })
    : null;
  const optionQuote = optionSeries.length ? optionSeries[optionSeries.length - 1] : null;
  const premium = optionQuote && optionQuote.ltp !== null
    ? optionQuote.ltp
    : (exactContract ? exactContract.price : (fallbackContract ? fallbackContract.price : null));
  const premiumSource = optionQuote
    ? `broker option quote (${optionQuote.provenance || 'source unknown'})`
    : exactContract
      ? `NSE OI snapshot at ${istStamp(exactContract.captured_at)} IST`
      : fallbackContract
        ? `NSE OI snapshot at ${istStamp((flowFeature && flowFeature.as_of) || fallbackContract.captured_at)} IST`
        : 'awaiting a live option premium';

  const quoteValues = (quote && quote.values) || {};
  const spot = quoteValues.ltp === undefined || quoteValues.ltp === null ? plan.spot : quoteValues.ltp;
  const entry = trade.entry_price === null || trade.entry_price === undefined
    ? trade.plan_entry
    : trade.entry_price;
  const currentPrice = isOption ? premium : quoteValues.ltp;
  const pnl = computeTradePnl({
    position, entry, current: currentPrice, stop: trade.stop, target: trade.target,
  });
  const momentum = computeMomentum(quoteSeries);
  const premiumMomentum = computeMomentum(optionSeries);
  const theta = isOption
    ? computeTheta({ premium, spot, strike: trade.strike, optionType, expiry })
    : null;

  const tapeBook = normaliseDepth(tape.depth);
  const tapeAnalysis = aggregateFootprint(tape.ticks, { maxBars: 12, maxLevels: 14 });
  tapeAnalysis.imbalance = tapeBook ? tapeBook.imbalance : null;
  tapeAnalysis.latestAt = tape.latestTick
    ? tape.latestTick.captured_at
    : (tape.ticks.length ? tape.ticks[tape.ticks.length - 1].captured_at : null);

  const optionTapeBook = optionTape ? normaliseDepth(optionTape.depth) : null;
  const optionTapeAnalysis = optionTape
    ? aggregateFootprint(optionTape.ticks, { maxBars: 12, maxLevels: 14 })
    : null;
  if (optionTapeAnalysis) {
    optionTapeAnalysis.imbalance = optionTapeBook ? optionTapeBook.imbalance : null;
    optionTapeAnalysis.latestAt = optionTape.latestTick
      ? optionTape.latestTick.captured_at
      : (optionTape.ticks.length ? optionTape.ticks[optionTape.ticks.length - 1].captured_at : null);
  }

  const dayChangePct = quoteValues.close && quoteValues.ltp
    ? ((Number(quoteValues.ltp) - Number(quoteValues.close)) / Number(quoteValues.close)) * 100
    : null;
  const rangePosition = quoteValues.high && quoteValues.low && quoteValues.ltp
    ? ((Number(quoteValues.ltp) - Number(quoteValues.low)) / (Number(quoteValues.high) - Number(quoteValues.low))) * 100
    : null;
  const topVolume = displayedContracts.reduce((sum, contract) => sum + (Number(contract.volume) || 0), 0);
  const closed = String(trade.status || '').toUpperCase() === 'CLOSED';
  const outcomeTone = tradeOutcomeTone(trade.outcome);
  const heroTone = closed
    ? (outcomeTone === 'muted' ? 'sig' : outcomeTone)
    : (pnl.available && pnl.pnl > 0 ? 'up' : pnl.available && pnl.pnl < 0 ? 'down' : 'sig');
  const headline = closed
    ? `${trade.symbol} - ${trade.outcome || 'closed'}`
    : `${trade.symbol} - trade open`;

  return (
    <div className="stack">
      <div className="page-head">
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1>Trade workspace</h1>
          <p className="muted small" style={{ margin: '5px 0 0' }}>
            {trade.instrument || 'spot / futures'} - {trade.horizon} - {position} - entered{' '}
            {istStamp(trade.entered_at)} IST
          </p>
          <p className="muted small" style={{ margin: '3px 0 0' }}>
            A focused, live view of this position. Execution is manual; this page never places an order.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className={`pill ${directionTone(trade.direction)}`}>{trade.direction}</span>
          <span className={`pill ${tradeStatusTone(trade.status)}`}>{trade.status}</span>
          {trade.outcome ? (
            <span className={`pill ${tradeOutcomeTone(trade.outcome)}`}>{trade.outcome}</span>
          ) : null}
          <Provenance value={quote && quote.provenance} />
          <LiveRefresh seconds={15} />
          <a
            className="btn ghost sm"
            href={`/dashboard/trade/${trade.id}`}
            target="_blank"
            rel="noreferrer"
          >
            Open in new tab
          </a>
        </div>
      </div>

      <section className={`banner-hud ${heroTone}`} aria-label="Trade status">
        <i className="lamp" aria-hidden="true" />
        <h2 className="head">{headline}</h2>
        <div className="facts">
          <span className="fact"><span className="fk">entry</span><span className="fv">{num(entry, 2)}</span></span>
          <span className="fact"><span className="fk">live</span><span className="fv">{currentPrice === null || currentPrice === undefined ? 'awaiting' : num(currentPrice, 2)}</span></span>
          <span className="fact"><span className="fk">P&amp;L</span><span className="fv">{pnl.available ? pct(pnl.pnlPct, 2) : '-'}</span></span>
          <span className="fact"><span className="fk">R</span><span className="fv">{pnl.rMultiple === null || pnl.rMultiple === undefined ? '-' : `${num(pnl.rMultiple, 2)}R`}</span></span>
          <span className="fact"><span className="fk">DTE</span><span className="fv">{theta && theta.dte !== null && theta.dte !== undefined ? `${num(theta.dte, 1)}d` : '-'}</span></span>
        </div>
        <p className="note">
          {closed
            ? 'Your outcome mark is stored separately from the evaluator. Reopen the trade if the mark was a mistake.'
            : `Entry is the plan price recorded when the trade was marked. Live data refreshes every 15 seconds. ${isOption ? `Premium source: ${premiumSource}.` : 'Underlying quote source is shown above.'}`}
        </p>
      </section>

      <div className="grid cols-2">
        <section className="card">
          <h2>Trade plan</h2>
          <div className="stat-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <Stat k="Entry" v={num(trade.plan_entry, 2)} />
            <Stat k="Target" v={num(trade.target, 2)} />
            <Stat k="Stop" v={num(trade.stop, 2)} />
            <Stat k="R:R" v={num(trade.rr, 2)} />
          </div>
          <div className="stat-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 8 }}>
            <Stat k="Confidence" v={trade.confidence == null ? '-' : pct(trade.confidence * 100, 0)} />
            <Stat k="Probability" v={trade.probability == null ? '-' : pct(trade.probability * 100, 0)} />
            <Stat k="Position" v={position} />
            <Stat k="Published" v={istStamp(trade.published_at)} />
          </div>

          <div className="hr" />
          <div className="small muted">
            {trade.strategy} / {trade.strategy_version} - engine {trade.engine_version}
            {trade.setup_key ? ` - setup ${trade.setup_key}` : ''}
          </div>

          {Array.isArray(plan.reasons) && plan.reasons.length ? (
            <>
              <div className="hr" />
              <div className="k">Why this plan exists</div>
              <ul className="small muted" style={{ margin: '6px 0 0', paddingLeft: 16 }}>
                {plan.reasons.map((reason, index) => <li key={index}>{textOf(reason)}</li>)}
              </ul>
            </>
          ) : null}

          {isOption ? (
            <>
              <div className="hr" />
              <div className="stat-row" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                <Stat k="Expiry" v={expiry || '-'} />
                <Stat k="Strike" v={num(trade.strike, 0)} />
                <Stat k="Type" v={optionType || '-'} />
              </div>
            </>
          ) : null}

          <div className="hr" />
          <h3>Mark outcome</h3>
          <p className="hint">
            These buttons record your own journal mark. They do not change the evaluator or the risk gate.
          </p>
          <TradeOutcomeButtons
            tradeId={trade.id}
            currentOutcome={trade.outcome}
            status={trade.status}
          />
        </section>

        <section className="card">
          <h2>Live price</h2>
          {quote ? (
            <>
              <div className="stat-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                <Stat k={isOption ? 'Underlying' : 'LTP'} v={num(spot, 2)} />
                <Stat
                  k="Day change"
                  v={dayChangePct == null ? '-' : pct(dayChangePct, 2)}
                  tone={dayChangePct == null ? '' : dayChangePct >= 0 ? 'tone-up' : 'tone-down'}
                />
                <Stat k="Day high" v={num(quoteValues.high, 2)} />
                <Stat k="Day low" v={num(quoteValues.low, 2)} />
              </div>
              <div className="stat-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 8 }}>
                <Stat k="Range position" v={rangePosition == null ? '-' : `${num(rangePosition, 0)}%`} />
                <Stat k="Volume" v={quoteValues.volume == null ? '-' : num(quoteValues.volume, 0)} />
                <Stat k="Open" v={num(quoteValues.open, 2)} />
                <Stat k="Prev close" v={num(quoteValues.close, 2)} />
              </div>
              <div className="small muted" style={{ marginTop: 10 }}>
                {quote.provenance || 'source unknown'} - quote time {istStamp(quoteValues.quoteTime || quote.as_of)} IST
                {' '}({timeAgo(quoteValues.quoteTime || quote.as_of)})
              </div>
              <div className="hr" />
              {isOption ? (
                <div className="stat-row" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                  <Stat k="Option premium" v={premium == null ? 'awaiting' : num(premium, 2)} />
                  <Stat k="Entry" v={num(entry, 2)} />
                  <Stat
                    k="Premium P&L"
                    v={pnl.available ? pct(pnl.pnlPct, 2) : '-'}
                    tone={pnl.available ? (pnl.pnl >= 0 ? 'tone-up' : 'tone-down') : ''}
                  />
                </div>
              ) : null}
              <div className="small muted" style={{ marginTop: 10 }}>
                {isOption ? `Premium source: ${premiumSource}` : 'Underlying quote is the price series used for this plan.'}
              </div>
              <div className="hr" />
              <PriceSparkline
                series={isOption && optionSeries.length ? optionSeries : quoteSeries}
                tone={isOption && optionSeries.length
                  ? (premiumMomentum && premiumMomentum.changePct < 0 ? 'down' : 'up')
                  : (dayChangePct != null && dayChangePct < 0 ? 'down' : 'up')}
              />
              <div className="small muted" style={{ marginTop: 4 }}>
                {isOption && optionSeries.length ? 'Option premium path' : 'Underlying price path'}
              </div>
            </>
          ) : (
            <div className="empty">
              <strong>No live quote yet</strong>
              The harness has not stored a quote for {trade.symbol}. The plan levels are still available,
              but P&amp;L and momentum cannot be calculated honestly without a price.
            </div>
          )}
        </section>
      </div>

      <div className="grid cols-2">
        <section className="card">
          <h2>Momentum</h2>
          {momentum ? (
            <>
              <div className="stat-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                <Stat
                  k={`${num(momentum.windowMinutes, 0)}m change`}
                  v={pct(momentum.changePct, 2)}
                  tone={momentum.changePct >= 0 ? 'tone-up' : 'tone-down'}
                />
                <Stat k="Range position" v={momentum.rangePosition == null ? '-' : `${num(momentum.rangePosition, 0)}%`} />
                <Stat k="Window high" v={num(momentum.high, 2)} />
                <Stat k="Window low" v={num(momentum.low, 2)} />
              </div>
              <div className="small muted" style={{ marginTop: 10 }}>
                {momentum.samples} samples over {num(momentum.windowMinutes, 0)} minutes. Range position
                0% is the window low, 100% is the window high.
              </div>
              <div className="hr" />
              <PriceSparkline
                series={quoteSeries}
                tone={momentum.changePct >= 0 ? 'up' : 'down'}
              />
              {isOption && premiumMomentum ? (
                <>
                  <div className="hr" />
                  <div className="stat-row" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                    <Stat
                      k="Premium change"
                      v={pct(premiumMomentum.changePct, 2)}
                      tone={premiumMomentum.changePct >= 0 ? 'tone-up' : 'tone-down'}
                    />
                    <Stat k="Premium window" v={`${num(premiumMomentum.windowMinutes, 0)}m`} />
                    <Stat k="Premium samples" v={premiumMomentum.samples} />
                  </div>
                  <PriceSparkline
                    series={optionSeries}
                    tone={premiumMomentum.changePct >= 0 ? 'up' : 'down'}
                  />
                </>
              ) : null}
            </>
          ) : (
            <div className="empty">
              <strong>Momentum needs a price path</strong>
              At least two quote samples are needed before a direction can be called.
            </div>
          )}
        </section>

        <section className="card">
          <h2>Order flow</h2>
          {flowFeature ? (
            <>
              <div className="row-between">
                <div className="small muted">
                  NSE OI snapshot {istStamp(flowFeature.as_of)} IST ({timeAgo(flowFeature.as_of)})
                </div>
                {flowValues.underlyingRead ? (
                  <span className={`pill ${readTone(flowValues.underlyingRead)}`}>{flowValues.underlyingRead}</span>
                ) : null}
              </div>
              <div className="stat-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 10 }}>
                <Stat
                  k="Net OI change"
                  v={num(flowValues.netOiChange, 0)}
                  tone={flowValues.netOiChange == null ? '' : Number(flowValues.netOiChange) >= 0 ? 'tone-up' : 'tone-down'}
                />
                <Stat k="CE OI change" v={num(flowValues.ceOiChange, 0)} />
                <Stat k="PE OI change" v={num(flowValues.peOiChange, 0)} />
                <Stat k="PCR change" v={num(flowValues.pcrOiChange, 2)} />
              </div>
              <div className="stat-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 8 }}>
                <Stat k="Long buildup" v={num(flowValues.longBuildup, 0)} tone="tone-up" />
                <Stat k="Short buildup" v={num(flowValues.shortBuildup, 0)} tone="tone-down" />
                <Stat k="Long unwinding" v={num(flowValues.longUnwinding, 0)} tone="tone-down" />
                <Stat k="Short covering" v={num(flowValues.shortCovering, 0)} tone="tone-up" />
              </div>
              <div className="hr" />
              <div className="k">Largest OI moves in this name</div>
              {displayedContracts.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Contract</th>
                        <th>Read</th>
                        <th>OI chg</th>
                        <th>Price</th>
                        <th>Chg</th>
                        <th>Volume</th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayedContracts.slice(0, 6).map((contract, index) => (
                        <tr key={`${contract.contract || 'contract'}-${index}`}>
                          <td className="mono small">{contract.contract || '-'}</td>
                          <td><span className={`pill ${readTone(contract.read)}`}>{contract.read || '-'}</span></td>
                          <td className="mono">{num(contract.oiChange, 0)}</td>
                          <td className="mono">{num(contract.price, 2)}</td>
                          <td className={`mono ${contract.priceChangePct == null ? '' : Number(contract.priceChangePct) >= 0 ? 'tone-up' : 'tone-down'}`}>
                            {contract.priceChangePct == null ? '-' : pct(contract.priceChangePct, 2)}
                          </td>
                          <td className="mono">{num(contract.volume, 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="small muted">No contract-level OI rows in the latest snapshot.</div>
              )}
              <p className="hint" style={{ marginBottom: 0 }}>
                OI positioning is the slower derivatives view. The tick-level footprint and the
                live order-book ladder are in the two panels below; they come from the broker tape,
                not from this OI snapshot.
              </p>
            </>
          ) : (
            <div className="empty">
              <strong>No flow snapshot for this name</strong>
              The NSE OI feed has not covered {trade.symbol} yet. The plan is still valid; this panel
              will fill in when the next flow cycle stores a row.
            </div>
          )}
        </section>
      </div>

      <div className="grid cols-2">
        <FootprintPanel
          analysis={tapeAnalysis}
          title={`Footprint - ${trade.symbol}`}
          subtitle="Tape-derived, last 30 minutes. Buy/sell side is inferred from the best bid/ask."
        />
        <OrderBookPanel
          depth={tape.depth}
          history={tape.depthHistory}
          title={`Order book - ${trade.symbol}`}
        />
      </div>

      {isOption && optionTapeAnalysis ? (
        <div className="grid cols-2">
          <FootprintPanel
            analysis={optionTapeAnalysis}
            title={`Footprint - ${trade.symbol} ${num(trade.strike, 0)} ${optionType}`}
            subtitle="Tape-derived, last 30 minutes for this contract. Option prints can be sparse."
          />
          <OrderBookPanel
            depth={optionTape ? optionTape.depth : null}
            history={optionTape ? optionTape.depthHistory : []}
            title={`Order book - ${trade.symbol} ${num(trade.strike, 0)} ${optionType}`}
          />
        </div>
      ) : null}

      <div className="grid cols-2">
        <section className="card">
          <h2>Volume</h2>
          <div className="stat-row" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <Stat k="Underlying volume" v={num(flowValues.underlyingVolume, 0)} />
            <Stat k="Top contracts volume" v={num(topVolume, 0)} />
            <Stat k="Quote volume" v={num(quoteValues.volume, 0)} />
          </div>
          <p className="hint" style={{ marginBottom: 0 }}>
            Index volume is often absent from delayed quote feeds. Contract volume is the sum of the
            largest OI moves shown in the flow panel, not the whole option chain.
          </p>
        </section>

        <section className="card">
          <h2>Theta decay meter</h2>
          {isOption ? (
            theta && theta.available ? (
              <>
                <div className="stat-row" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                  <Stat k="Days to expiry" v={theta.dte == null ? '-' : `${num(theta.dte, 1)}d`} tone={theta.dte != null && theta.dte <= 2 ? 'tone-warn' : ''} />
                  <Stat k="Intrinsic" v={num(theta.intrinsic, 2)} />
                  <Stat k="Extrinsic" v={num(theta.extrinsic, 2)} />
                </div>
                <div className="stat-row" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 8 }}>
                  <Stat k="Theta / day proxy" v={num(theta.thetaPerDay, 2)} tone="tone-warn" />
                  <Stat k="Extrinsic share" v={theta.extrinsicPct == null ? '-' : `${num(theta.extrinsicPct, 1)}%`} />
                  <Stat k="Premium" v={num(theta.premium, 2)} />
                </div>
                <div className="meter" style={{ marginTop: 14 }}>
                  <span style={{ width: `${Math.max(0, Math.min(100, Number(theta.extrinsicPct) || 0))}%` }} />
                </div>
                <p className="hint" style={{ marginBottom: 0 }}>
                  The bar is the extrinsic share of the premium. A high share close to expiry is the
                  decay risk. This is a time-value proxy, not broker Greeks.
                </p>
              </>
            ) : (
              <div className="empty">
                <strong>Time value cannot be computed yet</strong>
                {theta && theta.dte != null ? `There are about ${num(theta.dte, 1)} days to expiry. ` : ''}
                A live premium, strike and spot are needed to separate intrinsic from extrinsic value.
              </div>
            )
          ) : (
            <div className="empty">
              <strong>Not an option position</strong>
              This plan trades the underlying, so there is no option premium to decay. The risk is
              the stop distance and the horizon&apos;s holding window.
            </div>
          )}
        </section>
      </div>

      <div className="grid cols-2">
        <section className="card">
          <h2>Bias evidence</h2>
          {bias ? (
            <>
              <div className="stat-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                <Stat k="Direction" v={<span className={`pill ${directionTone(bias.direction)}`}>{bias.direction}</span>} />
                <Stat k="Score" v={signed(bias.score, 2)} tone={scoreTone(bias.score) === 'up' ? 'tone-up' : scoreTone(bias.score) === 'down' ? 'tone-down' : ''} />
                <Stat k="Confidence" v={bias.confidence == null ? '-' : pct(bias.confidence * 100, 0)} />
                <Stat k="Coverage" v={bias.coverage == null ? '-' : pct(bias.coverage * 100, 0)} />
              </div>
              <div className="small muted" style={{ marginTop: 8 }}>
                Verdict {istStamp(bias.as_of)} IST ({timeAgo(bias.as_of)})
              </div>
              <div className="hr" />
              {Object.entries(bias.components || {}).map(([key, component]) => (
                <div className="row-between" key={key} style={{ alignItems: 'flex-start', padding: '6px 0' }}>
                  <div>
                    <strong>{key}</strong>
                    <div className="small muted">{textOf(component.detail) || 'no detail'}</div>
                  </div>
                  <div className={`mono ${scoreTone(component.score) === 'up' ? 'tone-up' : scoreTone(component.score) === 'down' ? 'tone-down' : 'tone-muted'}`}>
                    {componentScore(component)}
                  </div>
                </div>
              ))}
              {Array.isArray(bias.evidence) && bias.evidence.length ? (
                <>
                  <div className="hr" />
                  <ul className="small muted" style={{ margin: 0, paddingLeft: 16 }}>
                    {bias.evidence.map((item, index) => <li key={index}>{textOf(item)}</li>)}
                  </ul>
                </>
              ) : null}
              <p className="hint" style={{ marginBottom: 0 }}>
                Bias is the evidence that created the signal. It is not a live exit trigger; the
                stop, target and your read of the market still decide the trade.
              </p>
            </>
          ) : (
            <div className="empty">
              <strong>No bias verdict stored</strong>
              The signal has a plan but the bias series has no row for this symbol and horizon.
            </div>
          )}
        </section>

        <section className="card">
          <h2>Evaluator record</h2>
          {evaluatorOutcome ? (
            <>
              <div className="stat-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                <Stat k="Result" v={<span className={`pill ${resultTone(evaluatorOutcome.result)}`}>{resultLabel(evaluatorOutcome.result)}</span>} />
                <Stat k="Exit" v={num(evaluatorOutcome.exit, 2)} />
                <Stat
                  k="P&L"
                  v={pct(evaluatorOutcome.pnl_pct, 2)}
                  tone={evaluatorOutcome.pnl_pct == null ? '' : Number(evaluatorOutcome.pnl_pct) >= 0 ? 'tone-up' : 'tone-down'}
                />
                <Stat k="Bars held" v={num(evaluatorOutcome.bars_held, 0)} />
              </div>
              <div className="stat-row" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 8 }}>
                <Stat k="MFE" v={pct(evaluatorOutcome.mfe, 2)} />
                <Stat k="MAE" v={pct(evaluatorOutcome.mae, 2)} />
                <Stat k="Evaluated" v={istStamp(evaluatorOutcome.evaluated_at)} />
              </div>
              <p className="hint" style={{ marginBottom: 0 }}>
                This is the harness&apos;s own close, derived from the recorded price path. It is
                independent of the journal mark above.
              </p>
            </>
          ) : (
            <div className="empty">
              <strong>No evaluator close yet</strong>
              The position is still open, or it cannot be priced from the stored series. That is not
              a win or a loss; it is an unresolved record.
            </div>
          )}

          {events.length ? (
            <>
              <div className="hr" />
              <div className="k">Signal state history</div>
              <ul className="small muted" style={{ margin: '6px 0 0', paddingLeft: 16 }}>
                {events.map((event, index) => (
                  <li key={index}>
                    {istStamp(event.at)} - {event.new_state}: {textOf(event.reason)}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      </div>

      <section className="card">
        <h2>Data coverage</h2>
        <div className="grid cols-2">
          <ul className="small muted" style={{ margin: 0, paddingLeft: 16 }}>
            <li>Underlying quote: {quote ? `${quote.provenance || 'source unknown'}, ${timeAgo(quoteValues.quoteTime || quote.as_of)}` : 'not available'}</li>
            <li>Option premium: {isOption ? premiumSource : 'not an option position'}</li>
            <li>Order flow: {flowFeature ? `NSE OI snapshot, ${timeAgo(flowFeature.as_of)}` : 'not available'}</li>
            <li>Signal bias: {bias ? `${bias.direction} at ${bias.confidence == null ? '-' : pct(bias.confidence * 100, 0)} confidence` : 'not available'}</li>
          </ul>
          <ul className="small muted" style={{ margin: 0, paddingLeft: 16 }}>
            <li>
              Tape: {tape.ticks.length
                ? `${tape.ticks.length} prints, ${tapeAnalysis.bars.length} one-minute bar(s), last 30 minutes`
                : 'no prints in the last 30 minutes'}
            </li>
            <li>
              Order book: {tapeBook
                ? `${tapeBook.levels} level(s), ${timeAgo(tape.depth.captured_at)}`
                : 'no snapshot yet'}
            </li>
            <li>
              Footprint side is tape-derived (print versus best bid/ask), not an exchange aggressor
              flag. Full anonymous order book is not published to retail feeds.
            </li>
            <li>Broker Greeks: not available; the theta meter is a time-value proxy.</li>
            <li>Live option quotes and tape depend on Angel One being configured on the harness host.</li>
            <li>Execution: manual only. This page never sends an order.</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
