'use strict';

// Freshness rules used by W0 (do not store the same reading twice) and W8 (do not call a closed
// market stale). Pure - the clock and the session are both passed in.
const test = require('node:test');
const assert = require('node:assert/strict');
const { batchFingerprint, RepeatTracker, feedState } = require('../src/freshness');

// Monday 2026-10-19 09:30 IST == 04:00 UTC: a live session.
const LIVE_SESSION = Date.parse('2026-10-19T04:00:00Z');
// Saturday 2026-10-17 11:30 IST == 06:00 UTC.
const WEEKEND = Date.parse('2026-10-17T06:00:00Z');

test('a fingerprint depends on the payload, not on the order its keys were built in', () => {
  assert.equal(
    batchFingerprint([{ symbol: 'NIFTY 50', ltp: 1 }]),
    batchFingerprint([{ ltp: 1, symbol: 'NIFTY 50' }]),
  );
});

test('a fingerprint changes the moment the market content changes', () => {
  const base = [{ symbol: 'NIFTY 50', ltp: 25000, quoteTime: '2026-10-19T03:59:00.000Z' }];
  const moved = [{ symbol: 'NIFTY 50', ltp: 25001, quoteTime: '2026-10-19T03:59:00.000Z' }];
  const restamped = [{ symbol: 'NIFTY 50', ltp: 25000, quoteTime: '2026-10-19T04:00:00.000Z' }];
  assert.notEqual(batchFingerprint(base), batchFingerprint(moved));
  assert.notEqual(batchFingerprint(base), batchFingerprint(restamped));
});

test('the tracker suppresses a repeat batch and lets a changed one through', () => {
  const tracker = new RepeatTracker();
  const first = [{ symbol: 'NIFTY 50', ltp: 25000, quoteTime: 't1' }];
  const second = [{ symbol: 'NIFTY 50', ltp: 25000, quoteTime: 't2' }];
  assert.equal(tracker.isRepeat('quote', first), false, 'nothing stored yet, so nothing to repeat');
  assert.equal(tracker.isRepeat('quote', first), true, 'identical reading is not new evidence');
  assert.equal(tracker.isRepeat('quote', second), false, 'a moved timestamp is a new reading');
  assert.equal(tracker.isRepeat('quote', second), true);
});

test('each source is compared against its own history', () => {
  const tracker = new RepeatTracker();
  const rows = [{ symbol: 'A', ltp: 1 }];
  assert.equal(tracker.isRepeat('quote', rows), false);
  assert.equal(tracker.isRepeat('flow', rows), false, 'flow has never seen this batch');
});

test('a closed market is CLOSED, not STALE, however old the last reading is', () => {
  const state = feedState('2026-10-16T10:00:00Z', { now: WEEKEND, staleAfterMs: 1000 });
  assert.equal(state.state, 'CLOSED');
  assert.match(state.reason, /weekend/);
});

test('during a live session the staleness threshold still applies', () => {
  const stale = feedState('2026-10-19T03:00:00Z', { now: LIVE_SESSION, staleAfterMs: 120000 });
  assert.equal(stale.state, 'STALE');
  const fresh = feedState('2026-10-19T03:59:50Z', { now: LIVE_SESSION, staleAfterMs: 120000 });
  assert.equal(fresh.state, 'FRESH');
  assert.equal(fresh.ageMs, 10000);
});

test('a live session with nothing stored yet reports NO_DATA rather than stale', () => {
  assert.equal(feedState(null, { now: LIVE_SESSION }).state, 'NO_DATA');
});

test('a holiday is CLOSED, not STALE, on a day the market never opened', () => {
  // 20 October 2026, Dussehra - a Tuesday, so the weekend rule cannot close it. Without the holiday
  // list the feed went STALE at 10:39 and stayed there all day: a correct alarm for the wrong
  // reason, which is exactly the sort of thing a household learns to ignore.
  const dussehra = Date.parse('2026-10-20T05:10:00Z');
  const state = feedState('2026-10-20T03:37:00Z', { now: dussehra, staleAfterMs: 1000 });
  assert.equal(state.state, 'CLOSED');
  assert.match(state.reason, /holiday/);
});
