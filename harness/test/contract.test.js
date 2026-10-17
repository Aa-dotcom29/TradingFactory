'use strict';

// Slice 8 - option contract identity. Pure functions: no network, no database, no clock.
//
// The rows in MASTER are copied from the live Angel scrip master (the x100 strike scaling, the
// DDMMMYYYY expiry and the symbol layout are exactly what the broker returns), so these tests pin
// the real shapes rather than an idealised version of them.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PRICE_SOURCE,
  underlyingAlias,
  parseExpiry,
  contractKey,
  priceSourceFor,
  matchOptionToken,
} = require('../src/contract');

const MASTER = [
  // Index option, strike stored as 23150 * 100.
  { token: '47169', symbol: 'NIFTY19OCT2623150CE', name: 'NIFTY', expiry: '19OCT2026', strike: '2315000.000000', exch_seg: 'NFO', instrumenttype: 'OPTIDX', lotsize: '65' },
  { token: '47170', symbol: 'NIFTY19OCT2623150PE', name: 'NIFTY', expiry: '19OCT2026', strike: '2315000.000000', exch_seg: 'NFO', instrumenttype: 'OPTIDX', lotsize: '65' },
  { token: '47171', symbol: 'NIFTY19OCT2623200CE', name: 'NIFTY', expiry: '19OCT2026', strike: '2320000.000000', exch_seg: 'NFO', instrumenttype: 'OPTIDX', lotsize: '65' },
  // The same strike, a different expiry - must not be confused with the above.
  { token: '47172', symbol: 'NIFTY27OCT2623150CE', name: 'NIFTY', expiry: '27OCT2026', strike: '2315000.000000', exch_seg: 'NFO', instrumenttype: 'OPTIDX', lotsize: '65' },
  // Stock option with a fractional strike: 182.5 is stored as 18250.
  { token: '100019', symbol: 'HINDZINC27OCT26610CE', name: 'HINDZINC', expiry: '27OCT2026', strike: '61000.000000', exch_seg: 'NFO', instrumenttype: 'OPTSTK', lotsize: '5' },
  // Rows that must never match an option target: an equity spot and an index row.
  { token: '3045', symbol: 'SBIN-EQ', name: 'SBIN', expiry: '', strike: '', exch_seg: 'NSE', instrumenttype: '', lotsize: '1' },
  { token: '99926000', symbol: 'Nifty 50', name: 'Nifty 50', expiry: '', strike: '', exch_seg: 'NSE', instrumenttype: 'AMXIDX', lotsize: '1' },
];

test('underlyingAlias maps the universe spelling to the master spelling', () => {
  assert.equal(underlyingAlias('NIFTY 50'), 'NIFTY');
  assert.equal(underlyingAlias('BANK NIFTY'), 'BANKNIFTY');
  // Verified against the live master: MIDCAP NIFTY is MIDCPNIFTY, not MIDCAPNIFTY.
  assert.equal(underlyingAlias('MIDCAP NIFTY'), 'MIDCPNIFTY');
  assert.equal(underlyingAlias(' midcap nifty '), 'MIDCPNIFTY');
  // An equity is its own name.
  assert.equal(underlyingAlias('reliance'), 'RELIANCE');
  assert.equal(underlyingAlias(''), null);
  assert.equal(underlyingAlias(null), null);
});

test('parseExpiry reads every shape we actually see, and refuses the rest', () => {
  assert.equal(parseExpiry('2026-10-19'), '2026-10-19');
  assert.equal(parseExpiry('2026-10-19T00:00:00Z'), '2026-10-19');
  assert.equal(parseExpiry('19OCT2026'), '2026-10-19'); // the broker master
  assert.equal(parseExpiry('19-Oct-2026'), '2026-10-19'); // NSE's expiryDate
  assert.equal(parseExpiry('19-OCT-2026'), '2026-10-19');
  assert.equal(parseExpiry('1OCT2026'), '2026-10-01');
  assert.equal(parseExpiry(''), null);
  assert.equal(parseExpiry(null), null);
  assert.equal(parseExpiry('2026-13-01'), null);
  assert.equal(parseExpiry('32OCT2026'), null);
  assert.equal(parseExpiry('19XXX2026'), null);
  assert.equal(parseExpiry('next Thursday'), null);
});

