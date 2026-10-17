import test from 'node:test';
import assert from 'node:assert/strict';
import { publishModeFor, publishModes, publishSummary } from '../lib/publish.js';

// The dashboard must report the same delivery modes the publisher will use, so these mirror the
// harness rule: a per-horizon value wins, and only the exact string `live` sends.

function withEnv(vars, run) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('only the exact string live is live; a typo or unset is shadow', () => {
  withEnv({ PUBLISH_MODE: undefined }, () => {
    assert.equal(publishModeFor('INTRADAY'), 'shadow');
  });
  withEnv({ PUBLISH_MODE: 'yes' }, () => {
    assert.equal(publishModeFor('INTRADAY'), 'shadow');
  });
  withEnv({ PUBLISH_MODE: 'live' }, () => {
    assert.equal(publishModeFor('INTRADAY'), 'live');
  });
});

test('a per-horizon value wins, so Intraday can go last', () => {
  withEnv({ PUBLISH_MODE: 'shadow', PUBLISH_MODE_SWING: 'live', PUBLISH_MODE_POSITIONAL: 'live' }, () => {
    const modes = Object.fromEntries(publishModes().map((entry) => [entry.horizon, entry.mode]));
    assert.equal(modes.INTRADAY, 'shadow');
    assert.equal(modes.SWING, 'live');
    assert.equal(modes.POSITIONAL, 'live');
    assert.equal(publishSummary(), 'mixed');
  });
});

test('the summary names the three states', () => {
  withEnv({ PUBLISH_MODE: undefined, PUBLISH_MODE_SWING: undefined, PUBLISH_MODE_POSITIONAL: undefined }, () => {
    assert.equal(publishSummary(), 'shadow');
  });
  withEnv({ PUBLISH_MODE: 'live' }, () => {
    assert.equal(publishSummary(), 'live');
  });
});
