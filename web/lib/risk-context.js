import { db } from './db.js';

// Household risk context.
//
// The state the risk gate reads when it decides whether another position may
// be opened: how much is already on, what the day has cost so far, and how
// many losses have come in a row.
//
// A signal card can say "every gate passed", but it cannot say why that was
// safe without this. The risk context is what turns an approval into
// something a person can judge.

const EMPTY = {
  openPositions: 0,
  closed24h: 0,
  pnl24h: 0,
  totalClosed: 0,
  winRatePct: null,
  lossStreak: 0,
};

export async function getRiskContext() {
  const sql = db();
  if (!sql) return EMPTY;
  try {
    const rows = await sql`
      select
        (select count(*)::int from active_signals) as open_positions,
        (select count(*)::int from outcomes
          where evaluated_at > now() - interval '1 day') as closed_24h,
        (select coalesce(sum(pnl_pct * abs(coalesce((payload->>'entry')::numeric, 1))), 0)::numeric
          from outcomes where evaluated_at > now() - interval '1 day') as weighted_24h,
        (select coalesce(sum(abs(coalesce((payload->>'entry')::numeric, 1))), 0)::numeric
          from outcomes where evaluated_at > now() - interval '1 day') as weight_24h,
        (select count(*)::int from outcomes where pnl_pct is not null) as total_closed,
        (select count(*)::int from outcomes where pnl_pct > 0) as wins
    `;
    const row = rows[0] || {};

    // The loss streak counts back from the most recent settled position. A
    // trade that never had a price is skipped: it did not lose anything.
    const recent = await sql`
      select pnl_pct
      from outcomes
      where pnl_pct is not null
      order by evaluated_at desc
      limit 20
    `;
    // Only a MATERIAL loss counts toward the streak: a 0.4% stop is noise and
    // must not be able to switch the household off.
    const material = 1;
    let lossStreak = 0;
    for (const outcome of recent) {
      if (Number(outcome.pnl_pct) <= -material) lossStreak += 1;
      else break;
    }

    const total = Number(row.total_closed || 0);
    // The day's return is weighted by the capital at risk in each closed plan.
    // A raw sum of per-trade percentages is not a return: it reads -90% on a day
    // the book is down 30%, and it grows with the number of trades.
    const weight = Number(row.weight_24h || 0);
    const pnl = weight > 0 ? Number(row.weighted_24h || 0) / weight : 0;
    return {
      openPositions: Number(row.open_positions || 0),
      closed24h: Number(row.closed_24h || 0),
      pnl24h: Math.round(pnl * 100) / 100,
      totalClosed: total,
      winRatePct: total ? Math.round((Number(row.wins || 0) / total) * 1000) / 10 : null,
      lossStreak,
    };
  } catch {
    return EMPTY;
  }
}

export { EMPTY as EMPTY_RISK_CONTEXT };
