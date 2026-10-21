// The Agents Workspace: every harness worker as one node on a single board.
//
// The mapping below is the real contract between the UI and the harness - each
// worker owns a specific set of `sources_health` rows (see harness/src/workers).
// A node's status is the WORST of those rows, so a single failing source lights
// its worker red rather than hiding behind a healthy neighbour. A worker whose
// sources have never reported shows as UNREPORTED: labelled, never fabricated.

export const WORKERS = [
  { id: 'W0', name: 'Ingest', blurb: 'quotes, OI spurts, RSS, option premiums', sources: ['rss', 'yahoo-quotes', 'nse-oi-spurts', 'angel', 'angel-options'], terminal: false },
  { id: 'W1', name: 'News', blurb: 'scores headlines into entities and severity', sources: ['news-scoring'], terminal: false },
  { id: 'W2', name: 'Flow', blurb: 'builds participatory flow features', sources: ['flow-features'], terminal: false },
  { id: 'W3', name: 'Bias', blurb: 'turns evidence into a per-symbol bias', sources: ['bias-meter'], terminal: false },
  { id: 'W4', name: 'Signal', blurb: 'builds and tracks signal candidates', sources: ['signal-builder'], terminal: false },
  { id: 'W5', name: 'Risk', blurb: 'gates every candidate through risk', sources: ['risk-gate'], terminal: false },
  { id: 'W6', name: 'Publish', blurb: 'shadow-first Telegram publishing', sources: ['publisher'], terminal: false },
  { id: 'W7', name: 'Evaluate', blurb: 'settles outcomes, scores configs', sources: ['evaluator'], terminal: false },
  { id: 'W8', name: 'Supervise', blurb: 'watches queues, staleness, housekeeping', sources: ['harness-supervisor'], terminal: false },
  { id: 'W9', name: 'Tape', blurb: 'live prints and broker book depth', sources: ['angel-tape'], terminal: false },
];

// Board geometry for the SVG circuit: two rows of four for the main chain,
// with the two support lanes underneath. Positions are data, not magic
// numbers in JSX, so the layout stays testable and the nodes never overlap.
export const BOARD = {
  W0: { x: 30, y: 56 }, W1: { x: 230, y: 56 }, W2: { x: 430, y: 56 }, W3: { x: 630, y: 56 },
  W4: { x: 30, y: 196 }, W5: { x: 230, y: 196 }, W6: { x: 430, y: 196 }, W7: { x: 630, y: 196 },
  W9: { x: 230, y: 336 }, W8: { x: 630, y: 336 },
};
export const BOARD_W = 840;
export const BOARD_H = 444;
export const NODE_W = 160;
export const NODE_H = 88;

// Line-art glyphs, 24x24, one per worker so every lane is recognisable at a
// glance without reading the label. Shared by the board and the detail page.
export const GLYPHS = {
  W0: ['M3 4h18l-7 8v7l-4-2v-5z'], // funnel - ingest
  W1: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6', 'M9 16h6'], // document - news
  W2: ['M3 9c2.5-2.5 5 2.5 7.5 0S16 4 21 9', 'M3 15c2.5-2.5 5 2.5 7.5 0S16 10 21 15'], // waves - flow
  W3: ['M4 18a8 8 0 0 1 16 0', 'M12 18l5-5', 'M11 18h2'], // gauge - bias
  W4: ['M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z'], // spark - signal
  W5: ['M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z', 'M8.5 12l2.5 2.5 4.5-5'], // shield - risk
  W6: ['M21 3L3 10.5l7 2.5 2.5 7z', 'M21 3l-11 10.5'], // paper plane - publish
  W7: ['M12 4a8 8 0 1 0 .01 0', 'M12 8a4 4 0 1 0 .01 0', 'M12 12h.01'], // target - evaluate
  W8: ['M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z', 'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5'], // eye - supervise
  W9: ['M6 5v14', 'M6 9h3v6H6z', 'M13 3v18', 'M13 7h3v9h-3z', 'M20 8v8'], // candles - tape
};

const STATUS_RANK = {
  ERROR: 0,
  FAILED: 1,
  DOWN: 2,
  WARNING: 3,
  STALE: 4,
  DEGRADED: 5,
  DISABLED: 6,
  IDLE: 7,
  HEALTHY: 8,
  OK: 8,
  LIVE: 8,
};

const TONE = {
  ERROR: 'down', FAILED: 'down', DOWN: 'down',
  WARNING: 'warn', STALE: 'warn', DEGRADED: 'warn',
  DISABLED: 'muted', IDLE: 'muted', UNREPORTED: 'muted',
  HEALTHY: 'up', OK: 'up', LIVE: 'up',
};

