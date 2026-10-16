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
        (select count(*)::int from signals where published_at > now() - interval '24 hours') as signals_24h
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
             strategy_version, engine_version
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
