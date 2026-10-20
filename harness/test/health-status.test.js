'use strict';

// An idle worker is not a broken one.
//
// Two sources used to report a fault for the ordinary state of having nothing to do:
//
//   flow-features  W2 drained no snapshots because W0 correctly stopped enqueuing once the
//                  exchange shut, and wrote WARNING on every drain, stamping last_error_at.
//   angel-options  W0 returned early when the book held no option position, so an old WARNING
//                  and its last_error_at stayed on the row indefinitely.
//
// Both would show a warn pill on a perfectly healthy harness for most of the day. The rules below
// pin the neutral states: CLOSED when the exchange is shut, IDLE when the book is empty, and no
// last_error_at for either. A genuine empty drain while the market is open stays a warning.
const test = require('node:test');
const assert = require('node:assert/strict');
const { drainHealth } = require('../src/workers/w2-flow');
const { IngestWorker } = require('../src/workers/w0-ingest');

test('an empty flow drain out of hours is CLOSED, not a warning', () => {
  const health = drainHealth({ processed: 0, symbols: 0, open: false });
  assert.equal(health.status, 'CLOSED');
  assert.match(health.detail, /exchange is shut/);
});

test('an empty flow drain while the exchange is open is still a warning', () => {
  const health = drainHealth({ processed: 0, symbols: 0, open: true });
  assert.equal(health.status, 'WARNING');
  assert.equal(health.detail, '0 symbols from 0 snapshot(s)');
});

test('a snapshot drained after the close is real work and reads HEALTHY', () => {
  const health = drainHealth({ processed: 2, symbols: 37, open: false });
  assert.equal(health.status, 'HEALTHY');
  assert.equal(health.detail, '37 symbols from 2 snapshot(s)');
});

// The postgres driver is a tagged-template function, so a capturing stub is enough to read what
// the worker intended to write. The SQL itself is not executed.
function captureHealth(worker) {
  const calls = [];
  Object.defineProperty(worker, 'sql', {
    configurable: true,
    get: () => (strings, ...values) => {
      calls.push(values);
      return Promise.resolve([]);
    },
  });
  return calls;
}

test('an empty option book is IDLE and does not stamp last_error_at', async () => {
  const worker = new IngestWorker();
  const calls = captureHealth(worker);
  await worker.markSource('angel-options', 'IDLE', 'no open option positions to quote');
  assert.equal(calls.length, 1);
  const [source, status, detail, lastOk, lastError] = calls[0];
  assert.equal(source, 'angel-options');
  assert.equal(status, 'IDLE');
  assert.equal(detail, 'no open option positions to quote');
  assert.equal(lastOk, null, 'idle is not an ok reading');
  assert.equal(lastError, null, 'idle is not an error');
});

test('warning and error still stamp last_error_at; healthy still stamps last_ok_at', async () => {
  const worker = new IngestWorker();
  const calls = captureHealth(worker);
  await worker.markSource('src', 'HEALTHY', 'ok');
  await worker.markSource('src', 'WARNING', 'nothing came back');
  await worker.markSource('src', 'ERROR', 'boom');
  assert.ok(calls[0][3] instanceof Date, 'healthy records last_ok_at');
  assert.equal(calls[0][4], null, 'healthy clears nothing but stamps no error');
  assert.ok(calls[1][4] instanceof Date, 'warning records last_error_at');
  assert.ok(calls[2][4] instanceof Date, 'error records last_error_at');
});
