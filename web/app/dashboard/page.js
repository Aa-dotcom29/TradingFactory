import { getHealth, getNews, getFlow } from '@/lib/queries';
import NewsList from '@/components/NewsList';
import FlowPanel, { FlowUnderlyings } from '@/components/FlowPanel';
import HealthTable from '@/components/HealthTable';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Overview - Trading Factory' };

export default async function OverviewPage() {
  const [health, news, flow] = await Promise.all([getHealth(), getNews(12), getFlow(10)]);
  const counts = health.counts || {};

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
          <div className="k">Signals</div>
          <div className="v mono">{counts.signals_total ?? 0}</div>
        </div>
      </div>

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
