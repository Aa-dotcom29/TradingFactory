'use strict';

// Angel One quote mapping, kept pure and separate from the worker so the field names the broker
// actually returns are unit-tested rather than assumed inside a network call.
//
// The FULL quote response is documented as, for example:
//   { "exchange": "NSE", "tradingSymbol": "SBIN-EQ", "symbolToken": "3045", "ltp": 568.2,
//     "open": 567.4, "high": 569.35, "low": 566.1, "close": 567.4, "lastTradeQty": 1,
//     "exchFeedTime": "21-Jun-2023 10:46:10", "exchTradeTime": "21-Jun-2023 10:46:09",
//     "tradeVolume": 3556150, "opnInterest": 0, ... }
// Note the exchange times are `DD-MMM-YYYY HH:mm:ss` in IST, not ISO - so they need their own
// parser. `opnInterest` (Angel's spelling) maps to the `openInterest` the harness uses.

const MONTHS = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

// Angel's own stamp is IST; a value that is already ISO is passed through. Anything else returns
// null, so a field we do not recognise never becomes a guessed time.
function parseAngelTime(value) {
  if (!value) return null;
  const text = String(value).trim();

  const match = text.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})[ T](\d{1,2}):(\d{2}):(\d{2})$/);
  if (match) {
    const [, day, mon, year, hour, minute, second] = match;
    const month = MONTHS[mon.toUpperCase()];
    if (month === undefined) return null;
    const ms = Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute), Number(second))
      - IST_OFFSET_MS;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }

  return null;
}

// The bounded `quote.v1` shape W0 persists. `quoteTime` is the exchange feed time, so the bias
// meter can age a live Angel read exactly the way it ages a Yahoo one, instead of falling back to
// the moment we happened to poll.
//
// Numeric fields keep the original mapping's convention: a non-finite or zero value becomes null.
// That is deliberate for prices (a zero is not a price) and preserved for volume/open interest so
// this extraction changes nothing downstream - the price leg is the only consumer of the payload.
function toQuotePayload(quote) {
  const q = quote || {};
  return {
    ltp: Number(q.ltp) || null,
    open: Number(q.open) || null,
    high: Number(q.high) || null,
    low: Number(q.low) || null,
    close: Number(q.close) || null,
    openInterest: Number(q.opnInterest) || null,
    volume: Number(q.tradeVolume) || null,
    exchange: q.exchange || 'NSE',
    quoteTime: parseAngelTime(q.exchFeedTime || q.exchTradeTime),
  };
}

module.exports = { parseAngelTime, toQuotePayload };
