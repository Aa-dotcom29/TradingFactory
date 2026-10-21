import { getHealth } from '@/lib/queries';
import ArcadeFlow from '@/components/ArcadeFlow';
import LiveRefresh from '@/components/LiveRefresh';
import StatusBanner from '@/components/StatusBanner';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Agent Arcade - Trading Factory' };

// The one page whose whole job is to make the harness legible. The pipeline
// chain, the support lanes and one continuous animation that proves the system
// is running - nothing here is a metric dump, so it stays cheap to load.
export default async function ArcadePage() {
  const { configured, sources, error } = await getHealth();

  return (
    <div className="stack">
      <div className="page-head">
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1>Agent Arcade</h1>
          <p className="muted small" style={{ margin: '5px 0 0' }}>
            One glance at the whole lifecycle - what runs, in what order, and
            whether each lane is actually alive.
            <span style={{ marginLeft: 12 }}><LiveRefresh seconds={10} /></span>
          </p>
        </div>
      </div>

      {!configured ? (
        <StatusBanner
          tone="down"
          headline="Database not configured"
          facts={[{ k: 'reason', v: error || 'no DATABASE_URL' }]}
          note="Add DATABASE_URL to web/.env and restart. Worker statuses come from sources_health, which cannot be read without it."
        />
      ) : (
        <ArcadeFlow sources={sources} />
      )}
    </div>
  );
}
