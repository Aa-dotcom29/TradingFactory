// Horizon metadata shared by server pages and the client tab bar. Keep this file
// free of any server-only imports.

export const HORIZONS = [
  {
    key: 'INTRADAY',
    label: 'Intraday',
    blurb: 'Same-session momentum',
    cadence: 'seconds to minutes',
    risk: 'Tight stops, reduced size',
    flow: true,
  },
  {
    key: 'SWING',
    label: 'Swing',
    blurb: 'Days to a few weeks',
    cadence: 'minutes to hours',
    risk: 'Balanced, ATR-based stops',
    flow: true,
  },
  {
    key: 'POSITIONAL',
    label: 'Positional',
    blurb: 'Weeks to months',
    cadence: 'hours to daily',
    risk: 'Wider stops, staged entries',
    flow: false,
  },
];

export function horizonByKey(key) {
  const wanted = String(key || '').toUpperCase();
  return HORIZONS.find((h) => h.key === wanted) || null;
}

export const HORIZON_KEYS = HORIZONS.map((h) => h.key);
