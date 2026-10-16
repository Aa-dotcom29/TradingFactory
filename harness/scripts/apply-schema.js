'use strict';

// Applies harness/db/schema.sql to the configured database. Useful on Render or a
// self-hosted VM where the Postgres image init hook is not used. The schema contains
// functions with semicolons in their bodies, so it must be sent as a simple query.

const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../src/config');
const db = require('../src/db');

async function main() {
  if (!config.database.url) {
    console.error('DATABASE_URL is not set; nothing to apply.');
    process.exitCode = 1;
    return;
  }
  const file = path.join(__dirname, '..', 'db', 'schema.sql');
  const text = await fs.readFile(file, 'utf8');
  const sql = await db.connect();
  if (!sql) throw new Error('could not connect to the database');

  console.log(`Applying ${path.relative(config.root, file)} ...`);
  if (typeof sql.unsafe === 'function' && typeof sql.unsafe(text).simple === 'function') {
    await sql.unsafe(text).simple();
  } else {
    // Fallback: naive split fails on dollar-quoted bodies, so this is a last resort only.
    throw new Error('postgres.js simple() unavailable; apply schema.sql manually with psql');
  }
  console.log('Schema applied successfully.');
  await db.close();
}

main().catch(async (error) => {
  console.error('Schema apply failed:', error.message);
  await db.close().catch(() => {});
  process.exitCode = 1;
});
