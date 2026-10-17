import { db, databaseConfigured } from './db.js';

// All read queries are defensive: a missing database or a transient error yields an
// empty/zero result so the UI always renders a clear empty state.

export async function getHealth() {
  const empty = { configured: databaseConfigured, sources: [], counts: null, error: null };
  const sql = db();
  if (!sql) return empty;
  try {
    const sources = await sql`
      select source, status, detail, last_ok_at, last_error_at, checked_at
      from sources_health
      order by source asc
    `;
    const rows = await sql`
      select
        (select count(*)::int from news_items where published_at > now() - interval '24 hours') as news_24h,
        (select count(*)::int from news_items) as news_total,
        (select count(*)::int from oi_spurts where captured_at > now() - interval '24 hours') as flow_24h,
        (select count(*)::int from signals) as signals_total,
        (select count(*)::int from signals where published_at > now() - interval '24 hours') as signals_24h,
        (select count(*)::int from signals
          where published_at > now() - interval '24 hours' and snapshot->>'mode' = 'shadow') as signals_shadow_24h,
        (select count(*)::int from risk_decisions
          where evaluated_at > now() - interval '24 hours' and decision = 'APPROVED') as risk_approved_24h,
        (select count(*)::int from risk_decisions
          where evaluated_at > now() - interval '24 hours' and decision = 'REJECTED') as risk_rejected_24h,
        (select count(*)::int from signal_candidates where status = 'pending_risk') as candidates_pending,
        (select count(*)::int from (
          select distinct on (horizon, symbol) horizon, symbol, stage from signal_stages
          order by horizon, symbol, as_of desc
        ) s where s.stage = 'READY') as stages_ready
    `;
    return { configured: true, sources, counts: rows[0] || null, error: null };
  } catch (error) {
    return { ...empty, error: error.message };
  }
}

export async function getNews(limit = 40) {
  const sql = db();
  if (!sql) return [];
  try {
    return await sql`
      select id, published_at, source, url, title, summary, entities, sentiment, severity, relevance
      from news_items
      where published_at > now() - interval '14 days'
      order by published_at desc
      limit ${limit}
    `;
  } catch {
    return [];
  }
}

export async function getFlow(limit = 20) {
  const sql = db();
  const empty = { capturedAt: null, contracts: [], underlyings: [], quadrants: [] };
  if (!sql) return empty;
  try {
    const latest = (await sql`
      select max(captured_at) as captured_at
      from oi_spurts
      where captured_at > now() - interval '3 days'
    `)[0]?.captured_at;
    if (!latest) return empty;

    const contracts = await sql`
      select symbol, contract, option_type, strike, expiry, oi, oi_change, volume, price,
             price_change_pct, spurt_score, read, bucket, captured_at
      from oi_spurts
      where scope = 'CONTRACT' and captured_at = ${latest}
      order by spurt_score desc nulls last
      limit ${limit}
    `;
    const underlyings = await sql`
      select symbol, oi, oi_change, volume, price, price_change_pct, spurt_score, read
      from oi_spurts
      where scope = 'UNDERLYING' and captured_at = ${latest}
      order by spurt_score desc nulls last
      limit ${limit}
    `;
    const quadrants = await sql`
      select coalesce(read, 'UNKNOWN') as label, count(*)::int as n
      from oi_spurts
      where scope = 'CONTRACT' and captured_at = ${latest}
      group by 1
      order by n desc
    `;
    return { capturedAt: latest, contracts, underlyings, quadrants };
  } catch {
    return empty;
  }
}

export async function getSignals(horizon, limit = 25) {
  const sql = db();
  if (!sql) return [];
  try {
    return await sql`
      select id, horizon, strategy, symbol, direction, instrument, strike, option_type,
             entry, target, stop, rr, probability, confidence, published_at,
             strategy_version, engine_version, snapshot->>'mode' as mode
      from signals
      where horizon = ${horizon}
      order by published_at desc
      limit ${limit}
    `;
  } catch {
    return [];
  }
}

export async function listMembers(householdId) {
  const sql = db();
  if (!sql) return [];
  try {
    return await sql`
      select id, email, role, created_at
      from profiles
      where household_id = ${householdId}::uuid
      order by created_at asc
    `;
  } catch {
    return [];
  }
}

