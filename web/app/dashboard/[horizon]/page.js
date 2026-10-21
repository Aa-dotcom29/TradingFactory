import { notFound } from 'next/navigation';
import {
  getSignals, getFlow, getNews, getEntityFeatures, getFlowFeatures, getBias,
  getSignalStages, getSignalCandidates, getRiskDecisions, getHorizonPulse,
  getOutcomes, getOutcomeStats, getOpenPositions, getTradesForSignals,
  getSignalEvidence, getIndexTimeframeBias,
} from '@/lib/queries';
import { getCurrentUser } from '@/lib/auth';
import { horizonByKey } from '@/lib/horizons';
import { publishModeFor } from '@/lib/publish';
import StatusBanner from '@/components/StatusBanner';
import SignalList from '@/components/SignalList';
import SignalStages from '@/components/SignalStages';
import SignalCandidates from '@/components/SignalCandidates';
import RiskDecisions from '@/components/RiskDecisions';
import Outcomes from '@/components/Outcomes';
import FlowPanel, { FlowUnderlyings } from '@/components/FlowPanel';
import EntityIntel from '@/components/EntityIntel';
import FlowFeatures from '@/components/FlowFeatures';
import BiasPanel from '@/components/BiasPanel';
import NewsList from '@/components/NewsList';
import Collapsible from '@/components/Collapsible';
import TimeframeAlignment from '@/components/TimeframeAlignment';

export const dynamic = 'force-dynamic';

// The index names that have a stored quote stream, in the order a reader
// expects them. A name with no quotes in the window is left out entirely
// rather than shown with an empty alignment.
const INDEX_ORDER = ['NIFTY', 'MIDCPNIFTY', 'BANKNIFTY', 'SENSEX'];

function horizonIndexRows(timeframes) {
  if (!timeframes) return [];
  return INDEX_ORDER
    .filter((symbol) => timeframes[symbol])
    .map((symbol) => ({ symbol, read: timeframes[symbol] }));
}

export async function generateMetadata({ params }) {
  const { horizon } = await params;
  const meta = horizonByKey(horizon);
  return { title: meta ? `${meta.label} - Trading Factory` : 'Trading Factory' };
}

