import { getHealth, getNews, getFlow, getEntityFeatures, getFlowFeatures, getBiasOverview, getSignalStageOverview, getSignalCandidates } from '@/lib/queries';
import NewsList from '@/components/NewsList';
import FlowPanel, { FlowUnderlyings } from '@/components/FlowPanel';
import EntityIntel from '@/components/EntityIntel';
import FlowFeatures from '@/components/FlowFeatures';
import BiasPanel from '@/components/BiasPanel';
import SignalStages from '@/components/SignalStages';
import SignalCandidates from '@/components/SignalCandidates';
import HealthTable from '@/components/HealthTable';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Overview - Trading Factory' };

export default async function OverviewPage() {
  const [health, news, flow, entityData, flowFeatures, bias, lifecycle, candidates] = await Promise.all([
    getHealth(),
    getNews(12),
    getFlow(10),
    getEntityFeatures(8),
    getFlowFeatures(10),
    getBiasOverview(6),
    getSignalStageOverview(6),
    getSignalCandidates(null, 4),
  ]);
  const counts = health.counts || {};
  const biasCounts = bias.counts || {};
  const stageCounts = lifecycle.counts || {};

  return (
    <div className="stack">
      <div>
        <h1 style={{ margin: '6px 0 2px', fontSize: 22 }}>Market overview</h1>
        <p className="muted small" style={{ margin: 0 }}>
          Live aggregates from the harness database. Execution is always manual - this is decision support only.
        </p>
      </div>

      {health.error ? <div className="banner error">Database read failed: {health.error}</div> : null}

      <div className="stat-row">
        <div className="stat">
          <div className="k">News (24h)</div>
          <div className="v mono">{counts.news_24h ?? '-'}</div>
        </div>
        <div className="stat">
          <div className="k">News total</div>
          <div className="v mono">{counts.news_total ?? '-'}</div>
        </div>
        <div className="stat">
          <div className="k">Flow rows (24h)</div>
          <div className="v mono">{counts.flow_24h ?? '-'}</div>
        </div>
        <div className="stat">
          <div className="k">READY stages</div>
          <div className="v mono">{counts.stages_ready ?? 0}</div>
        </div>
        <div className="stat">
          <div className="k">Entities tracked</div>
          <div className="v mono">{(entityData.entities || []).length || '-'}</div>
        </div>
        <div className="stat">
          <div className="k">Bias</div>
          <div className="v mono">
            <span className="tone-up">{biasCounts.BULLISH || 0}</span>
            {' / '}
            <span className="tone-down">{biasCounts.BEARISH || 0}</span>
          </div>
        </div>
        <div className="stat">
          <div className="k">Candidates pending</div>
          <div className="v mono">{counts.candidates_pending ?? 0}</div>
        </div>
      </div>

      <section className="card">
        <h2>Bias meter</h2>
        <p className="hint">
          Current verdict per symbol and horizon, strongest first. A direction is only called
          once the evidence clears the confidence floor.
        </p>
        <BiasPanel rows={bias.rows} showHorizon />
      </section>

      <section className="card">
        <h2>Signal lifecycle</h2>
        <p className="hint">
          Where each name sits in its trade lifecycle (READY {stageCounts.READY || 0} /
          BUILDING {stageCounts.BUILDING || 0} / WATCH {stageCounts.WATCH || 0}). A candidate is
          raised only at READY; it still has to pass the risk gate before it is published.
        </p>
        <SignalStages rows={lifecycle.rows} showHorizon />
        <div className="hr" />
        <p className="hint">Most recent trade candidates awaiting the risk gate.</p>
        <SignalCandidates candidates={candidates} showHorizon />
      </section>

      <div className="grid cols-2">
        <section className="card">
          <h2>Option flow</h2>
          <p className="hint">NSE OI spurts - where open interest moved most in the latest snapshot.</p>
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
          <p className="hint">
            Per-symbol option-flow features derived from the OI-spurt snapshot.
          </p>
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
        <p className="hint">Reported by the supervisor worker each cycle.</p>
        <HealthTable sources={health.sources} />
      </section>
    </div>
  );
}
