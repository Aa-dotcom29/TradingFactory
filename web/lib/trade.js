// Pure helpers for the trade workspace. No database, network or clock is touched
// here: the page passes in a reference time so the same calculations can be
// unit-tested and replayed.

const MONTHS = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

const INDEX_ALIASES = {
  'NIFTY 50': 'NIFTY',
  NIFTY: 'NIFTY',
  'BANK NIFTY': 'BANKNIFTY',
  BANKNIFTY: 'BANKNIFTY',
  'MIDCAP NIFTY': 'MIDCPNIFTY',
  MIDCPNIFTY: 'MIDCPNIFTY',
  'NIFTY MIDCAP SELECT': 'MIDCPNIFTY',
  'FIN NIFTY': 'FINNIFTY',
  FINNIFTY: 'FINNIFTY',
  'NIFTY NEXT 50': 'NIFTYNXT50',
  NIFTYNXT50: 'NIFTYNXT50',
};

function toNumber(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function validIso(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// The harness stores an expiry in several shapes. This mirrors the strict
// parser in harness/src/contract.js so a contract key computed by the dashboard
// is the same key W0 writes into `option.quote.v1`.
export function parseExpiry(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim().toUpperCase();

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return validIso(iso[1], iso[2], iso[3]);

  const compact = text.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);
  if (compact && MONTHS[compact[2]]) return validIso(compact[3], MONTHS[compact[2]], compact[1]);

  const dashed = text.match(/^(\d{1,2})-([A-Z]{3})-(\d{4})$/);
  if (dashed && MONTHS[dashed[2]]) return validIso(dashed[3], MONTHS[dashed[2]], dashed[1]);

  return null;
}

export function underlyingAlias(symbol) {
  const text = String(symbol === null || symbol === undefined ? '' : symbol).trim().toUpperCase();
  if (!text) return null;
  return INDEX_ALIASES[text] || text;
}

export function normaliseOptionType(value) {
  const text = String(value || '').trim().toUpperCase();
  if (text === 'CE' || text === 'CALL') return 'CE';
  if (text === 'PE' || text === 'PUT') return 'PE';
  return null;
}

// 'NIFTY|2026-10-27|23100|CE', exactly the identity used by option.quote.v1.
export function optionContractKey({ symbol, expiry, strike, optionType } = {}) {
  const alias = underlyingAlias(symbol);
  const iso = parseExpiry(expiry);
  const strikeNumber = toNumber(strike);
  const type = normaliseOptionType(optionType);
  if (!alias || !iso || !Number.isFinite(strikeNumber) || strikeNumber <= 0 || !type) return null;
  return `${alias}|${iso}|${strikeNumber}|${type}`;
}

// An Indian option expires at 15:30 IST, which is 10:00 UTC. A date-only value
// therefore expires at that instant rather than at the previous midnight.
function expiryAt(value) {
  const iso = parseExpiry(value);
  if (!iso) return null;
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, 10, 0, 0));
}

export function daysToExpiry(expiry, now = new Date()) {
  const end = expiryAt(expiry);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!end || !Number.isFinite(nowMs)) return null;
  return Math.max(0, (end.getTime() - nowMs) / 86400000);
}

export function computeMomentum(series = []) {
  const rows = (Array.isArray(series) ? series : [])
    .map((row) => {
      const at = row && (row.at || row.as_of);
      const ms = at ? new Date(at).getTime() : NaN;
      return { at: Number.isFinite(ms) ? new Date(ms) : null, ms, ltp: toNumber(row && row.ltp) };
    })
    .filter((row) => row.at && Number.isFinite(row.ltp))
    .sort((a, b) => a.ms - b.ms);

  if (rows.length < 2) return null;

  const first = rows[0];
  const latest = rows[rows.length - 1];
  const prices = rows.map((row) => row.ltp);
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const changeAbs = latest.ltp - first.ltp;
  const changePct = first.ltp === 0 ? null : (changeAbs / first.ltp) * 100;
  const rangePosition = high === low ? null : ((latest.ltp - low) / (high - low)) * 100;

  return {
    rows,
    latest: latest.ltp,
    first: first.ltp,
    high,
    low,
    changeAbs,
    changePct,
    rangePosition,
    windowMinutes: (latest.ms - first.ms) / 60000,
    samples: rows.length,
  };
}

