'use strict';

// Thin Postgres access layer. The harness must boot even with no database configured
// (dry run / CI), so connect() resolves to null instead of throwing when there is no URL.

const config = require('./config');
const log = require('./logger').child({ module: 'db' });

let sql = null;

async function connect() {
  if (sql) return sql;
  if (!config.database.url) {
    log.warn('DATABASE_URL is not set; running without persistence');
    return null;
  }
  const mod = await import('postgres');
  sql = mod.default(config.database.url, {
    max: config.database.max,
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false,
    ssl: config.database.ssl,
    onnotice: () => {},
  });
  await sql`select 1 as ok`;
  log.info('database connected');
  return sql;
}

function client() {
  return sql;
}

async function healthy() {
  if (!sql) return false;
  try {
    await sql`select 1 as ok`;
    return true;
  } catch (error) {
    log.error('database health check failed', { error: error.message });
    return false;
  }
}

async function close() {
  if (!sql) return;
  try {
    await sql.end({ timeout: 5 });
  } finally {
    sql = null;
  }
}

// Detect whether the harness schema has been applied. Used to fail clearly rather than
// silently writing nowhere.
async function schemaReady() {
  if (!sql) return false;
  const rows = await sql`select to_regclass('public.queue_messages') as t`;
  return Boolean(rows[0] && rows[0].t);
}

module.exports = { connect, client, healthy, close, schemaReady };
