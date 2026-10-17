'use strict';

// Go-live ledger reset.
//
//   node harness/scripts/reset-ledger.js          # count only; changes nothing
//   node harness/scripts/reset-ledger.js --yes    # clear the ledger
//   npm run harness:reset-ledger -- --yes         # the same, through npm
//
// The `--` matters: npm consumes a bare `--yes` as its own flag, so `npm run ... --yes` prints the
// count and exits without clearing anything - indistinguishable from success at a glance.
//
// Why this exists: a published signal is the open-position ledger until the evaluator closes it, so
// signals raised while the pipeline was being built occupy real exposure slots and hold them for a
// horizon's whole holding window (see docs/risk-decision-trace.md). Clearing them is a go-live step,
// not a feature - and it cannot be a dashboard button, because publishing is meant to be
// irreversible from the UI.
//
// It clears the ledger and everything derived from it:
//   signal_events, outcomes, risk_decisions, signal_candidates, signal_stages, signals, queue_messages
//
// It deliberately leaves alone:
//   config_registry (the approved limits), sources_health, profiles/sessions, and every evidence
//   table (news_items, market_snapshots, oi_spurts, features, bias_verdicts, ingest_runs).
//
// `signals` carries a 90-day retention floor that blocks deletes. The reset disables that trigger
// for the length of a single transaction and restores it, so the floor is never left switched off -
// even if a delete fails.

const config = require('../src/config');
const db = require('../src/db');

const CLEARED = [
  'signal_events',
  'outcomes',
  'risk_decisions',
  'signal_candidates',
  'signal_stages',
  'signals',
  'queue_messages',
];

function redactedUrl(url) {
  if (!url) return '(DATABASE_URL is not set)';
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return '(unparsable DATABASE_URL)';
  }
}

async function countRows(sql, table) {
  const rows = await sql`select count(*)::int as n from ${sql(table)}`;
  return rows[0].n;
}

async function main() {
  const yes = process.argv.slice(2).includes('--yes');
  const sql = await db.connect();
  if (!sql) {
    console.error('No database connection. Set DATABASE_URL first.');
    return 1;
  }

  console.log(`Target: ${redactedUrl(config.database.url)}`);
  console.log('');

  const width = Math.max(...CLEARED.map((table) => table.length));
  const before = [];
  for (const table of CLEARED) before.push([table, await countRows(sql, table)]);
  for (const [table, n] of before) console.log(`  ${table.padEnd(width)}  ${n}`);

  const total = before.reduce((sum, [, n]) => sum + n, 0);
  if (!yes) {
    console.log(`\n${total} row(s) would be cleared. Nothing has changed.`);
    console.log('To clear them:');
    console.log('  node harness/scripts/reset-ledger.js --yes');
    console.log('  npm run harness:reset-ledger -- --yes    (npm swallows a bare --yes, so the -- is required)');
    return 0;
  }
  if (total === 0) {
    console.log('\nNothing to clear; the ledger is already empty.');
    return 0;
  }

  await sql.begin(async (tx) => {
    await tx`alter table signals disable trigger signals_retention_floor`;
    for (const table of CLEARED) await tx`delete from ${tx(table)}`;
    await tx`alter table signals enable trigger signals_retention_floor`;
  });

  console.log('\nLedger cleared:');
  for (const table of CLEARED) console.log(`  ${table.padEnd(width)}  ${await countRows(sql, table)}`);
  console.log('\nconfig_registry, sources_health and every evidence table were left untouched.');
  return 0;
}

main()
  .then((code) => db.close().then(() => process.exit(code)))
  .catch((error) => {
    console.error(`reset failed: ${error.message}`);
    process.exit(1);
  });
