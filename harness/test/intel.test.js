'use strict';

// Slice 2 intelligence math. Pure functions, so these run with no network and no database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateNewsEntities, computeFlowFeatures, severityRank, normalizeOptionType } = require('../src/intel');

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000);

function newsFixture() {
  return [
    {
      published_at: hoursAgo(1),
      source: 'test.com',
      url: 'https://x/1',
      title: 'Reliance beats estimates, profit jumps to record high',
      entities: ['RELIANCE'],
      sentiment: 0.6,
      severity: 'HIGH',
      relevance: 0.8,
    },
    {
      published_at: hoursAgo(2),
      source: 'test.com',
      url: 'https://x/2',
      title: 'RIL raises guidance for the year',
      entities: ['RELIANCE'],
      sentiment: 0.4,
      severity: 'MEDIUM',
      relevance: 0.5,
    },
    {
      published_at: hoursAgo(3),
      source: 'test.com',
      url: 'https://x/3',
      title: 'Infosys misses estimates, shares plunge',
      entities: ['INFY'],
      sentiment: -0.5,
      severity: 'MEDIUM',
      relevance: 0.7,
    },
  ];
}

test('severityRank orders the severity classes', () => {
  assert.equal(severityRank('LOW'), 0);
  assert.equal(severityRank('MEDIUM'), 1);
  assert.equal(severityRank('HIGH'), 2);
  assert.equal(severityRank('CRITICAL'), 3);
  assert.equal(severityRank('nonsense'), 0);
});

test('aggregateNewsEntities groups by entity and counts items', () => {
  const rows = aggregateNewsEntities(newsFixture(), { now: NOW });
  const reliance = rows.find((r) => r.symbol === 'RELIANCE');
  const infy = rows.find((r) => r.symbol === 'INFY');

  assert.equal(reliance.values.itemCount, 2);
  assert.equal(infy.values.itemCount, 1);
  // Loudest cluster first.
  assert.equal(rows[0].symbol, 'RELIANCE');
});

test('aggregateNewsEntities signs sentiment and escalates pressure with severity', () => {
  const rows = aggregateNewsEntities(newsFixture(), { now: NOW });
  const reliance = rows.find((r) => r.symbol === 'RELIANCE').values;
  const infy = rows.find((r) => r.symbol === 'INFY').values;

  assert.ok(reliance.netSentiment > 0, `reliance netSentiment=${reliance.netSentiment}`);
  assert.ok(infy.netSentiment < 0, `infy netSentiment=${infy.netSentiment}`);
  assert.equal(reliance.maxSeverity, 'HIGH');
  assert.equal(reliance.severityRank, 2);
  assert.ok(reliance.pressure > 0, `reliance pressure=${reliance.pressure}`);
  assert.ok(infy.pressure < 0, `infy pressure=${infy.pressure}`);
  assert.ok(reliance.pressure <= 1 && reliance.pressure >= -1);
  assert.equal(reliance.positive, 2);
  assert.equal(reliance.negative, 0);
});

test('aggregateNewsEntities excludes items outside the window', () => {
  const rows = aggregateNewsEntities(newsFixture(), { now: NOW, windowHours: 1 });
  // Only the 1-hour-old item survives, and only its entity remains.
  assert.deepEqual(rows.map((r) => r.symbol), ['RELIANCE']);
  assert.equal(rows[0].values.itemCount, 1);
});

test('aggregateNewsEntities keeps the strongest headlines and is ASCII-safe', () => {
  const rows = aggregateNewsEntities(newsFixture(), { now: NOW, topTitles: 1 });
  const reliance = rows.find((r) => r.symbol === 'RELIANCE').values;
  assert.equal(reliance.topTitles.length, 1);
  assert.match(reliance.topTitles[0].title, /beats estimates/);
});

test('aggregateNewsEntities handles empty and malformed input', () => {
  assert.deepEqual(aggregateNewsEntities([], { now: NOW }), []);
  assert.deepEqual(aggregateNewsEntities(null, { now: NOW }), []);
  assert.deepEqual(aggregateNewsEntities([{ title: 'no entities' }], { now: NOW }), []);
});

