'use strict';

// Verifies the harness reuses the existing session clock rather than reimplementing it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { nseDerivativesSession, makeTotp, classifyPriceOi } = require('../../angel-feed');

test('session is SESSION during NSE hours on a weekday', () => {
  // Monday 2026-10-19 09:30 IST == 04:00 UTC
  assert.equal(nseDerivativesSession(new Date('2026-10-19T04:00:00Z')).phase, 'SESSION');
});

test('session is PRE_MARKET before 09:15 IST', () => {
  // Monday 2026-10-19 07:30 IST == 02:00 UTC
  assert.equal(nseDerivativesSession(new Date('2026-10-19T02:00:00Z')).phase, 'PRE_MARKET');
});

test('session is POST_MARKET after the close', () => {
  // Monday 2026-10-19 16:30 IST == 11:00 UTC
  assert.equal(nseDerivativesSession(new Date('2026-10-19T11:00:00Z')).phase, 'POST_MARKET');
});

test('session is CLOSED_DAY on weekends', () => {
  // Saturday 2026-10-17
  assert.equal(nseDerivativesSession(new Date('2026-10-17T06:00:00Z')).phase, 'CLOSED_DAY');
});

test('makeTotp returns a six digit code', () => {
  const code = makeTotp('JBSWY3DPEHPK3PXP', Date.UTC(2026, 0, 1, 0, 0, 0));
  assert.match(code, /^\d{6}$/);
});

test('classifyPriceOi labels build-up quadrants', () => {
  assert.equal(classifyPriceOi(1, 1), 'LONG BUILDUP');
  assert.equal(classifyPriceOi(-1, 1), 'SHORT BUILDUP');
  assert.equal(classifyPriceOi(1, -1), 'SHORT COVERING');
  assert.equal(classifyPriceOi(-1, -1), 'LONG UNWINDING');
});