// Slice 2: the latest entity-level news features written by the news worker. One row per
// entity, already relevance-weighted and severity-escalated upstream so the UI does not
// re-derive anything.
export async function getEntityFeatures(limit = 8) {
  const empty = { asOf: null, entities: [] };
  const sql = db();
  if (!sql) return empty;
  try {
    const asOf = (await sql`
      select max(as_of) as as_of from features where feature_set = 'news.entity.v1'
    `)[0]?.as_of;
    if (!asOf) return empty;
    const entities = await sql`
      select symbol, values
      from features
      where feature_set = 'news.entity.v1' and as_of = ${asOf}
      order by coalesce((values->>'itemCount')::int, 0) desc, symbol asc
      limit ${limit}
    `;
    return { asOf, entities };
  } catch {
    return empty;
  }
}

// Slice 2: the latest per-symbol option-flow features written by the flow worker.
export async function getFlowFeatures(limit = 10) {
  const empty = { asOf: null, rows: [] };
  const sql = db();
  if (!sql) return empty;
  try {
    const asOf = (await sql`
      select max(as_of) as as_of from features where feature_set = 'flow.v1'
    `)[0]?.as_of;
    if (!asOf) return empty;
    const rows = await sql`
      select symbol, values
      from features
      where feature_set = 'flow.v1' and as_of = ${asOf}
      order by abs(coalesce((values->>'netOiChange')::numeric, 0)) desc, symbol asc
      limit ${limit}
    `;
    return { asOf, rows };
  } catch {
    return empty;
  }
}

// Slice 3: the current bias verdict per symbol for one horizon. distinct-on gives the latest
// row per symbol without needing a window function.
// Verdicts are persisted only when a call materially changes, so the stored
// sequence is the path of *changes*, not an evenly sampled series. The trend
// column says so in its title, and the line is drawn oldest-to-newest so a
// rising line always means the score rose.
const TREND_POINTS = 12;

async function attachScoreHistory(sql, rows) {
  if (!rows.length) return rows;

  let history = [];
  try {
    history = await sql`
      select horizon, symbol, score, as_of from (
        select horizon, symbol, score, as_of,
               row_number() over (partition by horizon, symbol order by as_of desc) as rn
        from bias_verdicts
        where as_of > now() - interval '45 days'
      ) t
      where rn <= ${TREND_POINTS}
      order by horizon, symbol, as_of asc
    `;
  } catch {
    history = [];
  }

  if (!history.length) return rows.map((row) => ({ ...row, history: [] }));

  const byKey = new Map();
  for (const point of history) {
    const key = `${point.horizon || ''}|${point.symbol}`;
    const list = byKey.get(key);
    if (list) list.push(Number(point.score));
    else byKey.set(key, [Number(point.score)]);
  }

  return rows.map((row) => ({
    ...row,
    history: byKey.get(`${row.horizon || ''}|${row.symbol}`) || [],
  }));
}

export async function getBias(horizon, limit = 12) {
  const sql = db();
  if (!sql) return [];
  try {
    const rows = await sql`
      select * from (
        select distinct on (symbol)
          symbol, horizon, direction, score, confidence, coverage, as_of, components, evidence, config_version, provenance
        from bias_verdicts
        where horizon = ${horizon}
        order by symbol, as_of desc
      ) t
      order by abs(score) desc, symbol asc
      limit ${limit}
    `;
    return attachScoreHistory(sql, rows);
  } catch {
    return [];
  }
}

// Slice 3: latest verdict for every (horizon, symbol) pair, plus direction counts for the
// overview. Counts cover every pair, not just the rows returned for display.
export async function getBiasOverview(limit = 6) {
  const empty = { rows: [], counts: { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 }, asOf: null };
  const sql = db();
  if (!sql) return empty;
  try {
    const rows = await sql`
      select * from (
        select distinct on (horizon, symbol)
          symbol, horizon, direction, score, confidence, coverage, as_of, provenance
        from bias_verdicts
        order by horizon, symbol, as_of desc
      ) t
      order by abs(score) desc, symbol asc
    `;
    const counts = { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 };
    let asOf = null;
    for (const row of rows) {
      counts[row.direction] = (counts[row.direction] || 0) + 1;
      if (!asOf || row.as_of > asOf) asOf = row.as_of;
    }
    const display = await attachScoreHistory(sql, rows.slice(0, limit));
    return { rows: display, counts, asOf };
  } catch {
    return empty;
  }
}

