import { notFound } from 'next/navigation';
import { getSignals, getFlow, getNews, getEntityFeatures, getFlowFeatures, getBias } from '@/lib/queries';
import { horizonByKey } from '@/lib/horizons';
import SignalList from '@/components/SignalList';
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

  const [signals, flow, news, entityData, flowFeatures, bias] = await Promise.all([
    getSignals(horizon.key),
    getFlow(horizon.key === 'POSITIONAL' ? 12 : 20),
    getNews(20),
    getEntityFeatures(8),
    getFlowFeatures(10),
    getBias(horizon.key, 12),
  ]);

  return (
    <div className="stack">
      <div className="card" style={{ background: 'var(--panel-2)' }}>
        <div className="row-between">
          <div>
            <h1 style={{ margin: 0, fontSize: 20 }}>{horizon.label}</h1>
            <p className="muted small" style={{ margin: '2px 0 0' }}>
              {horizon.blurb} - cadence {horizon.cadence}
            </p>
          </div>
          <span className="pill accent">{horizon.key}</span>
        </div>
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          Risk profile: {horizon.risk}. Manual execution only.
        </p>
      </div>

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
        <h2>Signals</h2>
        <p className="hint">Risk-gated, versioned signals for this horizon.</p>
        <SignalList signals={signals} horizonLabel={horizon.label.toLowerCase()} />
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