export function computeTradePnl({ position, entry, current, stop, target } = {}) {
  const entryNumber = toNumber(entry);
  const currentNumber = toNumber(current);
  if (!Number.isFinite(entryNumber) || entryNumber <= 0 || !Number.isFinite(currentNumber)) {
    return { available: false };
  }

  const direction = String(position || '').toUpperCase() === 'SHORT' ? -1 : 1;
  const pnl = (currentNumber - entryNumber) * direction;
  const risk = Math.abs(entryNumber - toNumber(stop));
  const reward = Math.abs(toNumber(target) - entryNumber);
  const stopNumber = toNumber(stop);
  const targetNumber = toNumber(target);

  return {
    available: true,
    direction,
    pnl,
    pnlPct: (pnl / entryNumber) * 100,
    rMultiple: Number.isFinite(risk) && risk > 0 ? pnl / risk : null,
    progressToTarget: Number.isFinite(reward) && reward > 0 ? pnl / reward : null,
    toStopPct: Number.isFinite(stopNumber)
      ? ((currentNumber - stopNumber) * direction / currentNumber) * 100
      : null,
    toTargetPct: Number.isFinite(targetNumber)
      ? ((targetNumber - currentNumber) * direction / currentNumber) * 100
      : null,
  };
}

// A time-value proxy, not broker Greeks. It answers the one question a premium
// holder needs: how much of what I am paying is extrinsic value, and how fast
// does the calendar take it away if spot does not move?
export function computeTheta({ premium, spot, strike, optionType, expiry, now = new Date() } = {}) {
  const premiumNumber = toNumber(premium);
  const strikeNumber = toNumber(strike);
  const spotNumber = toNumber(spot);
  const dte = daysToExpiry(expiry, now);
  const type = normaliseOptionType(optionType);

  if (!Number.isFinite(premiumNumber) || premiumNumber <= 0 || !Number.isFinite(strikeNumber) || !type) {
    return { available: false, dte, reason: 'premium, strike or option type is missing' };
  }

  const intrinsic = Number.isFinite(spotNumber)
    ? Math.max(0, type === 'PE' ? strikeNumber - spotNumber : spotNumber - strikeNumber)
    : null;
  const extrinsic = intrinsic === null ? null : Math.max(0, premiumNumber - intrinsic);
  const thetaPerDay = extrinsic === null
    ? null
    : (dte > 0 ? extrinsic / dte : extrinsic);
  const extrinsicPct = extrinsic === null ? null : (extrinsic / premiumNumber) * 100;

  return {
    available: true,
    dte,
    premium: premiumNumber,
    spot: Number.isFinite(spotNumber) ? spotNumber : null,
    strike: strikeNumber,
    optionType: type,
    intrinsic,
    extrinsic,
    thetaPerDay,
    extrinsicPct,
  };
}

// Match an NSE OI-spurt row to the signal's contract. NSE calls the side
// 'Call'/'Put' while the harness calls it 'CE'/'PE', so both are normalised.
export function findContract(contracts = [], target = {}) {
  const wantedStrike = toNumber(target.strike);
  const wantedType = normaliseOptionType(target.optionType);
  const wantedExpiry = parseExpiry(target.expiry);
  if (!Number.isFinite(wantedStrike) || !wantedType) return null;

  return (Array.isArray(contracts) ? contracts : []).find((contract) => {
    const strike = toNumber(contract && contract.strike);
    const type = normaliseOptionType(contract && (contract.optionType || contract.option_type));
    const expiry = parseExpiry(contract && contract.expiry);
    if (strike !== wantedStrike || type !== wantedType) return false;
    if (wantedExpiry && expiry !== wantedExpiry) return false;
    return true;
  }) || null;
}

// SVG polyline coordinates for a small price sparkline. Returns an empty string
// when there is not enough data to draw an honest line.
export function sparklinePoints(series = [], width = 320, height = 64) {
  const values = (Array.isArray(series) ? series : [])
    .map((row) => toNumber(row && row.ltp))
    .filter((value) => Number.isFinite(value));

  if (values.length < 2) return '';

  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || 1;

  return values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - ((value - low) / span) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

// Maps a pointer's horizontal ratio across a chart (0 at the left edge, 1 at
// the right) to the nearest sample index. Used by the interactive price chart
// to snap its crosshair to a real stored sample instead of interpolating a
// value that was never observed.
export function nearestSampleIndex(ratio, count) {
  const n = Math.floor(Number(count));
  if (!Number.isFinite(n) || n <= 0) return -1;
  if (n === 1) return 0;
  const r = Number(ratio);
  if (!Number.isFinite(r)) return 0;
  return Math.max(0, Math.min(n - 1, Math.round(r * (n - 1))));
}
