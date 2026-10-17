'use strict';

// Freshness rules, shared by the ingestion worker (W0) and the supervisor (W8).
//
// Both answer a version of "is this reading new?", and both were getting it wrong for a 24/7
// process:
//
//   1. A batch W0 is about to store may be identical to the one it stored a minute ago. After the
//      close, on an NSE holiday, or during a feed stall the source keeps handing back the last
//      reading it had. On a ten-second poll that is thousands of identical rows a day, and every
//      downstream consumer would mistake the repeat for fresh evidence.
//
//   2. The supervisor asks whether the feed has fallen behind. That question only has an answer
//      while the exchange is trading. Outside the session the honest answer is CLOSED, not a
//      warning that nothing has arrived since Friday's close.
//
// Pure: no database, no timer, no network. The clock is always passed in.

const crypto = require('crypto');
const { marketSession } = require('./session');

const FEED_STATE = {
  FRESH: 'FRESH',
  STALE: 'STALE',
  CLOSED: 'CLOSED',
  NO_DATA: 'NO_DATA',
};

// JSON.stringify follows insertion order, which would make a fingerprint sensitive to how a payload
// happened to be built rather than to what it says. Sort keys so two structurally equal payloads
// always hash the same.
function canonicalise(value) {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = canonicalise(value[key]);
      return out;
    }, {});
  }
  return value;
}

function batchFingerprint(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalise(rows))).digest('hex');
}

// Remembers the last batch seen per source. Deliberately in memory: the worker is long-lived, the
// question is asked on every poll, and a restart costing at most one duplicate row is cheaper than
// a database round-trip on the hot path.
class RepeatTracker {
  constructor() {
    this.seen = new Map();
  }

  isRepeat(source, rows) {
    const fingerprint = batchFingerprint(rows);
    const previous = this.seen.get(source);
    this.seen.set(source, fingerprint);
    return previous === fingerprint;
  }
}

// The feed can only be judged late while a session is running. Outside it no new reading can exist,
// so the state is CLOSED and the supervisor stays quiet instead of crying stale every evening.
//
// Public holidays are not modelled anywhere in the harness. On one the exchange is nominally open,
// so the feed reads STALE until the next real session - a false positive that is preferable to
// hiding a genuine feed failure during trading hours. See docs/slice-9-session-aware-ingestion.md.
function feedState(latest, options = {}) {
  const now = options.now || Date.now();
  const staleAfterMs = options.staleAfterMs || 120000;
  const session = options.session || marketSession(now);
  if (!session.open) {
    return { state: FEED_STATE.CLOSED, latest: latest || null, ageMs: null, reason: session.reason };
  }
  if (!latest) return { state: FEED_STATE.NO_DATA, latest: null, ageMs: null };
  const ageMs = now - new Date(latest).getTime();
  return { state: ageMs > staleAfterMs ? FEED_STATE.STALE : FEED_STATE.FRESH, latest, ageMs };
}

module.exports = { FEED_STATE, canonicalise, batchFingerprint, RepeatTracker, feedState };
