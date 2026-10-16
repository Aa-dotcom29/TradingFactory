import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The harness reads .env from the repo root. Mirror that here so a single .env
// configures both the worker and the dashboard. Real environment variables always
// win (Docker, Render, or an exported shell variable).
//
// Next.js only auto-loads files inside web/ (.env, .env.local), so without this the
// dashboard would need a duplicated copy of DATABASE_URL.

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.resolve(here, '..', '..', '.env'),
  path.resolve(here, '..', '.env'),
  path.resolve(here, '..', '.env.local'),
];

for (const file of candidates) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] = value;
  }
}
