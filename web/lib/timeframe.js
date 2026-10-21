// Higher-timeframe / lower-timeframe bias alignment.
//
// The dashboard has one quote stream, sampled every few seconds. This module
// folds that stream into 5-minute and 15-minute bars and reads a directional
// bias from each, so a reader can see at a glance whether the short-term
// structure agrees with the larger one.
//
// It is deliberately pure arithmetic over rows that were already fetched, so
// the bucketing and the alignment rule can be tested without a database and
// cannot quietly depend on a live feed.
//
// Two rules the reader must be able to trust:
//   1. A timeframe with too few bars reports UNAVAILABLE with a reason. It
//      never shows a direction it could not actually measure.
//   2. Two timeframes that point opposite ways are DIVERGED. That is a
//      disagreement, not a failure, and it is labelled as one.

export const LTF_MINUTES = 5;
export const HTF_MINUTES = 15;
export const ALIGNMENT_LOOKBACK = 3; // bars

// Below this move a bar is treated as flat. Indices can print a tenth of a
// point inside one bar, and calling that a direction would be noise.
export const FLAT_BAND_PCT = 0.02;

export { INDEX_SYMBOLS } from './book.js';

export function bucketKey(at, minutes) {
  // `new Date(null)` is the epoch, not an error, so a missing timestamp has to
  // be rejected explicitly or a row with no time lands in a bar at 1970.
  if (at == null || at === '') return null;
  const time = new Date(at).getTime();
  if (!Number.isFinite(time)) return null;
  const size = minutes * 60000;
  return Math.floor(time / size) * size;
}

// Folds quote rows into bars. The last quote inside a bar is its close and
// the first is its open, so a bar's move is measured between real prints.
export function buildBars(rows = [], minutes = LTF_MINUTES) {
  const buckets = new Map();
  for (const row of rows) {
    const ltp = Number(row && row.ltp);
    if (!Number.isFinite(ltp)) continue;
    const key = bucketKey(row && row.at, minutes);
    if (key == null) continue;
    const bar = buckets.get(key);
    if (!bar) {
      buckets.set(key, { at: key, open: ltp, close: ltp, high: ltp, low: ltp, samples: 1 });
      continue;
    }
    bar.close = ltp;
    if (ltp > bar.high) bar.high = ltp;
    if (ltp < bar.low) bar.low = ltp;
    bar.samples += 1;
  }
  return [...buckets.values()].sort((a, b) => a.at - b.at);
}

// A directional read over the last `lookback` bars.
export function biasFromBars(bars = [], lookback = ALIGNMENT_LOOKBACK) {
  const count = bars.length;
  if (count < 2) {
    return { status: 'UNAVAILABLE', reason: 'not enough bars to measure a direction', direction: 'FLAT', changePct: null, bars: count };
  }
  const window = bars.slice(-lookback);
  const first = window[0].open;
  const last = window[window.length - 1].close;
  if (!Number.isFinite(first) || !Number.isFinite(last) || first === 0) {
    return { status: 'UNAVAILABLE', reason: 'the first print in the window is not a usable number', direction: 'FLAT', changePct: null, bars: count };
  }
  const changePct = ((last - first) / first) * 100;
  let direction = 'FLAT';
  if (changePct > FLAT_BAND_PCT) direction = 'UP';
  else if (changePct < -FLAT_BAND_PCT) direction = 'DOWN';
  return {
    status: 'OK',
    direction,
    changePct,
    bars: count,
    windowBars: window.length,
    open: first,
    close: last,
  };
}

// Compares the two reads. A flat timeframe cannot confirm anything, so the
// result is UNAVAILABLE rather than "aligned" or "diverged".
export function alignmentOf(ltf, htf) {
  if (!ltf || ltf.status !== 'OK' || !htf || htf.status !== 'OK') {
    return { aligned: null, label: 'UNAVAILABLE', tone: 'muted' };
  }
  if (ltf.direction === 'FLAT' || htf.direction === 'FLAT') {
    return { aligned: null, label: 'FLAT', tone: 'muted' };
  }
  const aligned = ltf.direction === htf.direction;
  return {
    aligned,
    label: aligned ? 'ALIGNED' : 'DIVERGED',
    tone: aligned ? 'up' : 'warn',
  };
}

// Full read for one symbol: two timeframes, the verdict, and the age of the
// newest print so a reader can tell a live alignment from a stale one.
export function timeframeRead(rows = [], now = Date.now()) {
  const ordered = [...rows].sort((a, b) => new Date(a.at) - new Date(b.at));
  const ltfBars = buildBars(ordered, LTF_MINUTES);
  const htfBars = buildBars(ordered, HTF_MINUTES);
  const ltf = biasFromBars(ltfBars);
  const htf = biasFromBars(htfBars);
  const alignment = alignmentOf(ltf, htf);
  const lastAt = ordered.length ? new Date(ordered[ordered.length - 1].at).getTime() : null;
  const ageMs = Number.isFinite(lastAt) ? Math.max(0, now - lastAt) : null;
  return {
    ltf: { ...ltf, minutes: LTF_MINUTES },
    htf: { ...htf, minutes: HTF_MINUTES },
    alignment,
    lastAt: lastAt || null,
    ageMs,
    quotes: ordered.length,
  };
}
