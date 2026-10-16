import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Mirror Next.js' env loading (web/lib/env.js) so the same single .env drives both apps.
function loadEnvFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[m[1]] = value;
  }
}
loadEnvFile(path.join(REPO_ROOT, '.env'));
loadEnvFile(path.join(REPO_ROOT, 'web', '.env'));
loadEnvFile(path.join(REPO_ROOT, 'web', '.env.local'));

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a) => {
  if (a.startsWith('--')) { acc.push([a.slice(2), null]); return acc; }
  acc[acc.length - 1][1] = a; return acc;
}, []));

const email = (args.email || '').trim().toLowerCase();
const hours = Math.max(1, Number(args.hours) || 24);
const url = process.env.DATABASE_URL || '';
if (!url) { console.error('DATABASE_URL is not set (check .env).'); process.exit(1); }

const sql = postgres(url, {
  ssl: String(process.env.DATABASE_SSL || '').toLowerCase() === 'false' ? false : undefined,
  max: 2,
});

try {
  const [profile] = email
    ? await sql`select id, email from profiles where email = ${email}`
    : await sql`select id, email from profiles order by created_at asc limit 1`;
  if (!profile) { console.error('No profile found; create one first (web/scripts/create-user.js).'); process.exit(1); }

  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const expires = new Date(Date.now() + hours * 3600_000);

  await sql`insert into sessions (profile_id, token_hash, expires_at) values (${profile.id}, ${hash}, ${expires})`;

  const cookie = `tf_session=${token}`;
  console.log(`Minted a session for ${profile.email} (expires in ${hours} h).`);
  console.log();
  console.log('--- paste ONE of these into the browser dev console (F12 -> Console) ---');
  console.log(`document.cookie = "${cookie}; path=/; SameSite=Lax";`);
  console.log(`location.reload();`);
  console.log();
  console.log(`Or, as one line: document.cookie="${cookie}; path=/; SameSite=Lax"; location.replace("/");`);
  console.log();
  console.log('Raw cookie value (for curl/Node):', cookie);
} catch (error) {
  console.error('mint failed:', error.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