// How often each source's owner refreshes its `sources_health` row, in ms.
// These come from the harness schedule, not from taste: W0 market quotes and
// option premiums every 10s, OI flow every 60s, RSS every 5 min; W1-W7 every
// 15s; W8 and W9's health timer every 30s.
export const SOURCE_BEAT_MS = {
  'yahoo-quotes': 10000,
  angel: 10000,
  'angel-options': 10000,
  'nse-oi-spurts': 60000,
  rss: 300000,
  'news-scoring': 15000,
  'flow-features': 15000,
  'bias-meter': 15000,
  'signal-builder': 15000,
  'risk-gate': 15000,
  publisher: 15000,
  evaluator: 15000,
  'harness-supervisor': 30000,
  'angel-tape': 30000,
};

// A row's status word is a claim; its age is the proof. After four missed
// heartbeat windows the lane is STALE, after twenty it is DOWN - so a worker
// that wrote HEALTHY and then died cannot keep the board green.
export const STALE_BEATS = 4;
export const SILENT_BEATS = 20;

export function statusTone(status) {
  return TONE[String(status).toUpperCase()] || 'muted';
}

function shortAge(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

// Returns a liveness override for one `sources_health` row, or null when the
// row is fresh enough (or when the source has no known cadence). Freshness is
// checked against the source's own beat, so slow sources are not punished for
// being slow and fast ones are caught quickly.
export function sourceLiveness(row, now = Date.now()) {
  if (!row || !row.checked_at) return null;
  const beat = SOURCE_BEAT_MS[row.source];
  if (!beat) return null;
  const age = now - new Date(row.checked_at).getTime();
  if (!Number.isFinite(age) || age < 0) return null;
  if (age > beat * SILENT_BEATS) return { status: 'DOWN', age, beat };
  if (age > beat * STALE_BEATS) return { status: 'STALE', age, beat };
  return null;
}

function worstStatus(entries) {
  let worst = null;
  for (const entry of entries) {
    const rank = STATUS_RANK[String(entry.status).toUpperCase()];
    if (rank === undefined) continue;
    if (worst === null || rank < worst.rank) {
      worst = { rank, status: String(entry.status).toUpperCase(), detail: entry.detail || '-' };
    }
  }
  return worst;
}

// Turns raw `sources_health` rows into per-worker nodes, one per WORKERS entry,
// in board order. Every node always exists so the board layout never shifts.
// `now` is injectable so freshness is deterministic in tests.
export function buildArcadeWorkers(sources = [], now = Date.now()) {
  const bySource = new Map();
  for (const row of sources || []) {
    if (row && row.source) bySource.set(String(row.source), row);
  }

  return WORKERS.map((worker) => {
    const rows = worker.sources.map((name) => bySource.get(name)).filter(Boolean);
    // Judge every row on freshness first: a stale HEALTHY becomes STALE, a
    // long-silent one becomes DOWN. The reported word is kept in the detail so
    // the page can say "last HEALTHY, silent for 2h" instead of hiding it.
    const judged = rows.map((row) => {
      const reported = String(row.status).toUpperCase();
      const liveness = sourceLiveness(row, now);
      if (!liveness) return { status: reported, detail: row.detail || '-' };
      const last = reported.toLowerCase();
      return {
        status: liveness.status,
        detail: liveness.status === 'DOWN'
          ? `silent for ${shortAge(liveness.age)} (last ${last})`
          : `no heartbeat for ${shortAge(liveness.age)} (last ${last})`,
      };
    });

    const worst = worstStatus(judged);
    const reporting = rows.length > 0 && worst !== null;
    const status = reporting ? worst.status : 'UNREPORTED';
    const newest = rows
      .map((r) => r.checked_at)
      .filter(Boolean)
      .sort((a, b) => new Date(b) - new Date(a))[0] || null;
    const ageMs = newest ? Math.max(0, now - new Date(newest).getTime()) : null;
    const liveness = !reporting
      ? 'unreported'
      : status === 'DOWN'
        ? 'silent'
        : status === 'STALE'
          ? 'stale'
          : 'live';

    return {
      id: worker.id,
      name: worker.name,
      blurb: worker.blurb,
      sources: worker.sources,
      status,
      tone: statusTone(status),
      liveness,
      ageMs,
      detail: reporting
        ? worst.detail
        : 'no sources_health row yet - the worker has not run on this database',
      checkedAt: newest,
    };
  });
}

// Board totals keep the glance test honest: one headline number per lane.
export function arcadeTotals(workers = []) {
  const counts = { up: 0, warn: 0, down: 0, muted: 0 };
  for (const w of workers) counts[w.tone] = (counts[w.tone] || 0) + 1;
  return counts;
}