test('computeFlowFeatures sums CE/PE open-interest change per symbol', () => {
  const rows = computeFlowFeatures([
    { scope: 'CONTRACT', symbol: 'NIFTY', optionType: 'CE', contract: 'NIFTY-CE-25000', strike: 25000, oiChange: 1000, volume: 5000, read: 'LONG BUILDUP' },
    { scope: 'CONTRACT', symbol: 'NIFTY', optionType: 'CE', contract: 'NIFTY-CE-25100', strike: 25100, oiChange: 500, volume: 2000, read: 'SHORT BUILDUP' },
    { scope: 'CONTRACT', symbol: 'NIFTY', optionType: 'PE', contract: 'NIFTY-PE-24800', strike: 24800, oiChange: 400, volume: 3000, read: 'SHORT COVERING' },
    { scope: 'UNDERLYING', symbol: 'NIFTY', oiChange: 250, volume: 9000, read: 'LONG BUILDUP' },
    { scope: 'CONTRACT', symbol: 'BANKNIFTY', optionType: 'PE', contract: 'BNF-PE-52000', strike: 52000, oiChange: -300, volume: 1000, read: 'LONG UNWINDING' },
  ]);

  assert.equal(rows.length, 2);
  const nifty = rows.find((r) => r.symbol === 'NIFTY').values;
  assert.equal(nifty.ceOiChange, 1500);
  assert.equal(nifty.peOiChange, 400);
  assert.equal(nifty.netOiChange, 1900);
  assert.equal(nifty.pcrOiChange, 0.267);
  assert.equal(nifty.longBuildup, 1);
  assert.equal(nifty.shortBuildup, 1);
  assert.equal(nifty.shortCovering, 1);
  assert.equal(nifty.longUnwinding, 0);
  assert.equal(nifty.contractCount, 3);
  assert.equal(nifty.optionCount, 3);
  assert.equal(nifty.futureCount, 0);
  assert.equal(nifty.underlyingOiChange, 250);
  assert.equal(nifty.scope, 'MIXED');
  assert.equal(nifty.topContracts.length, 3);
  assert.equal(nifty.topContracts[0].contract, 'NIFTY-CE-25000');
  assert.equal(nifty.topContracts[0].kind, 'OPTION');
});

test('computeFlowFeatures keeps futures out of the put-call ratio', () => {
  const rows = computeFlowFeatures([
    { scope: 'CONTRACT', symbol: 'NIFTY', optionType: 'Call', contract: 'NIFTY-CE', strike: 25000, oiChange: 1000, read: 'LONG BUILDUP' },
    // Futures arrive with optionType "-" and strike 0 on the same endpoint.
    { scope: 'CONTRACT', symbol: 'NIFTY', optionType: '-', contract: 'FUTIDXNIFTYXX0', strike: 0, oiChange: -5000, read: 'LONG UNWINDING' },
  ]);

  const nifty = rows[0].values;
  assert.equal(nifty.ceOiChange, 1000);
  assert.equal(nifty.peOiChange, 0);
  assert.equal(nifty.pcrOiChange, 0); // PE leg is zero, CE leg is not
  assert.equal(nifty.futureOiChange, -5000);
  assert.equal(nifty.optionCount, 1);
  assert.equal(nifty.futureCount, 1);
  assert.equal(nifty.contractCount, 2);
  assert.equal(nifty.netOiChange, -4000);
  assert.equal(nifty.longUnwinding, 1);
  const future = nifty.topContracts.find((c) => c.kind === 'FUTURE');
  assert.ok(future, 'futures are labelled in topContracts');
});

test('computeFlowFeatures guards a zero CE leg and reads snake_case rows', () => {
  const rows = computeFlowFeatures([
    { scope: 'CONTRACT', symbol: 'X', option_type: 'PE', oi_change: -100, volume: 20, read: 'LONG UNWINDING' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].values.pcrOiChange, null);
  assert.equal(rows[0].values.peOiChange, -100);
  assert.equal(rows[0].values.scope, 'CONTRACT');
  assert.equal(rows[0].values.longUnwinding, 1);
});

test('computeFlowFeatures ranks by absolute net OI change and tolerates junk', () => {
  const rows = computeFlowFeatures([
    { scope: 'CONTRACT', symbol: 'SMALL', optionType: 'CE', oiChange: 10 },
    { scope: 'CONTRACT', symbol: 'BIG', optionType: 'CE', oiChange: 9999 },
    null,
    { scope: 'CONTRACT', oiChange: 5 },
  ]);
  assert.deepEqual(rows.map((r) => r.symbol), ['BIG', 'SMALL']);
  assert.deepEqual(computeFlowFeatures([]), []);
});

test('normalizeOptionType canonicalises the NSE Put/Call spelling', () => {
  assert.equal(normalizeOptionType('Put'), 'PE');
  assert.equal(normalizeOptionType('Call'), 'CE');
  assert.equal(normalizeOptionType('PE'), 'PE');
  assert.equal(normalizeOptionType('ce'), 'CE');
  assert.equal(normalizeOptionType('-'), null);
  assert.equal(normalizeOptionType(null), null);
});

test('computeFlowFeatures reads the live NSE Put/Call spelling into CE and PE legs', () => {
  const rows = computeFlowFeatures([
    { scope: 'CONTRACT', symbol: 'NIFTY', optionType: 'Call', contract: 'NIFTY-CE', strike: 25000, oiChange: 1000, read: 'LONG BUILDUP' },
    { scope: 'CONTRACT', symbol: 'NIFTY', optionType: 'Put', contract: 'NIFTY-PE', strike: 24800, oiChange: 2000, read: 'SHORT COVERING' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].values.ceOiChange, 1000);
  assert.equal(rows[0].values.peOiChange, 2000);
  assert.equal(rows[0].values.pcrOiChange, 2);
  assert.equal(rows[0].values.topContracts[0].optionType, 'PE');
});
