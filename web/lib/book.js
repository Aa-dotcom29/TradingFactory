// The tradable book.
//
// This household trades equity, mutual funds and ETFs. Index derivatives are
// tracked, scored and published like everything else, but they are not part of
// the book: an index option is a position on a basket, not on a company, and
// the household does not take those.
//
// So index signals are separated from book signals in the UI rather than
// filtered out of the data. Nothing is dropped: the ledger keeps every
// signal, and the index ones are shown in their own panel with the reason.

export const INDEX_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'MIDCPNIFTY', 'SENSEX'];

// True when the signal is derived from an index rather than from a company,
// a fund or an ETF. Both the symbol and the instrument are checked, because
// an index option carries the index name in the instrument string.
export function isIndexSignal(signal) {
  if (!signal) return false;
  const symbol = String(signal.symbol || '').trim().toUpperCase();
  if (INDEX_SYMBOLS.includes(symbol)) return true;
  const instrument = String(signal.instrument || '').trim().toUpperCase();
  if (!instrument) return false;
  return INDEX_SYMBOLS.some((name) => instrument === name || instrument.startsWith(`${name} `));
}

// True when the signal belongs to the book: equity, mutual funds or ETFs.
export function isBookSignal(signal) {
  return !isIndexSignal(signal);
}
