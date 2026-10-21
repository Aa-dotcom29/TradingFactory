// Compact hook from the Overview into the full Agent Arcade board. It keeps
// the summary to a glance: lane totals, one line of truth about the harness,
// and a single link. The full board lives on /dashboard/arcade.

import Link from 'next/link';
import { buildArcadeWorkers, arcadeTotals } from '@/lib/arcade';

export default function ArcadeHook({ sources = [] }) {
  const workers = buildArcadeWorkers(sources);
  const totals = arcadeTotals(workers);
  const tone = totals.down > 0 ? 'down' : totals.warn > 0 ? 'warn' : 'up';
  const headline = totals.down > 0
    ? `${totals.down} worker lane(s) failing`
    : totals.warn > 0
      ? `${totals.warn} worker lane(s) warning`
      : 'all worker lanes healthy';
  const unreported = workers.filter((w) => w.status === 'UNREPORTED').length;

  return (
    <section className="card arcade-hook" aria-label="Agent Arcade summary">
      <div className="arcade-head" style={{ marginBottom: 0 }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <h2>Agent Arcade</h2>
          <p className="hint" style={{ margin: '5px 0 0' }}>
            The whole harness on one board: all 10 workers, their run order, and one
            continuous wave that shows the system is alive. {headline}
            {unreported > 0 ? ` - ${unreported} lane(s) have not reported yet.` : '.'}
          </p>
        </div>
        <div className="arcade-totals">
          <span className={`pill ${tone}`}>{totals.up}/{workers.length} up</span>
          <Link className="arcade-link" href="/dashboard/arcade">Open board &rarr;</Link>
        </div>
      </div>
    </section>
  );
}
