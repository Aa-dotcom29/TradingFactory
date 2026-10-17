import { HORIZON_KEYS } from './horizons.js';

// Mirrors harness/src/publish-mode.js so the dashboard reports the modes the publisher will
// actually use, rather than a single global guess. A per-horizon PUBLISH_MODE_<HORIZON> wins over
// PUBLISH_MODE, and only the exact string `live` sends anything: everything else is shadow.
//
// Server-only (it reads process.env); pass plain strings down to client components.

export function publishModeFor(horizon) {
  const scoped = process.env[`PUBLISH_MODE_${String(horizon || '').toUpperCase()}`];
  const picked = scoped && String(scoped).trim() ? scoped : process.env.PUBLISH_MODE;
  return String(picked || '').trim().toLowerCase() === 'live' ? 'live' : 'shadow';
}

export function publishModes() {
  return HORIZON_KEYS.map((horizon) => ({ horizon, mode: publishModeFor(horizon) }));
}

// 'shadow' | 'live' | 'mixed'. The rail shows a single delivery chip, so the household can see at
// a glance whether nothing, something, or everything is actually being delivered.
export function publishSummary() {
  const modes = publishModes();
  const live = modes.filter((entry) => entry.mode === 'live').length;
  if (live === 0) return 'shadow';
  if (live === modes.length) return 'live';
  return 'mixed';
}
