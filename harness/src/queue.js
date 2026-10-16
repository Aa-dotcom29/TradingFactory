'use strict';

// Plain-SQL queue built on FOR UPDATE SKIP LOCKED. No broker, no extension, no extra
// service to pay for - it runs on any Postgres. Semantics:
//   enqueue -> reserve (lease) -> ack | nack (retry with backoff, then dead-letter)
// Idempotency keys make enqueue safe to call repeatedly (at-least-once, deduped on write).

const db = require('./db');
const log = require('./logger').child({ module: 'queue' });

function requireDb() {
  const sql = db.client();
  if (!sql) throw new Error('queue used without a database connection');
  return sql;
}

function requirePositive(name, value) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
}

async function enqueue(topic, payload, options = {}) {
  const sql = requireDb();
  const { idemKey = null, horizon = null, maxAttempts = 5 } = options;
  const rows = await sql`
    insert into queue_messages (topic, idem_key, horizon, payload, max_attempts)
    values (${topic}, ${idemKey}, ${horizon}, ${sql.json(payload)}, ${maxAttempts})
    on conflict (topic, idem_key) where idem_key is not null do nothing
    returning id
  `;
  return rows.length ? { queued: true, id: rows[0].id } : { queued: false, duplicate: true };
}

async function reserve(topic, workerId, limit = 1, leaseSeconds = 120) {
  const sql = requireDb();
  requirePositive('limit', limit);
  return sql`
    with picked as (
      select id from queue_messages
      where topic = ${topic} and state = 'pending' and visible_at <= now()
      order by id
      for update skip locked
      limit ${limit}
    )
    update queue_messages q
      set state = 'processing',
          reserved_by = ${workerId},
          reserved_at = now(),
          attempts = q.attempts + 1,
          visible_at = now() + (${leaseSeconds} || ' seconds')::interval,
          updated_at = now()
    from picked
    where q.id = picked.id
    returning q.id, q.topic, q.payload, q.attempts, q.max_attempts, q.horizon
  `;
}

async function ack(id) {
  const sql = requireDb();
  await sql`
    update queue_messages
      set state = 'done', reserved_by = null, updated_at = now()
    where id = ${id}
  `;
}

async function nack(id, error) {
  const sql = requireDb();
  const message = error ? String(error).slice(0, 1000) : null;
  const rows = await sql`
    update queue_messages
      set state = case when attempts >= max_attempts then 'dead' else 'pending' end,
          visible_at = now() + (least(300, power(2, attempts)) || ' seconds')::interval,
          last_error = ${message},
          reserved_by = null,
          updated_at = now()
    where id = ${id}
    returning state, attempts
  `;
  const row = rows[0];
  if (row && row.state === 'dead') log.error('message moved to dead-letter', { id, error: message });
  return row;
}

async function stats() {
  const sql = requireDb();
  return sql`
    select topic, state, count(*)::int as count
    from queue_messages
    group by topic, state
    order by topic, state
  `;
}

async function deadLetters(limit = 20) {
  const sql = requireDb();
  return sql`
    select id, topic, attempts, last_error, created_at
    from queue_messages
    where state = 'dead'
    order by updated_at desc
    limit ${limit}
  `;
}

async function purgeDone(olderThanDays = 7) {
  const sql = requireDb();
  const rows = await sql`
    delete from queue_messages
    where state = 'done' and updated_at < now() - (${olderThanDays} || ' days')::interval
    returning id
  `;
  return rows.length;
}

module.exports = { enqueue, reserve, ack, nack, stats, deadLetters, purgeDone };
