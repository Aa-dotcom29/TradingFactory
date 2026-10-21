// Agent Arcade - the whole harness drawn as one animated circuit board.
//
// The glance test this panel has to pass: "is the machine alive, and where is
// it stuck?" So the board is a real drawing, not a table of pills:
//
//   * Ten worker modules, each with its own line-art glyph, an ID chip, the
//     worker's name, its status word, and a status LED with a pulsing ring.
//   * Rails between the modules follow the actual run order W0 -> W7, wrapping
//     to the second row, plus the two support lanes: W9 tape feeds prints into
//     W7 evaluation, W7 hands health to W8 supervisor.
//   * Every rail carries marching dashes and a traveling packet, staggered down
//     the chain, so data visibly flows left to right forever.
//   * An ECG-style system pulse runs across the top in the board's worst tone.
//
// Every animation is CSS-only (rails, packets, rings, ECG) and is switched off
// under prefers-reduced-motion. Status comes from `sources_health` via
// buildArcadeWorkers; a worker that has not reported is labelled UNREPORTED,
// never coloured healthy. CurrentColor carries the tone: the same .tone-* classes
// that style the text pills drive the glyphs, LEDs and rails.

import {
  buildArcadeWorkers, arcadeTotals, BOARD, BOARD_W, BOARD_H, NODE_W, NODE_H, GLYPHS,
} from '@/lib/arcade';
import { timeAgo } from '@/lib/format';

// Rails follow the real run order. The wrap rail is the chain continuing on
// the second row; the last two are the support lanes.
const RAILS = [
  { d: 'M190 100 H230' },
  { d: 'M390 100 H430' },
  { d: 'M590 100 H630' },
  { d: 'M790 100 H812 Q820 100 820 108 V162 Q820 170 812 170 H16 Q8 170 8 178 V232 Q8 240 16 240 H30' },
  { d: 'M190 240 H230' },
  { d: 'M390 240 H430' },
  { d: 'M590 240 H630' },
  { d: 'M310 336 C310 300 710 312 710 284', label: 'prints + depth', labelAt: [505, 294] }, // W9 -> W7
  { d: 'M790 240 V380', label: 'health', labelAt: [784, 318], anchor: 'end' }, // W7 -> W8
];

// An ECG trace: flat line with a heartbeat spike every `period` px.
function heartbeatPath(fromX, toX, baseline, period) {
  let d = `M${fromX} ${baseline}`;
  for (let x = fromX + period; x < toX; x += period) {
    d += ` H${x - 14} l5 -10 l5 20 l5 -10`;
  }
  return `${d} H${toX}`;
}
const ECG_D = heartbeatPath(110, 810, 20, 70);

function Module({ worker, index }) {
  const { x, y } = BOARD[worker.id];
  const glyph = GLYPHS[worker.id] || [];
  const href = `/dashboard/arcade/${worker.id.toLowerCase()}`;
  return (
    <g className={`arc-node tone-${worker.tone}`}>
      {/* A real SVG anchor: clicking a module opens that worker's full
          end-to-end dossier (what it does, sources, consumers). */}
      <a href={href} aria-label={`${worker.id} ${worker.name} - open worker dossier`}>
        <g transform={`translate(${x} ${y})`}>
          <rect className="a-card" width={NODE_W} height={NODE_H} rx="10" />
          <rect className="a-accent" width="3" height={NODE_H} rx="1.5" />
          <text className="a-id" x="14" y="19">{worker.id}</text>
          <circle className="a-led" cx="146" cy="16" r="3.5" />
          <circle className="a-ring" cx="146" cy="16" r="3.5" style={{ animationDelay: `${index * 0.18}s` }} />
          <g className="a-glyph" transform="translate(14 30) scale(1.35)">
            {glyph.map((d, i) => <path key={i} d={d} />)}
          </g>
          <text className="a-name" x="58" y="45">{worker.name}</text>
          <text className="a-status" x="58" y="62">{worker.status}</text>
          <text className="a-open" x={NODE_W - 14} y={NODE_H - 12} textAnchor="end">OPEN</text>
        </g>
      </a>
    </g>
  );
}

