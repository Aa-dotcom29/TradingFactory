import { notFound } from 'next/navigation';
import {
  getSignals, getFlow, getNews, getEntityFeatures, getFlowFeatures, getBias,
  getSignalStages, getSignalCandidates, getRiskDecisions, getHorizonPulse,
  getOutcomes, getOutcomeStats, getOpenPositions,
} from '@/lib/queries';
import { horizonByKey } from '@/lib/horizons';
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

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }) {
  const { horizon } = await params;
  const meta = horizonByKey(horizon);
  return { title: meta ? `${meta.label} - Trading Factory` : 'Trading Factory' };
}

export default async function HorizonPage({ params }) {
  const { horizon: raw } = await params;
  const horizon = horizonByKey(raw);
  if (!horizon) notFound();

  const [signals, flow, news, entityData, flowFeatures, bias, stages, candidates, riskDecisions, pulse, closed, outcomeStats, openPositions] = await Promise.all([
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
  ]);

  const live = String(process.env.PUBLISH_MODE || 'shadow').toLowerCase() === 'live';

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
        headline={pulse.ready > 0 ? `${pulse.ready} ready for the gate` : 'No names ready yet'}
        facts={[
          { k: 'tracked', v: pulse.tracked },
          { k: 'bullish', v: pulse.bullish },
          { k: 'building', v: pulse.building },
          { k: 'queued', v: pulse.queued },
          { k: 'open', v: pulse.openPositions },
          { k: 'closed 24h', v: pulse.closed24h },
          { k: 'approved 24h', v: pulse.approved24h },
          { k: 'delivered 24h', v: pulse.published24h },
        ]}
        note={
          `${horizon.label} candidates are raised at READY and must clear every gate before anything is published. ` +
          (live
            ? 'Delivery is live; approved signals go to the household channel and execution is manual.'
            : 'Delivery is in shadow, so nothing is being sent yet - the ledger is still written in full.')
        }
      />

      <section className="card">
        <h2>Bias meter</h2>
        <p className="hint">
          {horizon.label}-horizon verdict per tracked symbol, strongest first. Score and
          confidence come from the bias worker; a direction is only called above the confidence
          floor.
        </p>
        <BiasPanel rows={bias} />
      </section>

      <section className="card">
        <h2>Signal lifecycle</h2>
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
      </section>

      <section className="card">
        <h2>Published signals</h2>
        <p className="hint">Risk-gated, versioned signals delivered to the household.</p>
        <SignalList signals={signals} horizonLabel={horizon.label.toLowerCase()} />
      </section>

      <section className="card">
        <h2>Risk gate</h2>
        <p className="hint">
          The gate's judgements on this horizon's candidates, each with the check list behind it.
          A candidate is only published once every gate passes; a deferred row means the market
          was closed.
        </p>
        <RiskDecisions decisions={riskDecisions} />
      </section>

      <section className="card">
        <h2>Outcomes</h2>
        <p className="hint">
          {horizon.label}-horizon positions that have been settled: their exit, the level that ended
          them, and how far they ran either side before closing. This is also what the risk gate
          reads to decide whether this horizon has earned the right to keep trading.
        </p>
        <Outcomes stats={outcomeStats} closed={closed} open={openPositions} />
      </section>

      {horizon.flow ? (
        <div className="grid cols-2">
          <section className="card">
            <h2>Option flow</h2>
            <p className="hint">Latest NSE OI-spurt snapshot, ranked by open-interest move.</p>
            <FlowPanel flow={flow} />
          </section>
          <section className="card">
            <h2>Underlying futures OI</h2>
            <p className="hint">Open-interest change by underlying.</p>
            <FlowUnderlyings rows={flow.underlyings || []} />
          </section>
        </div>
      ) : (
        <section className="card">
          <h2>Flow</h2>
          <p className="hint">
            Positional decisions lean on trend and fundamentals rather than minute-level flow, so
            OI spurts are intentionally not surfaced here.
          </p>
          <FlowUnderlyings rows={(flow.underlyings || []).slice(0, 12)} />
        </section>
      )}

      <div className="grid cols-2">
        <section className="card">
          <h2>Flow features</h2>
          <p className="hint">
            Per-symbol option-flow features derived from the OI-spurt snapshot - CE and PE
            open-interest change, put-call ratio and the build-up mix.
          </p>
          <FlowFeatures data={flowFeatures} limit={8} />
        </section>

        <section className="card">
          <h2>Entity pressure</h2>
          <p className="hint">
            Scored headlines rolled up per entity over the last 48 hours.
          </p>
          <EntityIntel data={entityData} limit={8} />
        </section>
      </div>

      <section className="card">
        <h2>News</h2>
        <p className="hint">Recent scored headlines affecting this horizon.</p>
        <NewsList items={news} />
      </section>
    </div>
  );
}