export default async function HorizonPage({ params }) {
  const { horizon: raw } = await params;
  const horizon = horizonByKey(raw);
  if (!horizon) notFound();

  const user = await getCurrentUser();
  const [signals, flow, news, entityData, flowFeatures, bias, stages, candidates, riskDecisions, pulse, closed, outcomeStats, openPositions, timeframes] = await Promise.all([
    getSignals(horizon.key),
    getFlow(horizon.key === 'POSITIONAL' ? 12 : 20),
    getNews(20),
    getEntityFeatures(8),
    getFlowFeatures(10),
    getBias(horizon.key, 12),
    getSignalStages(horizon.key, 12),
    getSignalCandidates(horizon.key, 10),
    getRiskDecisions(horizon.key, 8),
    getHorizonPulse(horizon.key),
    getOutcomes(horizon.key, 10),
    getOutcomeStats(horizon.key),
    getOpenPositions(horizon.key, 8),
    getIndexTimeframeBias(),
  ]);

  const email = String((user && user.email) || '').trim().toLowerCase();
  const tradesBySignal = await getTradesForSignals(signals.map((signal) => signal.id), email);
  const evidenceBySignal = await getSignalEvidence(signals.map((signal) => signal.id));
  const live = publishModeFor(horizon.key) === 'live';

  return (
    <div className="stack">
      <div className="page-head">
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1>{horizon.label}</h1>
          <p className="muted small" style={{ margin: '5px 0 0' }}>
            {horizon.blurb} - cadence {horizon.cadence}
          </p>
          <p className="muted small" style={{ margin: '3px 0 0' }}>
            Risk profile: {horizon.risk}. Manual execution only.
          </p>
        </div>
        <span className="pill accent">{horizon.key}</span>
      </div>

      <StatusBanner
        tone={pulse.ready > 0 ? 'up' : 'sig'}
        headline={pulse.ready > 0
          ? `${pulse.ready} ready for the gate`
          : pulse.published24h > 0
            ? `Nothing at the gate now - ${pulse.published24h} published in 24h`
            : 'No names ready yet'}
        facts={[
          { k: 'tracked', v: pulse.tracked },
          { k: 'bullish', v: pulse.bullish },
          { k: 'building', v: pulse.building },
          { k: 'queued', v: pulse.queued },
          { k: 'open', v: pulse.openPositions },
          { k: 'closed 24h', v: pulse.closed24h },
          { k: 'approved 24h', v: pulse.approved24h },
          { k: 'published 24h', v: pulse.published24h },
        ]}
        note={
          `${horizon.label} candidates are raised at READY and must clear every gate before anything is published. ` +
          'READY counts the names waiting at the gate right now; a market that is closed sends every ' +
          'name back to IDLE, so an empty gate is not the same as no signal. ' +
          (live
            ? 'Delivery is live; approved signals go to the household channel and execution is manual.'
            : 'Delivery is in shadow, so nothing is being sent yet - the ledger is still written in full.')
        }
      />

      {/* Published signals come first: this is the panel a trader acts on, so it
          should not be buried under the diagnostic panels that explain it. */}
      <section className="card">
        <h2>Published signals</h2>
        <p className="hint">
          Risk-gated, versioned signals. Shadow signals are paper-only and were not delivered.
          Option plans are scored on their own premium series, not on the underlying spot; a plan
          with no premium print is marked unpriced rather than stopped out on spot. Click a card
          for the full analysis behind it.
        </p>
        <SignalList
          signals={signals}
          horizonLabel={horizon.label.toLowerCase()}
          tradesBySignal={tradesBySignal}
          evidenceBySignal={evidenceBySignal}
          timeframesBySymbol={timeframes}
        />
      </section>

      <section className="card">
        <h2>Bias meter</h2>
        <p className="hint">
          {horizon.label}-horizon verdict per tracked symbol, strongest first. Score and
          confidence come from the bias worker; a direction is only called above the confidence
          floor. Click a name for its full breakdown.
        </p>
        <BiasPanel rows={bias} />
        {horizonIndexRows(timeframes).length ? (
          <>
            <div className="hr" />
            <h3>Timeframe alignment</h3>
            <p className="hint">
              5-minute and 15-minute structure from stored quotes, for the index names. ALIGNED
              means the short and long reads agree; DIVERGED means they do not.
            </p>
            <div className="tf-grid">
              {horizonIndexRows(timeframes).map((row) => (
                <TimeframeAlignment key={row.symbol} read={row.read} symbol={row.symbol} />
              ))}
            </div>
          </>
        ) : null}
      </section>

      <Collapsible
        title="Signal lifecycle"
        hint="Where each name sits in the pipeline, and the candidates waiting at the gate"
      >
        <p className="hint">
          Each name moves through IDLE -&gt; WATCH -&gt; BUILDING -&gt; READY as evidence and
          liquidity allow. READY means there is a complete, liquid plan; the reasons column
          records why a name is where it is.
        </p>
        <SignalStages rows={stages} />
        <div className="hr" />
        <p className="hint">
          Trade candidates raised at READY. These await the non-bypassable risk gate before
          anything is published.
        </p>
        <SignalCandidates candidates={candidates} />
      </Collapsible>

      <Collapsible
        title="Risk gate"
        hint="Every check the gate ran on this horizon's candidates"
      >
        <p className="hint">
          The gate's judgements on this horizon's candidates, each with the check list behind it.
          A candidate is only published once every gate passes; a deferred row means the market
          was closed.
        </p>
        <RiskDecisions decisions={riskDecisions} />
      </Collapsible>

      <Collapsible
        title="Outcomes"
        hint="Settled positions: the exit, the level that ended them, and how far they ran"
      >
        <p className="hint">
          {horizon.label}-horizon positions that have been settled: their exit, the level that ended
          them, and how far they ran either side before closing. This is also what the risk gate
          reads to decide whether this horizon has earned the right to keep trading.
        </p>
        <Outcomes stats={outcomeStats} closed={closed} open={openPositions} />
      </Collapsible>

      {horizon.flow ? (
        <div className="grid cols-2">
          <section className="card">
            <h2>Option flow</h2>
            <p className="hint">Latest NSE OI-spurt snapshot, ranked by open-interest move.</p>
            <FlowPanel flow={flow} />
          </section>
          <Collapsible
            title="Underlying futures OI"
            hint="Open-interest change by underlying"
          >
            <p className="hint">Open-interest change by underlying.</p>
            <FlowUnderlyings rows={flow.underlyings || []} />
          </Collapsible>
        </div>
      ) : (
        <Collapsible title="Flow" hint="Open-interest change by underlying">
          <p className="hint">
            Positional decisions lean on trend and fundamentals rather than minute-level flow, so
            OI spurts are intentionally not surfaced here.
          </p>
          <FlowUnderlyings rows={(flow.underlyings || []).slice(0, 12)} />
        </Collapsible>
      )}

      <div className="grid cols-2">
        <Collapsible
          title="Flow features"
          hint="Per-symbol option-flow features from the OI-spurt snapshot"
        >
          <p className="hint">
            Per-symbol option-flow features derived from the OI-spurt snapshot - CE and PE
            open-interest change, put-call ratio and the build-up mix.
          </p>
          <FlowFeatures data={flowFeatures} limit={8} />
        </Collapsible>

        <Collapsible
          title="Entity pressure"
          hint="Scored headlines rolled up per entity over the last 48 hours"
        >
          <p className="hint">
            Scored headlines rolled up per entity over the last 48 hours.
          </p>
          <EntityIntel data={entityData} limit={8} />
        </Collapsible>
      </div>

      <Collapsible title="News" hint="Recent scored headlines affecting this horizon">
        <p className="hint">Recent scored headlines affecting this horizon.</p>
        <NewsList items={news} />
      </Collapsible>
    </div>
  );
}
