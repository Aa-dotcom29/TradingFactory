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

// MAIN carries the decision pipeline left to right. SUPPORT holds the two
// long-running lanes: W9 feeds prints and depth into evaluation and the trade
// workspace, W8 watches every lane rather than sitting on the chain itself.
export const LANES = [
  { key: 'main', label: 'Main pipeline', workers: ['W0', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7'] },
  { key: 'support', label: 'Support lanes', workers: ['W8', 'W9'] },
];

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
