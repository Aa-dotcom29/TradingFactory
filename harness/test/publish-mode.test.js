'use strict';

// Publish-mode resolution. Pure: the environment is passed in, so no globals are touched and the
// tests are order-independent.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalisePublishMode, resolvePublishMode } = require('../src/publish-mode');

test('only the exact string live enables delivery; everything else is shadow', () => {
  assert.equal(normalisePublishMode('live'), 'live');
  assert.equal(normalisePublishMode(' LIVE '), 'live');
  assert.equal(normalisePublishMode('shadow'), 'shadow');
  assert.equal(normalisePublishMode('true'), 'shadow');
  assert.equal(normalisePublishMode('yes'), 'shadow');
  assert.equal(normalisePublishMode(''), 'shadow');
  assert.equal(normalisePublishMode(undefined), 'shadow');
  assert.equal(normalisePublishMode(null), 'shadow');
});

test('PUBLISH_MODE sets every horizon when no per-horizon value is present', () => {
  const env = { PUBLISH_MODE: 'live' };
  assert.equal(resolvePublishMode('INTRADAY', env), 'live');
  assert.equal(resolvePublishMode('SWING', env), 'live');
  assert.equal(resolvePublishMode('POSITIONAL', env), 'live');
  assert.equal(resolvePublishMode(null, env), 'live');
});

test('a per-horizon value wins over the global, so Intraday can stay last', () => {
  const env = { PUBLISH_MODE: 'shadow', PUBLISH_MODE_SWING: 'live', PUBLISH_MODE_POSITIONAL: 'live' };
  assert.equal(resolvePublishMode('INTRADAY', env), 'shadow');
  assert.equal(resolvePublishMode('SWING', env), 'live');
  assert.equal(resolvePublishMode('POSITIONAL', env), 'live');
});

test('an empty per-horizon value and an unknown horizon both fall back to the global', () => {
  const env = { PUBLISH_MODE: 'live', PUBLISH_MODE_SWING: '' };
  assert.equal(resolvePublishMode('SWING', env), 'live');
  assert.equal(resolvePublishMode('NOPE', env), 'live');
  assert.equal(resolvePublishMode('', env), 'live');
});

test('nothing configured is shadow, everywhere', () => {
  assert.equal(resolvePublishMode('INTRADAY', {}), 'shadow');
  assert.equal(resolvePublishMode(null, {}), 'shadow');
});
