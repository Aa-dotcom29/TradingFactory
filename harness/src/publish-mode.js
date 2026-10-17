'use strict';

// Publish-mode resolution. Kept dependency-free so the config layer and the delivery layer can
// share one rule without a require cycle.
//
// Delivery is shadow-first: only the exact string `live` sends anything. Everything else - unset,
// `shadow`, or a typo - resolves to shadow, so a misconfiguration fails closed rather than
// broadcasting a signal the household did not ask for.
//
// The mode can be set once for every horizon (PUBLISH_MODE) or per horizon
// (PUBLISH_MODE_INTRADAY, PUBLISH_MODE_SWING, PUBLISH_MODE_POSITIONAL). A per-horizon value wins,
// which is what lets publishing be enabled one horizon at a time, with Intraday last - the horizon
// where a mistaken or delayed alert costs the most.

const PUBLISH_MODES = ['shadow', 'live'];

function normalisePublishMode(value) {
  const mode = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  return PUBLISH_MODES.includes(mode) ? mode : 'shadow';
}

function resolvePublishMode(horizon, env = process.env) {
  const scope = String(horizon || '').trim().toUpperCase();
  const scoped = scope ? env[`PUBLISH_MODE_${scope}`] : undefined;
  const picked = scoped !== undefined && scoped !== null && String(scoped).trim() !== ''
    ? scoped
    : env.PUBLISH_MODE;
  return normalisePublishMode(picked);
}

module.exports = { PUBLISH_MODES, normalisePublishMode, resolvePublishMode };
