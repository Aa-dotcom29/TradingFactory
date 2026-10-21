// The Agent Arcade: every harness worker as one node on a single board.
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

export function statusTone(status) {
  return TONE[String(status).toUpperCase()] || 'muted';
}

function worstStatus(rows) {
  let worst = null;
  for (const row of rows) {
    const rank = STATUS_RANK[String(row.status).toUpperCase()];
    if (rank === undefined) continue;
    if (worst === null || rank < worst.rank) {
      worst = { rank, status: String(row.status).toUpperCase(), detail: row.detail || '-' };
    }
  }
  return worst;
}

// Turns raw `sources_health` rows into per-worker nodes, one per WORKERS entry,
// in board order. Every node always exists so the board layout never shifts.
export function buildArcadeWorkers(sources = []) {
  const bySource = new Map();
  for (const row of sources || []) {
    if (row && row.source) bySource.set(String(row.source), row);
  }

  return WORKERS.map((worker) => {
    const rows = worker.sources.map((name) => bySource.get(name)).filter(Boolean);
    const worst = worstStatus(rows);
    const reporting = rows.length > 0 && worst !== null;
    const status = reporting ? worst.status : 'UNREPORTED';
    return {
      id: worker.id,
      name: worker.name,
      blurb: worker.blurb,
      sources: worker.sources,
      status,
      tone: statusTone(status),
      detail: reporting ? worst.detail : 'no sources_health row yet - the worker has not run on this database',
      checkedAt: reporting
        ? rows.map((r) => r.checked_at).sort((a, b) => new Date(b) - new Date(a))[0]
        : null,
    };
  });
}

// Board totals keep the glance test honest: one headline number per lane.
export function arcadeTotals(workers = []) {
  const counts = { up: 0, warn: 0, down: 0, muted: 0 };
  for (const w of workers) counts[w.tone] = (counts[w.tone] || 0) + 1;
  return counts;
}
