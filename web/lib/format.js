// Formatting helpers. IST is the trading clock; all amounts stay ASCII ("Rs" style
// tokens) on purpose so no encoding artefacts can creep into the rendered page.

const IST = 'Asia/Kolkata';

// A missing value must render as "-", not as 0. Number(null) and Number('') are
// both 0, so guard those explicitly before formatting.
function toNumber(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

export function isNum(value) {
  return Number.isFinite(toNumber(value));
}

export function istStamp(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

export function istDate(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

export function timeAgo(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function num(value, digits = 0) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function compact(value) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return String(Math.round(abs));
}

export function signed(value, digits = 0) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return '-';
  return `${n > 0 ? '+' : ''}${num(n, digits)}`;
}

export function pct(value, digits = 1) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return '-';
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

export function sentimentTone(value) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return 'muted';
  if (n >= 0.35) return 'up';
  if (n <= -0.35) return 'down';
  return 'muted';
}

export function severityTone(value) {
  const v = String(value || '').toUpperCase();
  if (v === 'CRITICAL') return 'down';
  if (v === 'HIGH') return 'warn';
  if (v === 'MEDIUM') return 'muted';
  return 'up';
}

export function readTone(read) {
  const v = String(read || '').toUpperCase();
  if (v.includes('LONG BUILDUP')) return 'up';
  if (v.includes('SHORT COVERING')) return 'up';
  if (v.includes('SHORT BUILDUP')) return 'down';
  if (v.includes('LONG UNWINDING')) return 'down';
  return 'muted';
}

export function directionTone(direction) {
  const v = String(direction || '').toUpperCase();
  if (v === 'BULLISH') return 'up';
  if (v === 'BEARISH') return 'down';
  return 'muted';
}
