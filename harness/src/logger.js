'use strict';

// Minimal structured logger: one JSON object per line, so logs are parseable by any
// collector without a logging dependency. Never log secrets.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.HARNESS_LOG_LEVEL] || LEVELS.info;

function emit(level, message, fields) {
  if (LEVELS[level] < threshold) return;
  const record = { ts: new Date().toISOString(), level, message, ...fields };
  const line = JSON.stringify(record);
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

function child(base) {
  return {
    debug: (m, f) => emit('debug', m, { ...base, ...f }),
    info: (m, f) => emit('info', m, { ...base, ...f }),
    warn: (m, f) => emit('warn', m, { ...base, ...f }),
    error: (m, f) => emit('error', m, { ...base, ...f }),
    child: (extra) => child({ ...base, ...extra }),
  };
}

module.exports = child({});
