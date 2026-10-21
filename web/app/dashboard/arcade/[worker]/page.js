import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getHealth } from '@/lib/queries';
import { buildArcadeWorkers, GLYPHS } from '@/lib/arcade';
import {
  WORKER_ORDER, workerDocBySlug, adjacentWorkers,
} from '@/lib/workerDocs';
import LiveRefresh from '@/components/LiveRefresh';
import StatusBanner from '@/components/StatusBanner';
import { timeAgo } from '@/lib/format';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }) {
  const { worker } = await params;
  const doc = workerDocBySlug(worker);
  return { title: doc ? `${doc.id} ${doc.name} - Trading Factory` : 'Worker - Trading Factory' };
}

// One dossier per worker: what it does end to end, where its data enters the
// system, what shape that data has, and who downstream consumes it. Every
// claim is traced to the worker's own source file (linked above the fold), so
// this page documents the machine as built, not as wished for.
export default async function WorkerPage({ params }) {
  const { worker } = await params;
  const doc = workerDocBySlug(worker);
  if (!doc) notFound();

  const { sources } = await getHealth();
  // Same status model as the board, so the dossier cannot disagree with it.
  const live = buildArcadeWorkers(sources).find((w) => w.id === doc.id);
  const glyph = GLYPHS[doc.id] || [];
  const { prev, next } = adjacentWorkers(doc.id);
  const index = WORKER_ORDER.indexOf(doc.id);

  return (
    <div className="stack">
      <div className="page-head">
        <div style={{ flex: 1, minWidth: 260 }}>
          <p className="muted small" style={{ margin: '0 0 6px' }}>
            <Link href="/dashboard/arcade">&larr; back to Agent Arcade</Link>
            <span style={{ marginLeft: 12 }}><LiveRefresh seconds={10} /></span>
          </p>
          <h1>
            <span className="pill accent">{doc.id}</span> {doc.name}
            {live ? (
              <>
                {' '}
                <span className={`pill ${live.tone}`}>{live.status}</span>
              </>
            ) : (
              <>
                {' '}
                <span className="pill muted">UNREPORTED</span>
              </>
            )}
          </h1>
          <p className="muted small" style={{ margin: '6px 0 0' }}>
            {doc.lane} &middot; step {index + 1} of {WORKER_ORDER.length} &middot;{' '}
            <code>{doc.file}</code>
          </p>
          {live ? (
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              health source {live.sources.join(', ')} &middot; heartbeat{' '}
              <strong>{live.liveness.toUpperCase()}</strong>
              {live.checkedAt ? <> &middot; last reported {timeAgo(live.checkedAt)}</> : null}
            </p>
          ) : null}
        </div>
        <div className={`arc-node tone-${live ? live.tone : 'muted'}`} style={{ alignSelf: 'flex-start' }}>
          <svg width="72" height="72" viewBox="0 0 72 72" aria-hidden="true" style={{ display: 'block' }}>
            <rect x="1" y="1" width="70" height="70" rx="12" fill="var(--hull)" stroke="var(--rule-hi)" />
            <g className="a-glyph" transform="translate(24 24) scale(1)">
              {glyph.map((d, i) => <path key={i} d={d} />)}
            </g>
          </svg>
        </div>
      </div>

      {live && (live.liveness === 'stale' || live.liveness === 'silent') ? (
        <StatusBanner
          tone={live.liveness === 'silent' ? 'down' : 'warn'}
          headline={live.liveness === 'silent' ? 'This worker is silent' : 'This worker has missed heartbeats'}
          facts={[
            { k: 'last status', v: live.status },
            { k: 'last report', v: live.checkedAt ? timeAgo(live.checkedAt) : '-' },
          ]}
          note={live.detail}
        />
      ) : null}

      <section className="card">
        <h2>Schedule</h2>
        <p className="small" style={{ margin: '4px 0 0' }}>{doc.cadence}</p>
      </section>

      <section className="card">
        <h2>What it does, end to end</h2>
        {doc.does.map((para, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <p key={i} style={{ margin: i ? '10px 0 0' : '6px 0 0' }}>{para}</p>
        ))}
      </section>

      <section className="card">
        <h2>Where its data comes from</h2>

        <h3 className="small caps" style={{ marginTop: 12 }}>External sources</h3>
        {doc.consumes.external.length ? (
          <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {doc.consumes.external.map((s) => (
              <li key={s.name} style={{ marginBottom: 6 }}>
                <strong>{s.name}</strong> - {s.detail}
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted" style={{ margin: '6px 0 0' }}>
            None - this worker touches no network and reads only what earlier workers stored.
          </p>
        )}

        <h3 className="small caps" style={{ marginTop: 14 }}>Queue topics it consumes</h3>
        {doc.consumes.queue.length ? (
          <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {doc.consumes.queue.map((q) => (
              <li key={q.topic} style={{ marginBottom: 6 }}>
                <code>{q.topic}</code> from {q.from} - {q.what}
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted" style={{ margin: '6px 0 0' }}>
            None - this worker is not queue-triggered.
          </p>
        )}

        <h3 className="small caps" style={{ marginTop: 14 }}>Tables it reads</h3>
        {doc.consumes.tables.length ? (
          <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {doc.consumes.tables.map((t) => <li key={t}>{t}</li>)}
          </ul>
        ) : (
          <p className="small muted" style={{ margin: '6px 0 0' }}>None.</p>
        )}
      </section>

      <section className="card">
        <h2>What it writes</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Table</th>
                <th>Shape / what a row means</th>
              </tr>
            </thead>
            <tbody>
              {doc.produces.map((p) => (
                <tr key={p.table}>
                  <td><code>{p.table}</code></td>
                  <td className="small">{p.shape}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 className="small caps" style={{ marginTop: 14 }}>Queue topics it emits</h3>
        {doc.emits.length ? (
          <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {doc.emits.map((e) => (
              <li key={e.topic} style={{ marginBottom: 6 }}>
                <code>{e.topic}</code> to {e.to} - {e.what}
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted" style={{ margin: '6px 0 0' }}>
            None - this worker&apos;s output is read straight from its tables.
          </p>
        )}
      </section>

      <section className="card">
        <h2>Who consumes this data</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Consumer</th>
                <th>How</th>
                <th>What for</th>
              </tr>
            </thead>
            <tbody>
              {doc.consumers.map((c) => (
                <tr key={`${c.who}-${c.via}`}>
                  <td><strong>{c.who}</strong></td>
                  <td className="small"><code>{c.via}</code></td>
                  <td className="small muted">{c.what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>What it deliberately does not do</h2>
        <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {doc.limits.map((l) => (
            // eslint-disable-next-line react/no-array-index-key
            <li key={l} style={{ marginBottom: 6 }}>{l}</li>
          ))}
        </ul>
      </section>

      <nav className="card" style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        {prev ? (
          <Link className="small" href={`/dashboard/arcade/${prev.slug}`}>
            &larr; {prev.id} {prev.name}
          </Link>
        ) : (
          <span className="small muted">start of the chain</span>
        )}
        {next ? (
          <Link className="small" href={`/dashboard/arcade/${next.slug}`}>
            {next.id} {next.name} &rarr;
          </Link>
        ) : (
          <span className="small muted">end of the chain</span>
        )}
      </nav>

      <p className="muted small">
        Every fact on this page is drawn from the worker&apos;s own source file and the
        shared queue topics - <code>{doc.file}</code>.
      </p>
    </div>
  );
}