export default function ArcadeFlow({ sources = [] }) {
  const workers = buildArcadeWorkers(sources);
  const totals = arcadeTotals(workers);
  const order = new Map(workers.map((w, i) => [w.id, i]));
  // The board's own pulse: the worst lane sets the colour of the live layer,
  // so a single failing worker turns the whole heartbeat red.
  const pulseTone = totals.down > 0 ? 'down' : totals.warn > 0 ? 'warn' : totals.muted === workers.length ? 'muted' : 'up';
  const headline = totals.down > 0
    ? `${totals.down} lane(s) failing`
    : totals.warn > 0
      ? `${totals.warn} lane(s) warning`
      : totals.muted === workers.length
        ? 'no lane has reported yet'
        : 'all lanes healthy';

  return (
    <section className="card arcade" aria-label="Agent Arcade">
      <div className="arcade-head">
        <div>
          <h2>Agent Arcade</h2>
          <p className="hint">
            Every harness worker on one circuit board, wired in run order.
            Dashes and packets show data moving; each LED pulses when its worker
            last reported healthy. Status is read from sources_health and aged
            against each worker&apos;s own expected heartbeat, so a lane that
            stops refreshing turns amber, then red - a stale row can never keep
            the board green. Click any module for that worker&apos;s full
            end-to-end dossier.
          </p>
        </div>
        <div className="arcade-totals">
          <span className={`pill ${pulseTone}`}>{headline}</span>
          <span className="pill up">{totals.up}/{workers.length} up</span>
          {totals.warn ? <span className="pill warn">{totals.warn} warn</span> : null}
          {totals.down ? <span className="pill down">{totals.down} down</span> : null}
          {totals.muted ? <span className="pill muted">{totals.muted} quiet</span> : null}
        </div>
      </div>

      <div className="arcade-board-scroll">
        <svg
          className={`arcade-svg tone-${pulseTone}`}
          viewBox={`0 0 ${BOARD_W} ${BOARD_H}`}
          role="img"
          aria-label="Worker pipeline board: W0 ingest to W7 evaluate, plus W8 supervisor and W9 tape"
        >
          <text className="a-cap" x="30" y="12">SYSTEM PULSE</text>
          <path className="a-ecg" d={ECG_D} />
          <circle className="a-packet a-ecg-dot" r="3" style={{ offsetPath: `path('${ECG_D}')` }} />

          <text className="a-cap" x="30" y="44">MAIN PIPELINE</text>
          <text className="a-cap" x="30" y="326">SUPPORT LANES</text>

          {RAILS.map((rail, i) => (
            <g key={rail.d}>
              <path className="a-rail" d={rail.d} />
              <path className="a-rail-live" d={rail.d} style={{ animationDelay: `${i * 0.08}s` }} />
              {i < 8 ? (
                <circle
                  className="a-packet"
                  r="3"
                  style={{
                    offsetPath: `path('${rail.d}')`,
                    animationDelay: `${i * 0.18}s`,
                  }}
                />
              ) : null}
              {rail.label ? (
                <text
                  className="a-rail-label"
                  x={rail.labelAt[0]}
                  y={rail.labelAt[1]}
                  style={rail.anchor ? { textAnchor: rail.anchor } : undefined}
                >
                  {rail.label}
                </text>
              ) : null}
            </g>
          ))}

          {workers
            .slice()
            .sort((a, b) => order.get(a.id) - order.get(b.id))
            .map((worker) => (
              <Module key={worker.id} worker={worker} index={order.get(worker.id)} />
            ))}
        </svg>
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
                <td><strong><a className="arc-link" href={`/dashboard/arcade/${w.id.toLowerCase()}`}>{w.id} {w.name}</a></strong></td>
                <td><span className={`pill ${w.tone}`}>{w.status}</span></td>
                <td className="small muted">{w.detail}</td>
                <td className="small muted">{w.checkedAt ? timeAgo(w.checkedAt) : '-'}</td>
                <td className="small muted">{w.sources.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="arcade-legend" aria-hidden="true">
        <span className="lg"><span className="dot up" /> healthy - pulsing LED</span>
        <span className="lg"><span className="dot warn" /> warning - lane needs a look</span>
        <span className="lg"><span className="dot down" /> failing - pulse turns red</span>
        <span className="lg"><span className="dot muted" /> unreported / idle - labelled</span>
        <span className="lg"><span className="wire" /> rail carries moving packets</span>
      </div>
    </section>
  );
}
