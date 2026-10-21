// Agent Arcade - the whole harness on one board.
//
// A glance should answer two questions at once: where is the pipeline heading,
// and is every lane alive? The board answers the first with a left-to-right
// chain of worker nodes; the second with a continuous CSS-only wave that beats
// through the nodes in board order. The wave carries each node's status colour
// - so a failing worker pulses red and silence reads as exactly that. No data
// is invented here: status text comes from `sources_health` rows the workers
// themselves wrote, and an unreported worker is labelled as such.

import { buildArcadeWorkers, LANES, arcadeTotals } from '@/lib/arcade';
import { timeAgo } from '@/lib/format';

function Node({ worker, index }) {
  return (
    <div className={`node lane-${worker.tone}`} style={{ '--i': index }}>
      <span className="beat" aria-hidden="true" />
      <div className="id">{worker.id}</div>
      <div className="name">{worker.name}</div>
      <div className="blurb small muted">{worker.blurb}</div>
      <div className="meta">
        <span className={`pill ${worker.tone}`}>{worker.status}</span>
      </div>
      <div className="detail small muted" title={worker.detail}>{worker.detail}</div>
    </div>
  );
}

function Lane({ lane, workers, startIndex }) {
  const nodes = lane.workers
    .map((id) => workers.find((w) => w.id === id))
    .filter(Boolean);
  return (
    <div className={`arcade-lane lane-${lane.key}`}>
      <div className="lane-label small muted">
        {lane.label}
        <span className="arrow-hint">flows left to right</span>
      </div>
      <div className="arcade-strip">
        {nodes.map((worker, i) => (
          <Node key={worker.id} worker={worker} index={startIndex + i} />
        ))}
      </div>
    </div>
  );
}

export default function ArcadeFlow({ sources = [] }) {
  const workers = buildArcadeWorkers(sources);
  const totals = arcadeTotals(workers);
  const waves = workers.length;

  return (
    <section className="card arcade" aria-label="Agent Arcade">
      <div className="arcade-head">
        <div>
          <h2>Agent Arcade</h2>
          <p className="hint">
            Every harness worker on one board. The wave beats through the chain
            in run order - Worker 0 through Worker {waves - 1} - and carries each
            lane&apos;s real status colour. Unreported stages are labelled, never
            invented.
          </p>
        </div>
        <div className="arcade-totals">
          <span className="pill up">{totals.up} healthy</span>
          {totals.warn ? <span className="pill warn">{totals.warn} warning</span> : null}
          {totals.down ? <span className="pill down">{totals.down} failing</span> : null}
          {totals.muted ? <span className="pill muted">{totals.muted} quiet</span> : null}
        </div>
      </div>

      <div className="arcade-board">
        {(() => {
          let index = 0;
          return LANES.map((lane) => {
            const node = <Lane key={lane.key} lane={lane} workers={workers} startIndex={index} />;
            index += lane.workers.length;
            return node;
          });
        })()}
      </div>

      <div className="arcade-report table-scroll">
        <table>
          <thead>
            <tr>
              <th>Worker</th>
              <th>Status</th>
              <th>Detail</th>
              <th>Checked</th>
              <th>Sources watched</th>
            </tr>
          </thead>
          <tbody>
            {workers.map((w) => (
              <tr key={w.id}>
                <td><strong>{w.id} {w.name}</strong></td>
                <td><span className={`pill ${w.tone}`}>{w.status}</span></td>
                <td className="small muted">{w.detail}</td>
                <td className="small muted">{w.checkedAt ? timeAgo(w.checkedAt) : '-'}</td>
                <td className="small muted">{w.sources.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
