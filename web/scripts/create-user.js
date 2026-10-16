import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { hashPassword } from '../lib/password.js';

// Bootstrap the household owner (or add another member) from the command line.
//
//   node web/scripts/create-user.js --email owner@example.com --password "long-secret"
//   node web/scripts/create-user.js --email owner@example.com            (generates a password)
//
// Reads DATABASE_URL from the environment or from .env at the repo root / web/.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function loadEnvFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let value = m[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[m[1]] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (!token.startsWith('--')) continue;
  const key = token.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) {
    args[key] = next;
    i += 1;
  } else {
    args[key] = 'true';
  }
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

loadEnvFile(path.join(REPO_ROOT, '.env'));
loadEnvFile(path.resolve(__dirname, '..', '.env'));

const url = process.env.DATABASE_URL || '';
if (!url) fail('DATABASE_URL is not set. Add it to .env or export it.');

const email = String(args.email || process.env.OWNER_EMAIL || '').trim().toLowerCase();
if (!email) fail('Provide --email (or set OWNER_EMAIL).');

const householdName = args.household || process.env.HOUSEHOLD_NAME || 'Home';
const role = args.role === 'member' ? 'member' : 'owner';

let password = args.password || process.env.OWNER_PASSWORD || '';
let generated = false;
if (!password) {
  password = crypto.randomBytes(9).toString('base64url');
  generated = true;
}
if (password.length < 10) fail('Password must be at least 10 characters.');

const sslFor = (candidate) =>
  String(process.env.DATABASE_SSL || '').toLowerCase() === 'false' || /@(localhost|127\.0\.0\.1|db)[:/]/.test(candidate)
    ? false
    : 'require';

const sql = postgres(url, { max: 1, prepare: false, ssl: sslFor(url), connect_timeout: 10 });

try {
  const existing = await sql`select id from profiles where lower(email) = ${email} limit 1`;
  if (existing.length) {
    if (args.reset === 'true') {
      await sql`update profiles set password_hash = ${hashPassword(password)} where lower(email) = ${email}`;
      console.log(`Password reset for ${email}${generated ? `\nnew password: ${password}` : ''}`);
    } else {
      console.log(`Profile ${email} already exists. Re-run with --reset to change its password.`);
    }
  } else {
    const household = await sql`
      insert into households (name) values (${householdName})
      returning id
    `;
    await sql`
      insert into profiles (household_id, email, password_hash, role)
      values (${household[0].id}::uuid, ${email}, ${hashPassword(password)}, ${role})
    `;
    console.log(`Created household "${householdName}" and ${role} account ${email}`);
    if (generated) console.log(`generated password: ${password}`);
    console.log('Store the password now - it is not recoverable from the database.');
  }
} catch (error) {
  fail(error.message);
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}
