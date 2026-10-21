// Agents Workspace - the whole harness drawn as one animated circuit board.
//
// The glance test this panel has to pass: "is the machine alive, and where is
// it stuck?" So the board is a real drawing, not a table of pills:
//
//   * Ten worker modules, each with its own line-art glyph, an ID chip, the
//     worker's name, its status word, a status LED and a spinning activity ring.
//   * A sensor grid and a slow radar sweep sit behind the modules, so the board
//     reads as a live instrument rather than a static diagram.
//   * Rails between the modules follow the actual run order W0 -> W7, wrapping
//     to the second row, plus the two support lanes: W9 tape feeds prints into
//     W7 evaluation, W7 hands health to W8 supervisor.
//   * Every rail carries marching dashes and several traveling packets,
//     staggered down the chain, so data visibly flows left to right forever.
//   * An ECG-style system pulse runs across the top in the board's worst tone.
//   * A live module's glyph breathes and its card edge glows; a failing module
//     strobes. The board's own state is visible without reading a single word.
//
// Every animation is CSS-only (rails, packets, rings, sweep, pulse) and is
// switched off under prefers-reduced-motion. Status comes from `sources_health`
// via buildArcadeWorkers; a worker that has not reported is labelled UNREPORTED,
// never coloured healthy. CurrentColor carries the tone: the same .tone-*
// classes that style the text pills drive the glyphs, LEDs and rails.

import {
  buildArcadeWorkers, arcadeTotals, BOARD, BOARD_W, BOARD_H, NODE_W, NODE_H, GLYPHS,
} from '@/lib/arcade';
import { timeAgo } from '@/lib/format';
import HudStrip from '@/components/HudStrip';

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

// A faint sensor grid behind everything, drawn once and tiled.
const GRID = [];
for (let x = 20; x < BOARD_W; x += 40) {
  GRID.push({ k: `v${x}`, d: `M${x} 0 V${BOARD_H}` });
}
for (let y = 20; y < BOARD_H; y += 40) {
  GRID.push({ k: `h${y}`, d: `M0 ${y} H${BOARD_W}` });
}

