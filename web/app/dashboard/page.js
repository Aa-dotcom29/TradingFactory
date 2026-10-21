import { getHealth, getNews, getFlow, getEntityFeatures, getFlowFeatures, getBiasOverview, getSignalStageOverview, getSignalCandidates, getRiskDecisions, getOutcomes, getOutcomeStats, getOpenPositions, getProposals } from '@/lib/queries';
import NewsList from '@/components/NewsList';
import FlowPanel, { FlowUnderlyings } from '@/components/FlowPanel';
import EntityIntel from '@/components/EntityIntel';
import FlowFeatures from '@/components/FlowFeatures';
import BiasPanel from '@/components/BiasPanel';
import SignalStages from '@/components/SignalStages';
import SignalCandidates from '@/components/SignalCandidates';
import RiskDecisions from '@/components/RiskDecisions';
import Outcomes from '@/components/Outcomes';
import Proposals from '@/components/Proposals';
import HealthTable from '@/components/HealthTable';
import ConsensusMeter from '@/components/ConsensusMeter';
import StatusBanner from '@/components/StatusBanner';
import ArcadeHook from '@/components/ArcadeHook';
import { publishSummary } from '@/lib/publish';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Overview - Trading Factory' };

export default async function OverviewPage() {
  const [
    health, news, flow, entityData, flowFeatures, bias, lifecycle, candidates, riskDecisions,
    closed, outcomeStats, openPositions, proposals,
  ] = await Promise.all([
    getHealth(),
    getNews(12),
    getFlow(10),
    getEntityFeatures(8),
    getFlowFeatures(10),
    getBiasOverview(6),
    getSignalStageOverview(6),
    getSignalCandidates(null, 4),
    getRiskDecisions(null, 6),
    getOutcomes(null, 8),
    getOutcomeStats(null),
    getOpenPositions(null, 6),
    getProposals(5),
  ]);

  const counts = health.counts || {};
  const biasCounts = bias.counts || {};
  const stageCounts = lifecycle.counts || {};
  const mode = publishSummary();
  const mixed = mode === 'mixed';

  const biasTotal = (biasCounts.BULLISH || 0) + (biasCounts.BEARISH || 0) + (biasCounts.NEUTRAL || 0);
  const sources = health.sources || [];
  const live = String(mode).toLowerCase() === 'live';

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Market overview</h1>
          <p className="muted small hint" style={{ margin: 0 }}>
            Every number below is read back from the harness database. Execution is always manual:
            this is decision support, not an order book.
          </p>
        </div>
      </div>

      {health.error ? (
        <div className="banner error">Database read failed: {health.error}</div>
      ) : (
        <StatusBanner
          tone={live ? 'up' : 'warn'}
          headline={live ? 'Live delivery' : 'Shadow mode'}
          facts={[
            { k: 'tracked', v: biasTotal },
            { k: 'bullish', v: biasCounts.BULLISH || 0 },
            { k: 'ready', v: counts.stages_ready ?? 0 },
            { k: 'approved 24h', v: counts.risk_approved_24h ?? 0 },
            { k: 'delivered 24h', v: counts.signals_24h ?? 0 },
            { k: 'open', v: counts.positions_open ?? 0 },
            { k: 'closed 24h', v: counts.outcomes_24h ?? 0 },
          ]}
          note={
            live
              ? 'Approved signals are being delivered to the household channel. Execution stays manual: this engine never places an order.'
              : mixed
                ? 'Some horizons are delivering to the household channel; the rest only write the ledger in shadow. Execution stays manual.'
                : 'Signals are scored, risk-gated and written to the ledger, but nothing is sent. Flip PUBLISH_MODE per horizon when you are ready to go live.'
          }
        />
      )}

      <section className="card">
        <h2>House read</h2>
        <p className="hint">
          How the tracked universe is leaning right now, across all three horizons. Undecided is
          counted, not hidden: a name only gets a direction once its evidence clears the floor.
        </p>
        <ConsensusMeter counts={biasCounts} />
      </section>

      <section className="card">
        <h2>Bias meter</h2>
        <p className="hint">
          Current verdict per symbol and horizon, strongest first. The score is bounded to
          -1 to 1 and the confidence says how much evidence actually stood behind it.
        </p>
        <BiasPanel rows={bias.rows} showHorizon />
      </section>

      <section className="card">
        <h2>Signal lifecycle</h2>
        <p className="hint">
          Where each name sits in its trade lifecycle (READY {stageCounts.READY || 0} /
          BUILDING {stageCounts.BUILDING || 0} / WATCH {stageCounts.WATCH || 0}). A candidate is
          raised only at READY, and it still has to pass the risk gate before anything is published.
        </p>
        <SignalStages rows={lifecycle.rows} showHorizon />
        <div className="hr" />
        <p className="hint">Most recent trade candidates awaiting the risk gate.</p>
        <SignalCandidates candidates={candidates} showHorizon />
      </section>

      <section className="card">
        <h2>Risk gate</h2>
        <p className="hint">
          Every judgement the gate has made on a trade candidate, with the check list behind it.
          Nothing is published unless every gate passes; a deferred row means the market was
          closed, not that anything failed.
        </p>
        <RiskDecisions decisions={riskDecisions} showHorizon />
      </section>

      <section className="card">
        <h2>Outcomes</h2>
        <p className="hint">
          What actually happened. A published signal becomes an outcome when it reaches its target,
          hits its stop, or its horizon&apos;s holding window runs out. This is the record the risk
          gate reads before it approves anything else, so an empty ledger means the loss controls
          are running blind &mdash; not that the system is clean.
        </p>
        <Outcomes stats={outcomeStats} closed={closed} open={openPositions} showHorizon />
      </section>

      <section className="card">
        <h2>Proposed config changes</h2>
        <p className="hint">
          The evaluator may propose a change to its own limits; it can never apply one. A proposal
          is a <code>candidate</code> config row, and every worker resolves the latest
          <em> approved</em> version, so nothing here is live. It waits for a person.
        </p>
        <Proposals proposals={proposals} />
      </section>

      <div className="grid cols-2">
        <section className="card">
          <h2>Option flow</h2>
          <p className="hint">NSE OI spurts: where open interest moved most in the latest snapshot.</p>
          <FlowPanel flow={flow} />
          <div className="hr" />
          <p className="hint">Underlying futures OI change.</p>
          <FlowUnderlyings rows={(flow.underlyings || []).slice(0, 8)} />
        </section>

        <section className="card">
          <h2>Entity pressure</h2>
          <p className="hint">
            Scored headlines rolled up per entity. A cluster of coverage reads as one number.
          </p>
          <EntityIntel data={entityData} limit={8} />
        </section>
      </div>

      <div className="grid cols-2">
        <section className="card">
          <h2>Flow features</h2>
          <p className="hint">Per-symbol option-flow features derived from the OI-spurt snapshot.</p>
          <FlowFeatures data={flowFeatures} limit={8} />
        </section>

        <section className="card">
          <h2>Latest intelligence</h2>
          <p className="hint">Most recent scored headlines across all tracked entities.</p>
          <NewsList items={news} />
        </section>
      </div>

      <section className="card">
        <h2>Source health</h2>
        <p className="hint">Reported by the supervisor worker each cycle. A disabled source says so rather than failing silently.</p>
        <HealthTable sources={health.sources} />
      </section>

      {/* The workspace hook sits at the foot of the page: it is the way into
          the full board, and the board itself is a separate destination, so it
          does not belong above the market read. */}
      <ArcadeHook sources={sources} />
    </div>
  );
}
