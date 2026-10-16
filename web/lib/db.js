import postgres from 'postgres';

// Single shared Postgres client for the dashboard. Returns null when the database
// is not configured so every page can degrade to a clear "not configured" state
// instead of crashing the build or the request.
const url = process.env.DATABASE_URL || '';

function sslFor(candidate) {
  if (!candidate) return false;
  if (String(process.env.DATABASE_SSL || '').toLowerCase() === 'false') return false;
  if (/@(localhost|127\.0\.0\.1|db)[:/]/.test(candidate)) return false;
  return 'require';
}

function create() {
  return postgres(url, {
    max: Number(process.env.WEB_DB_POOL || 5),
    prepare: false,
    ssl: sslFor(url),
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

// Reuse across hot reloads in development and across route handlers in production.
const globalRef = globalThis;
if (!globalRef.__tfSql) globalRef.__tfSql = url ? create() : null;

export function db() {
  return globalRef.__tfSql || null;
}

export const databaseConfigured = Boolean(url);
