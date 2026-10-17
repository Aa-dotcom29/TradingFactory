import { getHealth, getNews, getFlow, getEntityFeatures, getFlowFeatures, getBiasOverview, getSignalStageOverview, getSignalCandidates, getRiskDecisions } from '@/lib/queries';
import NewsList from '@/components/NewsList';
import FlowPanel, { FlowUnderlyings } from '@/components/FlowPanel';
import EntityIntel from '@/components/EntityIntel';
import FlowFeatures from '@/components/FlowFeatures';
import BiasPanel from '@/components/BiasPanel';
import SignalStages from '@/components/SignalStages';
import SignalCandidates from '@/components/SignalCandidates';
import RiskDecisions from '@/components/RiskDecisions';
import HealthTable from '@/components/HealthTable';
import PipelineStrip from '@/components/PipelineStrip';
import ConsensusMeter from '@/components/ConsensusMeter';
import StatusBanner from '@/components/StatusBanner';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Overview - Trading Factory' };

export default async function OverviewPage() {
  const [health, news, flow, entityData, flowFeatures, bias, lifecycle, candidates, riskDecisions] = await Promise.all([
    getHealth(),
    getNews(12),
    getFlow(10),
    getEntityFeatures(8),
    getFlowFeatures(10),
    getBiasOverview(6),
    getSignalStageOverview(6),
    getSignalCandidates(null, 4),
    getRiskDecisions(null, 6),
  ]);

  const counts = health.counts || {};
  const biasCounts = bias.counts || {};
  const stageCounts = lifecycle.counts || {};
  const mode = process.env.PUBLISH_MODE || 'shadow';

  const biasTotal = (biasCounts.BULLISH || 0) + (biasCounts.BEARISH || 0) + (biasCounts.NEUTRAL || 0);
  const sources = health.sources || [];
  const healthy = sources.filter((s) => s.status === 'HEALTHY').length;
  const live = String(mode).toLowerCase() === 'live';

  // The chain, stage by stage, with the real number of rows each worker handed on.
  const pipeline = [
    { id: 'W0', name: 'Ingest', value: healthy, unit: `of ${sources.length} feeds`, note: 'NSE / RSS / quotes' },
    { id: 'W1', name: 'News', value: counts.news_24h ?? 0, unit: '24h', note: `${counts.news_total ?? 0} scored all time` },
    { id: 'W2', name: 'Flow', value: counts.flow_24h ?? 0, unit: '24h', note: 'OI-spurt rows' },
    { id: 'W3', name: 'Bias', value: biasTotal, unit: 'pairs', note: `${biasCounts.BULLISH || 0} bullish` },
    { id: 'W4', name: 'Signal', value: counts.candidates_pending ?? 0, unit: 'queued', note: `${stageCounts.READY || 0} ready` },
    { id: 'W5', name: 'Risk', value: counts.risk_approved_24h ?? 0, unit: 'approved', note: `${counts.risk_rejected_24h ?? 0} rejected 24h` },
    {
      id: 'W6',
      name: 'Publish',
      value: counts.signals_shadow_24h ?? 0,
      unit: '24h',
      note: String(mode).toLowerCase() === 'live' ? 'delivered to Telegram' : 'shadow only, nothing sent',
      terminal: true,
    },
  ];

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
          ]}
          note={
            live
              ? 'Approved signals are being delivered to the household channel. Execution stays manual: this engine never places an order.'
              : 'Signals are scored, risk-gated and written to the ledger, but nothing is sent. Flip PUBLISH_MODE per horizon when you are ready to go live.'
          }
        />
      )}

      <PipelineStrip nodes={pipeline} />

      <section className="card">
        <h2>House read</h2>
        <p className="hint">
          How the tracked universe is leaning right now, across all three horizons. Undecided is
          counted, not hidden: a name only gets a direction once its evidence clears the floor.
        </p>
        <ConsensusMeter counts={biasCounts} />
      </section>

      <div className="stat-row">
        <div className="stat">
          <div className="k">News (24h)</div>
          <div className="v">{counts.news_24h ?? '-'}</div>
        </div>
        <div className="stat">
          <div className="k">Flow rows (24h)</div>
          <div className="v">{counts.flow_24h ?? '-'}</div>
        </div>
        <div className="stat">
          <div className="k">Stages ready</div>
          <div className="v">{counts.stages_ready ?? 0}</div>
        </div>
        <div className="stat">
          <div className="k">Candidates queued</div>
          <div className="v">{counts.candidates_pending ?? 0}</div>
        </div>
        <div className="stat">
          <div className="k">Approved (24h)</div>
          <div className="v tone-up">{counts.risk_approved_24h ?? 0}</div>
        </div>
        <div className="stat">
          <div className="k">Rejected (24h)</div>
          <div className="v tone-down">{counts.risk_rejected_24h ?? 0}</div>
        </div>
        <div className="stat">
          <div className="k">Signals (24h)</div>
          <div className="v">{counts.signals_shadow_24h ?? 0}</div>
        </div>
        <div className="stat">
          <div className="k">Feeds healthy</div>
          <div className="v">{healthy}<span className="u">of {sources.length}</span></div>
        </div>
      </div>

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
    </div>
  );
}
