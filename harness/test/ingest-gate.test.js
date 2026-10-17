'use strict';

// A closed exchange cannot produce a reading, so W0 must not ask for one.
//
// Before this gate the market poll ran every ten seconds around the clock and the flow poll every
// minute, archiving the same stale numbers each time and enqueuing a downstream job per copy. The
// stub below throws if either provider is touched, so a regression fails the test rather than
// quietly resuming the churn.
const test = require('node:test');
const assert = require('node:assert/strict');
const { IngestWorker, allStamped } = require('../src/workers/w0-ingest');

// Saturday 2026-10-17 11:30 IST == 06:00 UTC.
const WEEKEND = Date.parse('2026-10-17T06:00:00Z');

const forbidden = () => {
  throw new Error('the broker must not be called while the exchange is shut');
};

const explodingAngel = () => ({
  ensureInstruments: async () => forbidden(),
  resolveIndexTokens: () => forbidden(),
  resolveEquityTokens: () => forbidden(),
  quote: async () => forbidden(),
});

test('the market poll is skipped entirely while the exchange is shut', async () => {
  const worker = new IngestWorker({ angel: explodingAngel() });
  assert.deepEqual(await worker.runMarket(WEEKEND), { quotes: 0, skipped: 'market-closed' });
});

test('the flow poll is skipped entirely while the exchange is shut', async () => {
  const worker = new IngestWorker({ angel: explodingAngel() });
  assert.deepEqual(await worker.runFlow(WEEKEND), { rows: 0, skipped: 'market-closed' });
});

// Only a reading the source itself dated may be suppressed as a repeat. One with an unparseable
// timestamp is aged by its capture time, so re-storing it is new evidence - and treating it as a
// repeat would make a broken feed look exactly like a quiet one.
test('an undated batch is never eligible to be suppressed as a repeat', () => {
  assert.equal(allStamped([{ symbol: 'NIFTY 50', payload: { ltp: 25000, quoteTime: 'x' } }]), true);
  assert.equal(allStamped([{ symbol: 'NIFTY 50', payload: { ltp: 25000, quoteTime: null } }]), false);
  assert.equal(allStamped([{ symbol: 'NIFTY 50', payload: { ltp: 25000 } }]), false);
  assert.equal(
    allStamped([
      { symbol: 'A', payload: { quoteTime: 'x' } },
      { symbol: 'B', payload: { quoteTime: null } },
    ]),
    false,
    'one undated symbol is enough to make the whole batch ineligible',
  );
});
