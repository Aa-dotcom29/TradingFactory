'use strict';

// The human half of the learning loop.
//
// The evaluator (W7) may propose a change to its own limits, but it can only ever write a
// `candidate` row in config_registry. Every worker resolves the latest *approved* version, so a
// proposal is inert until someone approves it here. This script is that someone.
//
//   npm run harness:config -- --list
//   npm run harness:config -- --approve=risk-w7-20261017T101500
//   npm run harness:config -- --approve=risk-w7-20261017T101500 --by=owner@tradingfactory.test
//
// Approving is an auditable act: the row records who approved it and when, and the `metrics`
// column keeps the evidence that motivated it, so the reasoning survives the decision.

const config = require('../src/config');
const db = require('../src/db');

function parseArgs(argv) {
  const flags = { list: false, approve: null, by: null, retire: null };
  for (const arg of argv) {
    if (arg === '--list') flags.list = true;
    else if (arg.startsWith('--approve=')) flags.approve = arg.slice('--approve='.length);
    else if (arg.startsWith('--retire=')) flags.retire = arg.slice('--retire='.length);
    else if (arg.startsWith('--by=')) flags.by = arg.slice('--by='.length);
  }
  return flags;
}

function usage() {
  console.log('Usage:');
  console.log('  npm run harness:config -- --list');
  console.log('  npm run harness:config -- --approve=<version> [--by=<email|uuid>]');
  console.log('  npm run harness:config -- --retire=<version>');
}

async function listFamilies(sql) {
  const rows = await sql`
    select version, family, status, created_by, created_at, approved_at, metrics
    from config_registry
    order by family asc, status asc, created_at desc
  `;
  if (!rows.length) {
    console.log('No config rows registered yet.');
    return;
  }
  console.log('version                          family   status     created_by      created');
  for (const row of rows) {
    const reason = row.metrics && row.metrics.reason ? ` - ${row.metrics.reason}` : '';
    console.log(
      `${String(row.version).padEnd(32)} ${String(row.family).padEnd(8)} `
      + `${String(row.status).padEnd(10)} ${String(row.created_by || '-').padEnd(15)} `
      + `${new Date(row.created_at).toISOString().slice(0, 16)}${reason}`,
    );
  }
  const pending = rows.filter((row) => row.status === 'candidate');
  if (pending.length) {
    console.log('');
    console.log(`${pending.length} row(s) awaiting approval. Approve one with:`);
    for (const row of pending) console.log(`  npm run harness:config -- --approve=${row.version}`);
  }
}

async function resolveApprover(sql, by) {
  if (!by) return null;
  // A uuid is taken as-is; a string with an @ is looked up in profiles, so the audit trail names
  // a real person rather than a free-text string.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(by)) return by;
  const rows = await sql`select id, email from profiles where lower(email) = lower(${by}) limit 1`;
  if (!rows.length) {
    throw new Error(`no profile matches "${by}"; pass a profile uuid or an existing email`);
  }
  return rows[0].id;
}

async function approve(sql, version, by) {
  const rows = await sql`select version, family, status, metrics from config_registry where version = ${version}`;
  if (!rows.length) throw new Error(`no config row named "${version}" (try --list)`);
  const row = rows[0];
  if (row.status === 'approved') {
    console.log(`${version} is already approved; nothing to do.`);
    return;
  }
  if (row.status !== 'candidate') {
    throw new Error(`${version} is "${row.status}", not a candidate; refusing to approve it`);
  }

  const approver = await resolveApprover(sql, by);
  await sql`
    update config_registry
    set status = 'approved', approved_at = now(), approved_by = ${approver}
    where version = ${version} and status = 'candidate'
  `;

  console.log(`approved ${version} (family ${row.family})`);
  if (row.metrics && row.metrics.reason) console.log(`  because: ${row.metrics.reason}`);
  if (row.metrics && row.metrics.change) {
    const change = row.metrics.change;
    console.log(`  change:  ${change.path} ${change.from} -> ${change.to}`);
  }
  console.log(`  by:      ${by ? (approver || by) : 'unattributed'}`);
  console.log('  effect:  the next config refresh in that family picks this version up.');
  console.log('           The limits in force are now this version, not the previous one.');
}

async function retire(sql, version) {
  const rows = await sql`select version, status from config_registry where version = ${version}`;
  if (!rows.length) throw new Error(`no config row named "${version}" (try --list)`);
  if (rows[0].status === 'retired') {
    console.log(`${version} is already retired.`);
    return;
  }
  await sql`update config_registry set status = 'retired' where version = ${version}`;
  console.log(`retired ${version}. It will no longer be resolved as the latest approved config.`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (!flags.list && !flags.approve && !flags.retire) {
    usage();
    process.exitCode = 1;
    return;
  }

  const sql = await db.connect();
  if (!sql) {
    console.error('No database connection; set DATABASE_URL.');
    process.exitCode = 1;
    return;
  }

  try {
    if (flags.list) await listFamilies(sql);
    if (flags.approve) await approve(sql, flags.approve, flags.by);
    if (flags.retire) await retire(sql, flags.retire);
  } finally {
    await db.close();
  }
}

main().catch(async (error) => {
  console.error(`config command failed: ${error.message}`);
  await db.close().catch(() => {});
  process.exitCode = 1;
});