// Slice 4: the current lifecycle stage per symbol for one horizon. READY first, then BUILDING
// and WATCH, because that is the order a human wants to read them in.
export async function getSignalStages(horizon, limit = 12) {
  const sql = db();
  if (!sql) return [];
  try {
    return await sql`
      select * from (
        select distinct on (symbol)
          symbol, horizon, stage, previous_stage, direction, score, confidence,
          plan_ready, liquidity_ok, plan, reasons, as_of
        from signal_stages
        where horizon = ${horizon}
        order by symbol, as_of desc
      ) t
      order by case stage when 'READY' then 0 when 'BUILDING' then 1 when 'WATCH' then 2
                          when 'ACTIVE' then 3 when 'BLOCKED' then 4 else 5 end,
               abs(score) desc, symbol asc
      limit ${limit}
    `;
  } catch {
    return [];
  }
}

// Slice 4: the lifecycle across every horizon, with stage counts for the overview. Counts cover
// every (horizon, symbol) pair, not just the rows returned for display.
export async function getSignalStageOverview(limit = 8) {
  const empty = { rows: [], counts: { READY: 0, BUILDING: 0, WATCH: 0, IDLE: 0 }, asOf: null };
  const sql = db();
  if (!sql) return empty;
  try {
    const rows = await sql`
      select * from (
        select distinct on (horizon, symbol)
          symbol, horizon, stage, previous_stage, direction, score, confidence, as_of, reasons
        from signal_stages
        order by horizon, symbol, as_of desc
      ) t
      order by case stage when 'READY' then 0 when 'BUILDING' then 1 when 'WATCH' then 2
                          when 'ACTIVE' then 3 when 'BLOCKED' then 4 else 5 end,
               abs(score) desc, symbol asc
    `;
    const counts = { READY: 0, BUILDING: 0, WATCH: 0, IDLE: 0 };
    let asOf = null;
    for (const row of rows) {
      counts[row.stage] = (counts[row.stage] || 0) + 1;
      if (!asOf || row.as_of > asOf) asOf = row.as_of;
    }
    return { rows: rows.slice(0, limit), counts, asOf };
  } catch {
    return empty;
  }
}

// Slice 4: concrete tradeable proposals W4 raised for the risk gate. Nothing here is published
// yet - a candidate only becomes a real signal once W5 passes it and W6 delivers it.
export async function getSignalCandidates(horizon = null, limit = 10) {
  const sql = db();
  if (!sql) return [];
  try {
    if (horizon) {
      return await sql`
        select id, as_of, horizon, symbol, direction, kind, instrument, strike, option_type,
               expiry, entry, target, stop, rr, confidence, score, liquidity_ok, status, reasons,
               provenance
        from signal_candidates
        where horizon = ${horizon}
        order by created_at desc
        limit ${limit}
      `;
    }
    return await sql`
      select id, as_of, horizon, symbol, direction, kind, instrument, strike, option_type,
             expiry, entry, target, stop, rr, confidence, score, liquidity_ok, status, reasons,
             provenance
      from signal_candidates
      order by created_at desc
      limit ${limit}
    `;
  } catch {
    return [];
  }
}

// Slice 5: the gate's own audit trail. Every terminal decision carries the full check list, so
// "why was this rejected" is answered gate by gate rather than with a single reason string.
export async function getRiskDecisions(horizon = null, limit = 12) {
  const sql = db();
  if (!sql) return [];
  try {
    if (horizon) {
      return await sql`
        select d.id, d.evaluated_at, d.horizon, d.decision, d.passed, d.reasons, d.config_version,
               d.payload, c.symbol, c.direction, c.kind, c.instrument, c.strike, c.option_type,
               c.entry, c.target, c.stop, c.rr, c.confidence, c.status as candidate_status
        from risk_decisions d
        left join signal_candidates c on c.id = d.candidate_id
        where d.horizon = ${horizon}
        order by d.evaluated_at desc
        limit ${limit}
      `;
    }
    return await sql`
      select d.id, d.evaluated_at, d.horizon, d.decision, d.passed, d.reasons, d.config_version,
             d.payload, c.symbol, c.direction, c.kind, c.instrument, c.strike, c.option_type,
             c.entry, c.target, c.stop, c.rr, c.confidence, c.status as candidate_status
      from risk_decisions d
      left join signal_candidates c on c.id = d.candidate_id
      order by d.evaluated_at desc
      limit ${limit}
    `;
  } catch {
    return [];
  }
}
