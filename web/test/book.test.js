import test from 'node:test';
import assert from 'node:assert/strict';
import { isIndexSignal, isBookSignal, INDEX_SYMBOLS } from '../lib/book.js';

test('the four index names are the ones the book excludes', () => {
  assert.deepEqual(INDEX_SYMBOLS, ['NIFTY', 'BANKNIFTY', 'MIDCPNIFTY', 'SENSEX']);
});

test('an index option is an index signal, not a book signal', () => {
  const nifty = { symbol: 'NIFTY', instrument: 'NIFTY 27-Oct-2026 23100 CE' };
  assert.equal(isIndexSignal(nifty), true);
  assert.equal(isBookSignal(nifty), false);
});

test('an index future is an index signal', () => {
  const bank = { symbol: 'BANKNIFTY', instrument: 'BANKNIFTY spot/futures' };
  assert.equal(isIndexSignal(bank), true);
  assert.equal(isBookSignal(bank), false);
});

test('a company plan is a book signal', () => {
  const hdfc = { symbol: 'HDFCBANK', instrument: 'HDFCBANK spot/futures' };
  assert.equal(isIndexSignal(hdfc), false);
  assert.equal(isBookSignal(hdfc), true);

  const reliance = { symbol: 'RELIANCE', instrument: 'RELIANCE 27-Oct-2026 1240 CE' };
  assert.equal(isIndexSignal(reliance), false);
});

test('a company whose name starts with an index name is not caught', () => {
  // "NIFTYFOODS" is not the index; the match must be on a whole word.
  const food = { symbol: 'NIFTYFOODS', instrument: 'NIFTYFOODS spot/futures' };
  assert.equal(isIndexSignal(food), false);
});

test('a missing signal or a missing instrument is handled', () => {
  assert.equal(isIndexSignal(null), false);
  assert.equal(isIndexSignal({}), false);
  assert.equal(isIndexSignal({ symbol: 'TCS' }), false);
  assert.equal(isIndexSignal({ symbol: 'TCS', instrument: '' }), false);
});

test('an index signal with a null instrument is still caught by its symbol', () => {
  assert.equal(isIndexSignal({ symbol: 'SENSEX', instrument: null }), true);
});
