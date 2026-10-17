'use strict';

// Option contract identity.
//
// Two sides of the harness have to agree on exactly which contract a series of numbers belongs
// to: W0, which persists an option's premium over time, and W7, which reads it back to score a
// position. They must agree without talking to each other, because a queue message is a trigger
// and the durable tables are the truth.
//
// The same contract is described three different ways along the way:
//
//   * the harness carries the universe symbol it has always used - 'NIFTY 50', 'BANK NIFTY'
//   * NSE's OI-spurt flow names the expiry as '19-Oct-2026'
//   * Angel's scrip master stores the expiry as '19OCT2026' and, the trap, stores the strike
//     multiplied by 100 - the 20300 strike is '2030000.000000'
//
// All of that normalisation lives here, pure and unit-tested, instead of being re-derived
// (differently) inside a worker. Nothing here touches the network, the database or a clock.

const MONTHS = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

// The two price series a plan can be scored against. The names are the `features.feature_set`
// values that hold them, so the identity of the series and where it is stored cannot drift apart.
const PRICE_SOURCE = {
  UNDERLYING: 'quote.v1',
  OPTION: 'option.quote.v1',
};

// Index names in the harness universe versus the broker master. The master spells them without
// spaces, and MIDCAP NIFTY is 'MIDCPNIFTY' rather than anything guessable - so this is a table,
// verified against the live master, not a heuristic.
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

const OPTION_TYPES = ['CE', 'PE'];

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// The broker master's spelling of an underlying, used to match option rows. An index goes through
// the alias table; an equity is its own name, upper-cased and trimmed.
function underlyingAlias(symbol) {
  const text = String(symbol === null || symbol === undefined ? '' : symbol).trim().toUpperCase();
  if (!text) return null;
  return INDEX_ALIASES[text] || text;
}

// 'YYYY-MM-DD' from any of the shapes we actually see, or null. A value we cannot read is never
// guessed at: an unmatched expiry must fail to match a contract rather than match the wrong one.
function parseExpiry(value) {
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

function validIso(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// The canonical identity of an option series: 'NIFTY|2026-10-19|23150|CE'.
//
// This is stored as the `symbol` of an `option.quote.v1` feature row, and recomputed from the
// signal when W7 reads it back. Every part is required - a target missing its expiry or strike is
// an identity we cannot form, and returning null (rather than a partial key that would silently
// match nothing, or worse, match the wrong contract) is the honest answer.
function contractKey(target = {}) {
  const alias = underlyingAlias(target.symbol);
  const expiry = parseExpiry(target.expiry);
  const strike = num(target.strike);
  const optionType = String(target.optionType || '').trim().toUpperCase();
  if (!alias || !expiry || strike === null || strike <= 0) return null;
  if (!OPTION_TYPES.includes(optionType)) return null;
  return `${alias}|${expiry}|${strike}|${optionType}`;
}

function priceSourceFor(kind) {
  return String(kind || '').toUpperCase() === 'OPTION' ? PRICE_SOURCE.OPTION : PRICE_SOURCE.UNDERLYING;
}

// Resolve a target to the broker's instrument row.
//
// Matching is deliberately strict on every axis that could pick the wrong contract:
//   * NFO only, and only an option instrument type
//   * the master's underlying name equals the alias
//   * the master's expiry equals the target expiry, both normalised to ISO
//   * the trading symbol ends in the requested option type
//   * the strike matches after undoing the master's x100 scaling
// Anything short of all five yields null, and the caller records that the position could not be
// priced rather than pricing the wrong instrument.
const STRIKE_EPSILON = 0.001;

function matchOptionToken(instruments, target = {}) {
  const alias = underlyingAlias(target.symbol);
  const expiry = parseExpiry(target.expiry);
  const strike = num(target.strike);
  const optionType = String(target.optionType || '').trim().toUpperCase();
  if (!alias || !expiry || strike === null || strike <= 0 || !OPTION_TYPES.includes(optionType)) return null;
  if (!Array.isArray(instruments)) return null;

  for (const row of instruments) {
    if (!row) continue;
    if (String(row.exch_seg || '').toUpperCase() !== 'NFO') continue;
    const instrumentType = String(row.instrumenttype || '').toUpperCase();
    if (instrumentType !== 'OPTIDX' && instrumentType !== 'OPTSTK') continue;
    if (String(row.name || '').trim().toUpperCase() !== alias) continue;
    if (parseExpiry(row.expiry) !== expiry) continue;
    if (!String(row.symbol || '').toUpperCase().endsWith(optionType)) continue;
    const rowStrike = num(row.strike);
    if (rowStrike === null || Math.abs(rowStrike / 100 - strike) > STRIKE_EPSILON) continue;

    return {
      token: String(row.token),
      tradingSymbol: row.symbol || null,
      instrumentType,
      name: alias,
      expiry,
      strike,
      optionType,
      lotSize: num(row.lotsize),
    };
  }
  return null;
}

module.exports = {
  PRICE_SOURCE,
  INDEX_ALIASES,
  OPTION_TYPES,
  STRIKE_EPSILON,
  underlyingAlias,
  parseExpiry,
  contractKey,
  priceSourceFor,
  matchOptionToken,
};
