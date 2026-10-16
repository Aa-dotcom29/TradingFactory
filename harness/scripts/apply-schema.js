'use strict';

// Applies harness/db/schema.sql to the configured database. Useful on Render or a
// self-hosted VM where the Postgres image init hook is not used.
//
// The schema contains functions with semicolons in their bodies, so it must be sent as
// one simple query. postgres.js only allows .simple() on a single-connection client,
// so this deliberately opens its own max: 1 connection instead of the shared pool.

const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../src/config');

async function main() {
  if (!config.database.url) {
    console.error('DATABASE_URL is not set; nothing to apply.');
    process.exitCode = 1;
    return;
  }

  const file = path.join(__dirname, '..', 'db', 'schema.sql');
  const text = await fs.readFile(file, 'utf8');

  const mod = await import('postgres');
  const sql = mod.default(config.database.url, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false,
    ssl: config.database.ssl,
    onnotice: () => {},
  });

  try {
    console.log(`Applying ${path.relative(config.root, file)} ...`);
    if (typeof sql.unsafe !== 'function' || typeof sql.unsafe(text).simple !== 'function') {
      throw new Error('postgres.js simple() unavailable; apply schema.sql manually with psql');
    }
    await sql.unsafe(text).simple();
    console.log('Schema applied successfully.');
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('Schema apply failed:', error.message);
  process.exitCode = 1;
});
