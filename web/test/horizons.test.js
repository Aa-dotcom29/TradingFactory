import test from 'node:test';
import assert from 'node:assert/strict';
import { HORIZONS, HORIZON_KEYS, horizonByKey } from '../lib/horizons.js';

test('there are exactly three horizons in a stable order', () => {
  assert.deepEqual(HORIZON_KEYS, ['INTRADAY', 'SWING', 'POSITIONAL']);
  assert.equal(HORIZONS.length, 3);
});

test('horizonByKey is case-insensitive and safe on junk', () => {
  assert.equal(horizonByKey('swing').label, 'Swing');
  assert.equal(horizonByKey('POSITIONAL').key, 'POSITIONAL');
  assert.equal(horizonByKey('nonsense'), null);
  assert.equal(horizonByKey(undefined), null);
});

test('every horizon carries a risk profile and cadence', () => {
  for (const h of HORIZONS) {
    assert.ok(h.risk && h.cadence && h.blurb && h.label);
  }
});