test('contractKey is the same string on both sides of the pipeline', () => {
  // What W0 derives from a stored signal, with a different expiry spelling than the master's.
  const fromSignal = contractKey({ symbol: 'NIFTY 50', expiry: '19-Oct-2026', strike: 23150, optionType: 'CE' });
  assert.equal(fromSignal, 'NIFTY|2026-10-19|23150|CE');
  // And what the master match resolves for the same contract.
  const match = matchOptionToken(MASTER, { symbol: 'NIFTY 50', expiry: '19OCT2026', strike: 23150, optionType: 'CE' });
  assert.equal(match.token, '47169');

  // A fractional strike keeps its decimals.
  assert.equal(contractKey({ symbol: 'HINDZINC', expiry: '27OCT2026', strike: 182.5, optionType: 'PE' }), 'HINDZINC|2026-10-27|182.5|PE');
});

test('contractKey refuses an incomplete identity rather than forming a partial one', () => {
  assert.equal(contractKey({ symbol: 'NIFTY 50', expiry: '19OCT2026', strike: 23150 }), null); // no type
  assert.equal(contractKey({ symbol: 'NIFTY 50', strike: 23150, optionType: 'CE' }), null); // no expiry
  assert.equal(contractKey({ symbol: 'NIFTY 50', expiry: '19OCT2026', optionType: 'CE' }), null); // no strike
  assert.equal(contractKey({ expiry: '19OCT2026', strike: 23150, optionType: 'CE' }), null); // no symbol
  assert.equal(contractKey({ symbol: 'NIFTY 50', expiry: '19OCT2026', strike: 23150, optionType: 'XX' }), null);
  assert.equal(contractKey({ symbol: 'NIFTY 50', expiry: 'nonsense', strike: 23150, optionType: 'CE' }), null);
});

test('matchOptionToken resolves the exact contract, undoing the broker x100 strike', () => {
  const ce = matchOptionToken(MASTER, { symbol: 'NIFTY 50', expiry: '19-Oct-2026', strike: 23150, optionType: 'CE' });
  assert.equal(ce.token, '47169');
  assert.equal(ce.strike, 23150);
  assert.equal(ce.expiry, '2026-10-19');
  assert.equal(ce.optionType, 'CE');
  assert.equal(ce.name, 'NIFTY');
  assert.equal(ce.lotSize, 65);

  // The put at the same strike is a different contract, not the same one.
  assert.equal(matchOptionToken(MASTER, { symbol: 'NIFTY 50', expiry: '19OCT2026', strike: 23150, optionType: 'PE' }).token, '47170');
  // A different expiry at the same strike must not resolve to the nearer contract.
  assert.equal(matchOptionToken(MASTER, { symbol: 'NIFTY 50', expiry: '27OCT2026', strike: 23150, optionType: 'CE' }).token, '47172');
  // A stock option, fractional strike.
  assert.equal(matchOptionToken(MASTER, { symbol: 'HINDZINC', expiry: '27OCT2026', strike: 610, optionType: 'CE' }).token, '100019');
});

test('matchOptionToken returns null instead of a plausible wrong contract', () => {
  // A strike that exists in neither direction.
  assert.equal(matchOptionToken(MASTER, { symbol: 'NIFTY 50', expiry: '19OCT2026', strike: 14500, optionType: 'CE' }), null);
  // An expiry the master does not carry.
  assert.equal(matchOptionToken(MASTER, { symbol: 'NIFTY 50', expiry: '25DEC2030', strike: 23150, optionType: 'CE' }), null);
  // An equity the master has no option for.
  assert.equal(matchOptionToken(MASTER, { symbol: 'SBIN', expiry: '19OCT2026', strike: 800, optionType: 'CE' }), null);
  // An index row (AMXIDX on NSE) must never satisfy an option target.
  assert.equal(matchOptionToken(MASTER, { symbol: 'NIFTY 50', expiry: '19OCT2026', strike: 23150 }), null);
  assert.equal(matchOptionToken(MASTER, {}), null);
  assert.equal(matchOptionToken(null, { symbol: 'NIFTY 50', expiry: '19OCT2026', strike: 23150, optionType: 'CE' }), null);
});

test('priceSourceFor names the series each plan is scored against', () => {
  assert.equal(priceSourceFor('OPTION'), PRICE_SOURCE.OPTION);
  assert.equal(priceSourceFor('option'), PRICE_SOURCE.OPTION);
  assert.equal(priceSourceFor('UNDERLYING'), PRICE_SOURCE.UNDERLYING);
  assert.equal(priceSourceFor(null), PRICE_SOURCE.UNDERLYING);
  assert.equal(PRICE_SOURCE.OPTION, 'option.quote.v1');
  assert.equal(PRICE_SOURCE.UNDERLYING, 'quote.v1');
});