function Module({ worker, index }) {
  const { x, y } = BOARD[worker.id];
  const glyph = GLYPHS[worker.id] || [];
  const href = `/dashboard/arcade/${worker.id.toLowerCase()}`;
  const alive = worker.tone === 'up';
  const failing = worker.tone === 'down';
  const pending = worker.tone === 'warn';

  return (
    <g className={`arc-node tone-${worker.tone}`}>
      {/* A real SVG anchor: clicking a module opens that worker's full
          end-to-end dossier (what it does, sources, consumers). */}
      <a href={href} aria-label={`${worker.id} ${worker.name} - open worker dossier`}>
        <g transform={`translate(${x} ${y})`}>
          {/* The halo behind the card: a live lane breathes, a failing lane
              strobes, and an idle one stays dark. */}
          <rect className="a-halo" x="-6" y="-6" width={NODE_W + 12} height={NODE_H + 12} rx="14" />
          <rect className="a-card" width={NODE_W} height={NODE_H} rx="10" />
          <rect className="a-accent" width="3" height={NODE_H} rx="1.5" />
          <text className="a-id" x="14" y="19">{worker.id}</text>

          {/* The LED with its expanding ring, plus a rotating arc that reads
              as a live circuit. */}
          <circle className="a-led" cx="146" cy="16" r="3.5" />
          <circle className="a-ring" cx="146" cy="16" r="3.5" style={{ animationDelay: `${index * 0.18}s` }} />
          <g
            className={`a-spinner${alive ? ' live' : ''}${failing ? ' failing' : ''}${pending ? ' pending' : ''}`}
            style={{ animationDelay: `${(index % 4) * 0.3}s` }}
          >
            <circle cx="146" cy="16" r="9" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.5" strokeDasharray="5 13" />
          </g>

          <g className={`a-glyph${alive ? ' breathing' : ''}`} transform="translate(14 30) scale(1.35)">
            {glyph.map((d, i) => <path key={i} d={d} />)}
          </g>
          <text className="a-name" x="58" y="45">{worker.name}</text>
          <text className="a-status" x="58" y="62">{worker.status}</text>
          <text className="a-open" x={NODE_W - 14} y={NODE_H - 12} textAnchor="end">OPEN</text>

          {/* A short activity bar under the module: a live lane keeps it
              moving, an idle one holds it flat. */}
          <rect className="a-activity-bg" x="14" y={NODE_H - 12} width={NODE_W - 28} height="2" rx="1" />
          <rect
            className="a-activity"
            x="14"
            y={NODE_H - 12}
            width={NODE_W - 28}
            height="2"
            rx="1"
            style={{ animationDelay: `${index * 0.22}s` }}
          />
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
    <section className="card arcade" aria-label="Agents Workspace">
      <div className="arcade-head">
        <div>
          <h2>Agents Workspace</h2>
          <p className="hint">
            Every harness worker on one circuit board, wired in run order. The sweep, the marching
            dashes and the traveling packets show data moving; each module breathes while its
            worker last reported healthy. Status is read from sources_health and aged against
            each worker&apos;s own expected heartbeat, so a lane that stops refreshing turns
            amber, then red - a stale row can never keep the board green. Click any module for
            that worker&apos;s full end-to-end dossier.
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
        <HudStrip
          tone={pulseTone}
          label="AGENTS"
          metrics={[
            { k: 'nodes ', v: `${workers.length}` },
            { k: 'live ', v: `${totals.up}` },
            { k: 'warn ', v: `${totals.warn}` },
            { k: 'down ', v: `${totals.down}` },
          ]}
        />
        <svg
          className={`arcade-svg tone-${pulseTone}`}
          viewBox={`0 0 ${BOARD_W} ${BOARD_H}`}
          role="img"
          aria-label="Worker pipeline board: W0 ingest to W7 evaluate, plus W8 supervisor and W9 tape"
        >
          <defs>
            <radialGradient id="arcade-sweep" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.16" />
              <stop offset="60%" stopColor="currentColor" stopOpacity="0.05" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="arcade-fade" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0" />
              <stop offset="22%" stopColor="currentColor" stopOpacity="0.9" />
              <stop offset="78%" stopColor="currentColor" stopOpacity="0.9" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* The sensor grid behind the board. */}
          <g className="a-grid">
            {GRID.map((line) => <path key={line.k} d={line.d} />)}
          </g>

          {/* A slow radar sweep: a wide wedge of light that rotates over the
              board. It is the strongest single cue that this is live. */}
          <g className="a-radar">
            <rect x="-260" y="-260" width="520" height="520" fill="url(#arcade-sweep)" />
          </g>

          <text className="a-cap" x="30" y="12">SYSTEM PULSE</text>
          <path className="a-ecg" d={ECG_D} />
          <circle className="a-packet a-ecg-dot" r="3" style={{ offsetPath: `path('${ECG_D}')` }} />

          <text className="a-cap" x="30" y="44">MAIN PIPELINE</text>
          <text className="a-cap" x="30" y="326">SUPPORT LANES</text>

          {RAILS.map((rail, i) => (
            <g key={rail.d}>
              <path className="a-rail" d={rail.d} />
              <path className="a-rail-glow" d={rail.d} />
              <path className="a-rail-live" d={rail.d} style={{ animationDelay: `${i * 0.08}s` }} />
              {/* Three packets per rail, spaced by a third of the loop, so the
                  flow never looks like a single bead on a string. */}
              {[0, 1, 2].map((n) => (
                <circle
                  key={`p${n}`}
                  className="a-packet"
                  r={n === 0 ? 3.2 : 2.4}
                  style={{
                    offsetPath: `path('${rail.d}')`,
                    animationDelay: `${i * 0.18 + n * 0.6}s`,
                    animationDuration: n === 0 ? '1.8s' : '2.4s',
                  }}
                />
              ))}
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
        <span className="lg"><span className="wire sweep" /> radar sweep over the board</span>
      </div>
    </section>
  );
}
