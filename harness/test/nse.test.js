'use strict';

// Locks the verified NSE OI-spurts mapping. These are pure functions, so no network is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyFlow, spurtScore, flattenContractBuckets } = require('../src/sources/nse');

test('classifyFlow maps the four build-up quadrants', () => {
  assert.equal(classifyFlow(5, 10), 'LONG BUILDUP'); // price up, OI up
  assert.equal(classifyFlow(-5, 10), 'SHORT BUILDUP'); // price down, OI up
  assert.equal(classifyFlow(5, -10), 'SHORT COVERING'); // price up, OI down
  assert.equal(classifyFlow(-5, -10), 'LONG UNWINDING'); // price down, OI down
});

test('classifyFlow handles flat and missing values', () => {
  assert.equal(classifyFlow(0, 0), 'NO CHANGE');
  assert.equal(classifyFlow(1, 0), 'PRICE MOVED / OI FLAT');
  assert.equal(classifyFlow(0, 1), 'OI CHANGED / PRICE FLAT');
  assert.equal(classifyFlow(null, 5), 'FIRST SAMPLE');
});

test('classifyFlow output is ASCII (no leaked mojibake)', () => {
  const labels = [classifyFlow(0, 1), classifyFlow(1, 0), classifyFlow(5, 10)];
  for (const label of labels) assert.match(label, /^[\x20-\x7E]+$/);
});

test('spurtScore ranks larger OI moves higher and drops sign', () => {
  const small = spurtScore({ oiChange: 1000, volume: 10000 });
  const large = spurtScore({ oiChange: 50000, volume: 10000 });
  assert.ok(large > small);
  assert.equal(spurtScore({ oiChange: -5000, volume: 10000 }), spurtScore({ oiChange: 5000, volume: 10000 }));
});

test('flattenContractBuckets handles the live {data:[{bucket:[rows]}]} shape', () => {
  const apiResponse = {
    data: [
      { 'Rise-in-OI-Rise': [{ identifier: 'a' }, { identifier: 'b' }] },
      { 'Slide-in-OI-Slide': [{ identifier: 'c' }] },
    ],
    timestamp: 'x',
    currTradingDate: 'y',
  };
  const rows = flattenContractBuckets(apiResponse);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].bucket, 'Rise-in-OI-Rise');
  assert.equal(rows[2].row.identifier, 'c');
});

test('flattenContractBuckets handles a bare bucket object', () => {
  const rows = flattenContractBuckets({ 'Rise-in-OI-Slide': [{ identifier: 'z' }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bucket, 'Rise-in-OI-Slide');
});
