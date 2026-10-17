'use strict';

// Slice 7 evaluator. Pure functions, so these run with no network and no database.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STATUS,
  RESULT,
  evaluateOutcome,
  scoreOutcomes,
  proposeConfigChange,
  planKind,
  movePct,
  PRICE_SOURCE,
} = require('../src/outcome');

const T0 = Date.parse('2026-10-14T05:00:00Z'); // Wednesday 10:30 IST
const at = (minutes) => new Date(T0 + minutes * 60000).toISOString();
const days = (n) => n * 86400000;

function signal(overrides = {}) {
  return {
    id: 'sig-1',
    horizon: 'SWING',
    symbol: 'NIFTY',
    direction: 'BULLISH',
    instrument: 'SPOT',
    entry: 100,
    target: 110,
    stop: 95,
    publishedAt: at(0),
    snapshot: { plan: { kind: 'SPOT' } },
    ...overrides,
  };
}

function evaluate(overrides = {}, path = [], options = {}) {
  return evaluateOutcome({
    signal: signal(overrides),
    path,
    holdingDays: 30,
    now: T0 + 60000,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Exit decisions
// ---------------------------------------------------------------------------

test('a long that reaches its target closes as TARGET at the target price', () => {
  const result = evaluate({}, [{ at: at(10), price: 100.5 }, { at: at(20), price: 111 }]);
  assert.equal(result.status, STATUS.CLOSED);
  assert.equal(result.result, RESULT.TARGET);
  assert.equal(result.exit, 110);
  assert.equal(result.pnlPct, 10);
  assert.equal(result.win, true);
  assert.equal(result.ambiguous, false);
  assert.equal(result.readings, 2);
});

test('a long that reaches its stop closes as STOP at the stop price', () => {
  const result = evaluate({}, [{ at: at(10), price: 94 }]);
  assert.equal(result.result, RESULT.STOP);
  assert.equal(result.exit, 95);
  assert.equal(result.pnlPct, -5);
  assert.equal(result.win, false);
});

test('a short that reaches its target closes as TARGET', () => {
  const result = evaluate({ direction: 'BEARISH', target: 90, stop: 105 }, [{ at: at(10), price: 89 }]);
  assert.equal(result.result, RESULT.TARGET);
  assert.equal(result.exit, 90);
  assert.equal(result.pnlPct, 10);
  assert.equal(result.win, true);
});

test('a short that reaches its stop closes as STOP', () => {
  const result = evaluate({ direction: 'BEARISH', target: 90, stop: 105 }, [{ at: at(10), price: 106 }]);
  assert.equal(result.result, RESULT.STOP);
  assert.equal(result.exit, 105);
  assert.equal(result.pnlPct, -5);
});

test('the first level reached wins, not the deepest one', () => {
  const result = evaluate({}, [
    { at: at(10), price: 96 },   // dips but holds above the stop
    { at: at(20), price: 111 },  // target
    { at: at(30), price: 90 },   // would have stopped out later
  ]);
  assert.equal(result.result, RESULT.TARGET);
  assert.equal(result.exit, 110);
});

test('a bar that touches both levels is adjudicated as the stop, and flagged ambiguous', () => {
  // Only a bar can reach both levels inside one reading, and we cannot know the order.
  const result = evaluate({}, [{ at: at(10), price: 100, high: 112, low: 93 }]);
  assert.equal(result.result, RESULT.STOP);
  assert.equal(result.exit, 95);
  assert.equal(result.pnlPct, -5);
  assert.equal(result.ambiguous, true);
});

test('a bare price is its own high and low, so it can never be ambiguous', () => {
  const result = evaluate({}, [{ at: at(10), price: 111 }]);
  assert.equal(result.ambiguous, false);
  assert.equal(result.result, RESULT.TARGET);
});

// ---------------------------------------------------------------------------
// The holding window
// ---------------------------------------------------------------------------

test('a position with no level reached inside the window stays OPEN', () => {
  const result = evaluate({}, [{ at: at(10), price: 100.5 }], { now: T0 + 3600000, holdingDays: 30 });
  assert.equal(result.status, STATUS.OPEN);
  assert.equal(result.readings, 1);
  assert.equal(result.lastPrice, 100.5);
});

test('a position with no price readings at all stays OPEN', () => {
  const result = evaluate({}, []);
  assert.equal(result.status, STATUS.OPEN);
  assert.equal(result.readings, 0);
});

test('a position that is never priced is settled with no verdict once its window elapses', () => {
  const result = evaluate({}, [], { now: T0 + days(31), holdingDays: 30 });
  assert.equal(result.status, STATUS.CLOSED);
  assert.equal(result.result, RESULT.NO_PRICE_SOURCE);
  assert.equal(result.unpriced, true);
  assert.equal(result.pnlPct, null);
  assert.equal(result.exit, null);
  assert.match(result.reason, /no price source/);
});

test('an expired window that never touched a level closes as TIME at the last price in the window', () => {
  const result = evaluate({}, [{ at: at(10), price: 101 }], {
    now: T0 + days(2),
    holdingDays: 1,
  });
  assert.equal(result.status, STATUS.CLOSED);
  assert.equal(result.result, RESULT.TIME);
  assert.equal(result.exit, 101);
  assert.equal(result.pnlPct, 1);
  assert.equal(result.windowDays, 1);
});

test('a TIME exit ignores readings that arrived after the window closed', () => {
  const result = evaluate({}, [
    { at: at(10), price: 101 },      // inside the one-day window
    { at: at(60 * 24 * 3), price: 108 }, // three days later, outside it
  ], { now: T0 + days(4), holdingDays: 1 });
  assert.equal(result.result, RESULT.TIME);
  assert.equal(result.exit, 101, 'the window end is the mark, not the later drift');
});

test('readings recorded before publication are ignored', () => {
  const result = evaluate({}, [{ at: at(-10), price: 150 }, { at: at(10), price: 100.5 }], {
    now: T0 + 3600000,
  });
  assert.equal(result.status, STATUS.OPEN, 'the pre-publication spike at 150 is not a target hit');
});

test('readings are ordered by time before being walked', () => {
  const result = evaluate({}, [
    { at: at(20), price: 111 }, // target, later
    { at: at(10), price: 94 },  // stop, earlier
  ]);
  assert.equal(result.result, RESULT.STOP, 'the earlier reading decides');
});

// ---------------------------------------------------------------------------
// Excursion
// ---------------------------------------------------------------------------

test('MFE and MAE are measured from the readings up to the exit, using a bar own extremes', () => {
  const result = evaluate({ stop: 90 }, [
    { at: at(10), price: 102, high: 105, low: 97 },
    { at: at(20), price: 110, high: 112, low: 100 },
  ]);
  assert.equal(result.result, RESULT.TARGET);
  assert.equal(result.mfePct, 12, 'the best the trade ever showed');
  assert.equal(result.maePct, -3, 'the worst it ever showed');
  assert.equal(result.pnlPct, 10, 'but it was closed at the target');
});

test('MFE and MAE ignore what happened after the exit', () => {
  const result = evaluate({ stop: 90 }, [
    { at: at(10), price: 110, high: 120, low: 100 }, // exits at target here
    { at: at(20), price: 100, high: 130, low: 80 },  // later noise must not count
  ]);
  assert.equal(result.mfePct, 20);
  assert.equal(result.maePct, 0);
});

test('a short excursion is direction-aware', () => {
  const result = evaluate({ direction: 'BEARISH', target: 90, stop: 105 }, [
    { at: at(10), price: 90, high: 103, low: 88 },
  ]);
  assert.equal(result.result, RESULT.TARGET);
  assert.equal(result.mfePct, 12, 'favourable for a short is a fall');
  assert.equal(result.maePct, -3, 'adverse for a short is a rise');
});

// ---------------------------------------------------------------------------
// Refusals - the cases where scoring would be dishonest
// ---------------------------------------------------------------------------

test('a neutral direction is UNEVALUABLE', () => {
  const result = evaluate({ direction: 'NEUTRAL' });
  assert.equal(result.status, STATUS.UNEVALUABLE);
  assert.match(result.reason, /not tradable/);
});

test('a signal with no entry price is UNEVALUABLE', () => {
  const result = evaluate({ entry: null });
  assert.equal(result.status, STATUS.UNEVALUABLE);
  assert.match(result.reason, /entry/);
});

test('a signal missing its stop is UNEVALUABLE', () => {
  const result = evaluate({ stop: null });
  assert.equal(result.status, STATUS.UNEVALUABLE);
  assert.match(result.reason, /target or a stop/);
});

test('a long plan whose levels are out of order is UNEVALUABLE', () => {
  const result = evaluate({ target: 90, stop: 95 });
  assert.equal(result.status, STATUS.UNEVALUABLE);
  assert.match(result.reason, /out of order/);
});

test('a short plan whose levels are out of order is UNEVALUABLE', () => {
  const result = evaluate({ direction: 'BEARISH', target: 110, stop: 90 });
  assert.equal(result.status, STATUS.UNEVALUABLE);
  assert.match(result.reason, /out of order/);
});

test('a signal with no publication time is UNEVALUABLE', () => {
  const result = evaluate({ publishedAt: null });
  assert.equal(result.status, STATUS.UNEVALUABLE);
  assert.match(result.reason, /publication time/);
});

test('an option-premium plan is reported as awaiting a price source, never scored on spot', () => {
  const result = evaluate({ instrument: 'OPTION', strike: 22000, option_type: 'CE' }, [
    { at: at(10), price: 111 },
  ]);
  assert.equal(result.status, STATUS.AWAITING_PRICE_SOURCE);
  assert.match(result.reason, /option quote history/);
});

test('an option-premium plan is settled once its window elapses, not left open forever', () => {
  const result = evaluate(
    { instrument: 'OPTION', strike: 22000, option_type: 'CE' },
    [{ at: at(10), price: 111 }],
    { now: T0 + days(31), holdingDays: 30 },
  );
  assert.equal(result.status, STATUS.CLOSED);
  assert.equal(result.result, RESULT.NO_PRICE_SOURCE);
  assert.equal(result.pnlPct, null);
  assert.equal(result.readings, 0);
});

// Slice 8: option premiums are persisted, so an option plan is scored - against the premium series
// it actually trades on, which is the whole point of keeping the two series apart.
test('an option-premium plan is scored against its own premium series', () => {
  const result = evaluate(
    { instrument: 'OPTION', strike: 22000, option_type: 'CE' },
    [{ at: at(5), price: 104 }, { at: at(20), price: 118 }, { at: at(30), price: 121 }],
    { priceSource: PRICE_SOURCE.OPTION },
  );
  assert.equal(result.status, STATUS.CLOSED);
  assert.equal(result.result, RESULT.TARGET);
  // The plan levels are premiums (target 110), and so are the readings.
  assert.equal(result.exit, 110);
  assert.equal(result.pnlPct, 10);
  assert.equal(result.kind, 'OPTION');
  assert.equal(result.priceSource, PRICE_SOURCE.OPTION);
  assert.equal(result.readings, 2); // the two readings up to the exit
});

test('an option-premium plan is still refused a spot series even when it carries readings', () => {
  const spotPath = [{ at: at(5), price: 111 }];
  assert.equal(evaluate({ instrument: 'OPTION', strike: 22000, option_type: 'CE' }, spotPath).status, STATUS.AWAITING_PRICE_SOURCE);
  assert.equal(
    evaluate({ instrument: 'OPTION', strike: 22000, option_type: 'CE' }, spotPath, { priceSource: PRICE_SOURCE.UNDERLYING }).status,
    STATUS.AWAITING_PRICE_SOURCE,
  );
});

test('an underlying plan offered an option-premium series is unevaluable, never scored on it', () => {
  const result = evaluate({}, [{ at: at(5), price: 111 }], { priceSource: PRICE_SOURCE.OPTION });
  assert.equal(result.status, STATUS.UNEVALUABLE);
  assert.match(result.reason, /option-premium price series/);
  assert.equal(result.kind, 'UNDERLYING');
});

test('planKind reads the explicit kind first, then the strike, then the instrument name', () => {
  assert.equal(planKind(signal(), null), 'UNDERLYING');
  assert.equal(planKind(signal(), { kind: 'SPOT' }), 'UNDERLYING');
  assert.equal(planKind(signal(), { kind: 'FUTURE' }), 'UNDERLYING');
  assert.equal(planKind(signal(), { kind: 'CE' }), 'OPTION');
  assert.equal(planKind(signal(), { kind: 'PE' }), 'OPTION');
  assert.equal(planKind(signal({ strike: 22000 }), null), 'OPTION');
  assert.equal(planKind(signal({ option_type: 'PE' }), null), 'OPTION');
  assert.equal(planKind(signal({ instrument: 'NIFTY 22000 CE' }), null), 'OPTION');
  assert.equal(planKind(signal({ instrument: 'EQUITY' }), null), 'UNDERLYING');
});

test('movePct is direction-aware', () => {
  assert.equal(movePct('BULLISH', 100, 110), 10);
  assert.equal(movePct('BEARISH', 100, 110), -10);
  assert.equal(movePct('BEARISH', 100, 90), 10);
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

test('scoring an empty set reports zeroes and nulls rather than dividing by nothing', () => {
  const stats = scoreOutcomes([]);
  assert.equal(stats.total, 0);
  assert.equal(stats.winRatePct, null);
  assert.equal(stats.expectancyPct, null);
});

test('scoring summarises wins, losses, expectancy and the median', () => {
  const stats = scoreOutcomes([
    { pnl_pct: 10, result: 'TARGET', horizon: 'SWING' },
    { pnl_pct: -5, result: 'STOP', horizon: 'SWING' },
    { pnl_pct: 2, result: 'TIME', horizon: 'INTRADAY' },
    { pnl_pct: -3, result: 'STOP', horizon: 'INTRADAY' },
  ]);
  assert.equal(stats.total, 4);
  assert.equal(stats.wins, 2);
  assert.equal(stats.losses, 2);
  assert.equal(stats.winRatePct, 50);
  assert.equal(stats.avgPnlPct, 1);
  assert.equal(stats.medianPnlPct, -0.5);
  assert.equal(stats.totalPnlPct, 4);
  assert.equal(stats.avgWinPct, 6);
  assert.equal(stats.avgLossPct, -4);
  assert.equal(stats.expectancyPct, 1, '(0.5 * 6) + (0.5 * -4)');
  assert.deepEqual(stats.byResult, { TARGET: 1, STOP: 2, TIME: 1 });
  assert.equal(stats.byHorizon.SWING.total, 2);
  assert.equal(stats.byHorizon.INTRADAY.winRatePct, 50);
});

test('expectancy stays null until there is both a win and a loss to learn from', () => {
  const stats = scoreOutcomes([
    { pnl_pct: 5, result: 'TARGET', horizon: 'SWING' },
    { pnl_pct: 3, result: 'TARGET', horizon: 'SWING' },
  ]);
  assert.equal(stats.winRatePct, 100);
  assert.equal(stats.expectancyPct, null);
});

test('scoring averages the excursion columns under their unit-correct names', () => {
  const stats = scoreOutcomes([
    { pnl_pct: 10, result: 'TARGET', horizon: 'SWING', mfe_pct: 12, mae_pct: -3 },
    { pnl_pct: -5, result: 'STOP', horizon: 'SWING', mfe_pct: 4, mae_pct: -8 },
  ]);
  assert.equal(stats.avgMfePct, 8);
  assert.equal(stats.avgMaePct, -5.5);
});

// ---------------------------------------------------------------------------
// Proposals - the machine may suggest, never apply
// ---------------------------------------------------------------------------

const unhealthy = { total: 40, winRatePct: 30, expectancyPct: -0.5, avgLossPct: -3, avgMaePct: -5, avgWinPct: 4, byResult: {}, byHorizon: {} };

test('nothing is proposed below the minimum sample size', () => {
  const result = proposeConfigChange({ stats: { total: 12, winRatePct: 10 }, currentConfig: { config: { gates: { minConfidence: 0.4 } } } });
  assert.equal(result.proposed, false);
  assert.match(result.reason, /12 closed trade/);
});

test('nothing is proposed when the record is healthy', () => {
  const result = proposeConfigChange({
    stats: { ...unhealthy, winRatePct: 62, expectancyPct: 1.4, avgMaePct: -1 },
    currentConfig: { config: { gates: { minConfidence: 0.4 } } },
  });
  assert.equal(result.proposed, false);
  assert.match(result.reason, /no rule triggered/);
});

test('a weak record produces a tightening proposal that is a candidate, not a change', () => {
  const result = proposeConfigChange({
    stats: unhealthy,
    currentConfig: { config: { gates: { minConfidence: 0.4, maxOpenPerSymbol: 1 } } },
  });
  assert.equal(result.proposed, true);
  assert.equal(result.family, 'risk');
  assert.equal(result.change.path, 'gates.minConfidence');
  assert.equal(result.change.from, 0.4);
  assert.equal(result.change.to, 0.45);
  assert.equal(result.change.direction, 'tighten');
  assert.equal(result.config.gates.minConfidence, 0.45);
  assert.equal(result.config.gates.maxOpenPerSymbol, 1, 'untouched knobs are carried through');
  assert.match(result.reason, /win rate 30%/);
});

test('the proposal only ever tightens, and stops at the ceiling', () => {
  const result = proposeConfigChange({
    stats: unhealthy,
    currentConfig: { config: { gates: { minConfidence: 0.95 } } },
  });
  assert.equal(result.proposed, false);
  assert.match(result.reason, /ceiling/);
});

test('with no current config to amend, no proposal is made', () => {
  const result = proposeConfigChange({ stats: unhealthy, currentConfig: null });
  assert.equal(result.proposed, false);
  assert.match(result.reason, /no current risk config/);
});
