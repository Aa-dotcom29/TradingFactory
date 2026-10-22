// Why the tool is quiet.
//
// A dashboard that shows no signals and says nothing is indistinguishable from
// a broken one. When every recent candidate was refused for the same reason,
// that reason is the headline: the reader needs to know whether the machine is
// silent because the market offered nothing, or because the risk gate stood
// the system down, and if the second, on what.

const GATE_LABELS = {
  enabled: 'risk gate disabled',
  killSwitch: 'kill switch engaged',
  session: 'outside the trading session',
  confidence: 'confidence below the floor',
  rewardRisk: 'reward-to-risk below the floor',
  liquidity: 'plan not liquid enough',
  stale: 'candidate too old to act on',
  openPositions: 'too many positions open',
  symbolExposure: 'already long this name',
  duplicateWindow: 'the same call was just published',
  consecutiveLossHalt: 'too many losses in a row',
  cooldownAfterLoss: 'cooling down after a loss',
  dailyLossLimit: "today's loss is past the limit",
};

export function gateLabel(gate) {
  const key = String(gate || '').trim();
  return GATE_LABELS[key] || key.replace(/([A-Z])/g, ' $1').toLowerCase();
}

// The gate names a failure as "gate: detail". This splits the pair.
export function splitReason(reason) {
  const text = String(reason || '').trim();
  const index = text.indexOf(':');
  if (index <= 0) return { gate: text, detail: '' };
  return { gate: text.slice(0, index).trim(), detail: text.slice(index + 1).trim() };
}

// Summarises the recent decisions into the single reason that best explains
// the silence. Returns null when there is nothing to explain.
export function gateSilence(decisions = []) {
  const rows = (Array.isArray(decisions) ? decisions : []).filter(
    (row) => row && row.decision && String(row.decision).toUpperCase() !== 'APPROVED',
  );
  if (!rows.length) return null;

  const counts = new Map();
  for (const row of rows) {
    const reasons = Array.isArray(row.reasons) ? row.reasons : [];
    for (const reason of reasons) {
      const { gate, detail } = splitReason(reason);
      if (!gate) continue;
      const entry = counts.get(gate) || { gate, detail, count: 0 };
      entry.count += 1;
      if (detail && !entry.detail) entry.detail = detail;
      counts.set(gate, entry);
    }
  }
  if (!counts.size) return null;

  const ranked = [...counts.values()].sort((a, b) => b.count - a.count);
  const top = ranked[0];
  return {
    gate: top.gate,
    label: gateLabel(top.gate),
    detail: top.detail,
    count: top.count,
    of: rows.length,
    also: ranked.slice(1, 3).map((entry) => ({
      gate: entry.gate,
      label: gateLabel(entry.gate),
      count: entry.count,
    })),
  };
}
