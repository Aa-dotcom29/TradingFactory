'use strict';

// Slice 5 risk gate. Pure functions, so these run with no network and no database.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_RISK_CONFIG,
  resolveRiskConfig,
  horizonValue,
  marketSession,
  istClock,
  istDayStart,
  summariseExposure,
  summariseOutcomes,
  lossStreak,
  weightedDailyReturn,
  evaluateRisk,
} = require('../src/risk');

const config = resolveRiskConfig(null);

// 2026-10-14 is a Wednesday; 2026-10-17 is a Saturday.
const WED_1030_IST = Date.parse('2026-10-14T05:00:00Z');
const WED_0830_IST = Date.parse('2026-10-14T03:00:00Z');
const WED_1600_IST = Date.parse('2026-10-14T10:30:00Z');
const SAT_1030_IST = Date.parse('2026-10-17T05:00:00Z');

function candidate(overrides = {}) {
  return {
    id: 'cand-1',
    as_of: new Date(WED_1030_IST - 5 * 60000).toISOString(),
    horizon: 'SWING',
    symbol: 'NIFTY',
    direction: 'BULLISH',
    confidence: 0.6,
    rr: 2,
    liquidity_ok: true,
    dedupe_key: 'SWING|NIFTY|BULLISH|SPOT|X|X|2026-10-14T05:00',
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    session: { open: true, reason: null },
    exposure: { byHorizon: {}, bySymbol: {}, lastPublished: {} },
    outcomes: { consecutiveLosses: null, dailyPnlPct: null, lastLossAt: null },
    ...overrides,
  };
}

function gate(result, name) {
  return result.checks.find((check) => check.gate === name);
}

test('resolveRiskConfig merges a partial stored config over the baseline', () => {
  const merged = resolveRiskConfig({
    version: 'risk-v9',
    gates: {
      minConfidence: 0.75,
      maxOpenPositions: { INTRADAY: 2 },
      session: { enforce: false },
    },
  });
  assert.equal(merged.version, 'risk-v9');
  assert.equal(merged.gates.minConfidence, 0.75);
  assert.equal(merged.gates.maxOpenPositions.INTRADAY, 2);
  assert.equal(merged.gates.maxOpenPositions.SWING, DEFAULT_RISK_CONFIG.gates.maxOpenPositions.SWING);
  assert.equal(merged.gates.session.enforce, false);
  assert.equal(merged.gates.session.openMinutes, DEFAULT_RISK_CONFIG.gates.session.openMinutes);
});

test('resolveRiskConfig tolerates junk without throwing', () => {
  assert.equal(resolveRiskConfig(null).version, DEFAULT_RISK_CONFIG.version);
  assert.equal(resolveRiskConfig('nonsense').gates.minConfidence, DEFAULT_RISK_CONFIG.gates.minConfidence);
  assert.equal(resolveRiskConfig({ gates: 'nope' }).gates.session.closeMinutes, 930);
  assert.equal(resolveRiskConfig({ gates: { maxOpenPositions: 'nope' } }).gates.maxOpenPositions.SWING, 8);
});

test('horizonValue reads the horizon key and falls back safely', () => {
  assert.equal(horizonValue({ INTRADAY: 0.5 }, 'INTRADAY', 0.1), 0.5);
  assert.equal(horizonValue({ INTRADAY: 0.5 }, 'SWING', 0.1), 0.1);
  assert.equal(horizonValue(null, 'SWING', 0.1), 0.1);
  assert.equal(horizonValue({ INTRADAY: 'junk' }, 'INTRADAY', 0.1), 0.1);
});

test('istClock reports the weekday and IST minutes, not the host timezone', () => {
  const clock = istClock(WED_1030_IST);
  assert.equal(clock.weekday, 3);
  assert.equal(clock.minutes, 630); // 10:30
  assert.equal(clock.date, '2026-10-14');
});

test('marketSession opens inside the NSE window and closes outside it', () => {
  assert.equal(marketSession(WED_1030_IST, config.gates.session).open, true);
  assert.equal(marketSession(WED_0830_IST, config.gates.session).open, false);
  assert.equal(marketSession(WED_0830_IST, config.gates.session).reason.includes('before'), true);
  assert.equal(marketSession(WED_1600_IST, config.gates.session).open, false);
  assert.equal(marketSession(WED_1600_IST, config.gates.session).reason.includes('after'), true);
});

test('marketSession keeps the weekend closed and names it', () => {
  const session = marketSession(SAT_1030_IST, config.gates.session);
  assert.equal(session.open, false);
  assert.equal(session.reason.includes('weekend'), true);
});

test('marketSession closes on a published holiday and names the date', () => {
  // 20 October 2026, Dussehra - a Tuesday, so nothing but the holiday list can close it. This is
  // the day the clock reported a live session, and the pipeline duly aged nothing, built tradeable
  // plans from the previous session's frozen prices, and approved them.
  const dussehra = Date.parse('2026-10-20T05:00:00Z'); // Tuesday 10:30 IST
  const session = marketSession(dussehra, config.gates.session);
  assert.equal(session.open, false);
  assert.equal(session.holiday, '2026-10-20');
  assert.match(session.reason, /holiday/);
});

test('a holiday list can be replaced wholesale from config without losing the rest of the session', () => {
  const replaced = resolveRiskConfig({ gates: { session: { holidays: ['2026-10-21'] } } });
  assert.deepEqual(replaced.gates.session.holidays, ['2026-10-21']);
  assert.equal(marketSession(Date.parse('2026-10-20T05:00:00Z'), replaced.gates.session).open, true);
  assert.equal(marketSession(Date.parse('2026-10-21T05:00:00Z'), replaced.gates.session).open, false);
  assert.equal(replaced.gates.session.openMinutes, 555);
  assert.equal(replaced.gates.session.closeMinutes, 930);
});

test('an empty holiday list degrades to the hours and the weekend, and does not invent a closure', () => {
  const none = resolveRiskConfig({ gates: { session: { holidays: [] } } });
  assert.equal(marketSession(Date.parse('2026-10-20T05:00:00Z'), none.gates.session).open, true);
});

test('istDayStart is IST midnight, so the daily-loss window is the trading day', () => {
  // 2026-10-17 07:30 IST == 02:00 UTC -> the day began at 2026-10-16T18:30:00Z.
  assert.equal(istDayStart(Date.parse('2026-10-17T02:00:00Z')), '2026-10-16T18:30:00.000Z');
  // 2026-10-17 01:30 IST == 2026-10-16T20:00:00Z -> still that same trading day, not the UTC one.
  assert.equal(istDayStart(Date.parse('2026-10-16T20:00:00Z')), '2026-10-16T18:30:00.000Z');
  // 2026-10-16 23:30 IST == 2026-10-16T18:00:00Z -> the previous trading day.
  assert.equal(istDayStart(Date.parse('2026-10-16T18:00:00Z')), '2026-10-15T18:30:00.000Z');
});

test('lossStreak reports null for no history and counts back to the first win', () => {
  assert.equal(lossStreak([]), null);
  assert.equal(lossStreak(null), null);
  assert.equal(lossStreak([{ pnl_pct: -1 }, { pnl_pct: -2 }, { pnl_pct: 3 }]), 2);
  assert.equal(lossStreak([{ pnl_pct: 1 }]), 0);
  assert.equal(lossStreak([{ result: 'STOPPED_OUT' }, { result: 'TARGET_HIT' }]), 1);
});

test('lossStreak skips a settled unpriced position instead of letting it end a streak', () => {
  const rows = [
    { result: 'NO_PRICE_SOURCE', pnl_pct: null }, // settled with no verdict, neither loss nor win
    { pnl_pct: -1 },
    { pnl_pct: -2 },
    { pnl_pct: 3 },
  ];
  assert.equal(lossStreak(rows), 2);
  // Administrative rows alone are still "no history", not "no losses".
  assert.equal(lossStreak([{ result: 'NO_PRICE_SOURCE', pnl_pct: null }]), null);
});

test('summariseExposure counts only positions inside the holding window', () => {
  const now = Date.parse('2026-10-14T05:00:00Z');
  const rows = [
    // Intraday from two days ago: outside a 1-day window.
    { horizon: 'INTRADAY', symbol: 'NIFTY', direction: 'BULLISH', published_at: new Date(now - 2 * 86400000).toISOString() },
    // Swing from a week ago: inside the 30-day window.
    { horizon: 'SWING', symbol: 'NIFTY', direction: 'BULLISH', published_at: new Date(now - 7 * 86400000).toISOString() },
    { horizon: 'SWING', symbol: 'TCS', direction: 'BEARISH', published_at: new Date(now - 86400000).toISOString() },
  ];
  const exposure = summariseExposure(rows, config, now);
  assert.equal(exposure.byHorizon.INTRADAY, undefined);
  assert.equal(exposure.byHorizon.SWING, 2);
  assert.equal(exposure.bySymbol['SWING|NIFTY'], 1);
  assert.equal(exposure.lastPublished['SWING|NIFTY|BULLISH'] !== undefined, true);
});

test('summariseOutcomes withholds a daily number when nothing closed today', () => {
  const empty = summariseOutcomes([], 0, null, 0);
  assert.equal(empty.consecutiveLosses, null);
  assert.equal(empty.dailyPnlPct, null);
  const fed = summariseOutcomes([{ pnl_pct: -1 }], -1.5, '2026-10-14T05:00:00Z', 2);
  assert.equal(fed.consecutiveLosses, 1);
  assert.equal(fed.dailyPnlPct, -1.5);
  assert.equal(fed.lastLossAt, '2026-10-14T05:00:00Z');
});

test('a complete, liquid, fresh candidate is approved and uncheckable gates say so', () => {
  const result = evaluateRisk({ candidate: candidate(), context: context(), config, now: WED_1030_IST });
  assert.equal(result.decision, 'APPROVED');
  assert.equal(result.approved, true);
  assert.deepEqual(result.reasons, ['every risk gate passed']);
  assert.deepEqual(result.bypassed, []);
  assert.equal(result.configVersion, 'risk-v1');
  // No closed trades exist yet, so the loss controls are honest SKIPPEDs rather than passes.
  assert.equal(gate(result, 'consecutiveLossHalt').status, 'SKIPPED');
  assert.equal(gate(result, 'dailyLossLimit').status, 'SKIPPED');
  assert.equal(gate(result, 'cooldownAfterLoss').status, 'SKIPPED');
  assert.equal(gate(result, 'liquidity').status, 'PASS');
});

test('a candidate below the confidence floor is rejected', () => {
  const result = evaluateRisk({
    candidate: candidate({ confidence: 0.2 }), context: context(), config, now: WED_1030_IST,
  });
  assert.equal(result.decision, 'REJECTED');
  assert.deepEqual(result.failures, ['confidence']);
  assert.equal(result.reasons[0].startsWith('confidence:'), true);
});

test('a candidate with no confidence or no reward:risk is rejected, never approved', () => {
  const noConfidence = evaluateRisk({
    candidate: candidate({ confidence: null }), context: context(), config, now: WED_1030_IST,
  });
  assert.equal(noConfidence.decision, 'REJECTED');
  const noRr = evaluateRisk({
    candidate: candidate({ rr: null }), context: context(), config, now: WED_1030_IST,
  });
  assert.equal(noRr.decision, 'REJECTED');
  assert.equal(noRr.failures.includes('rewardRisk'), true);
});

test('a candidate whose plan missed the liquidity floor is rejected', () => {
  const result = evaluateRisk({
    candidate: candidate({ liquidity_ok: false }), context: context(), config, now: WED_1030_IST,
  });
  assert.equal(result.decision, 'REJECTED');
  assert.equal(result.failures.includes('liquidity'), true);
});

test('the kill switch and a disabled gate both fail closed', () => {
  const killed = resolveRiskConfig({ gates: { killSwitch: true } });
  const result = evaluateRisk({ candidate: candidate(), context: context(), config: killed, now: WED_1030_IST });
  assert.equal(result.decision, 'REJECTED');
  assert.equal(result.failures.includes('killSwitch'), true);

  const off = resolveRiskConfig({ gates: { enabled: false } });
  const disabled = evaluateRisk({ candidate: candidate(), context: context(), config: off, now: WED_1030_IST });
  assert.equal(disabled.decision, 'REJECTED');
  assert.equal(disabled.failures.includes('enabled'), true);
});

test('an unknown horizon is rejected before anything else is trusted', () => {
  const result = evaluateRisk({
    candidate: candidate({ horizon: 'WEEKLY' }), context: context(), config, now: WED_1030_IST,
  });
  assert.equal(result.decision, 'REJECTED');
  assert.equal(result.failures.includes('horizon'), true);
});

test('a candidate raised outside the session is deferred, not rejected', () => {
  const result = evaluateRisk({
    candidate: candidate(),
    context: context({ session: { open: false, reason: 'after the NSE close (09:15-15:30 IST)' } }),
    config,
    now: WED_1030_IST,
  });
  assert.equal(result.decision, 'DEFERRED');
  assert.equal(result.approved, false);
  assert.deepEqual(result.deferred, ['session']);
  assert.equal(result.reasons[0].startsWith('session:'), true);
});

test('a real failure outranks a deferral', () => {
  const result = evaluateRisk({
    candidate: candidate({ confidence: 0.1 }),
    context: context({ session: { open: false, reason: 'weekend' } }),
    config,
    now: WED_1030_IST,
  });
  assert.equal(result.decision, 'REJECTED');
});

test('session enforcement can be switched off in config and says so', () => {
  const relaxed = resolveRiskConfig({ gates: { session: { enforce: false } } });
  const result = evaluateRisk({
    candidate: candidate(),
    context: context({ session: { open: false, reason: 'weekend' } }),
    config: relaxed,
    now: WED_1030_IST,
  });
  assert.equal(result.decision, 'APPROVED');
  assert.equal(gate(result, 'session').status, 'SKIPPED');
  // The approval leaned on a control switched off in config, so it must name the bypass rather
  // than read like an ordinary pass. (This is the shape the four after-hours rows lacked.)
  assert.equal(gate(result, 'session').bypassed, true);
  assert.deepEqual(result.bypassed, ['session']);
  assert.equal(result.reasons.some((line) => line.includes('controls switched off in config')), true);
});

test('a switched-off liquidity control is named as a bypass too', () => {
  const relaxed = resolveRiskConfig({ gates: { liquidityRequired: false } });
  const result = evaluateRisk({ candidate: candidate(), context: context(), config: relaxed, now: WED_1030_IST });
  assert.equal(result.decision, 'APPROVED');
  assert.equal(gate(result, 'liquidity').status, 'SKIPPED');
  assert.deepEqual(result.bypassed, ['liquidity']);
  assert.equal(result.reasons.some((line) => line.includes('controls switched off in config')), true);
});

test('a stale candidate is rejected', () => {
  const result = evaluateRisk({
    candidate: candidate({ as_of: new Date(WED_1030_IST - 3 * 86400000).toISOString() }),
    context: context(),
    config,
    now: WED_1030_IST,
  });
  assert.equal(result.decision, 'REJECTED');
  assert.equal(result.failures.includes('freshness'), true);
});

test('a candidate with no timestamp is rejected rather than waved through', () => {
  const result = evaluateRisk({
    candidate: candidate({ as_of: null, created_at: null }),
    context: context(),
    config,
    now: WED_1030_IST,
  });
  assert.equal(result.decision, 'REJECTED');
  assert.equal(result.failures.includes('freshness'), true);
});

test('the exposure caps reject a name that is already at the limit', () => {
  const horizonFull = evaluateRisk({
    candidate: candidate(),
    context: context({
      exposure: { byHorizon: { SWING: 8 }, bySymbol: {}, lastPublished: {} },
    }),
    config,
    now: WED_1030_IST,
  });
  assert.equal(horizonFull.decision, 'REJECTED');
  assert.equal(horizonFull.failures.includes('openPositions'), true);

  const symbolFull = evaluateRisk({
    candidate: candidate(),
    context: context({
      exposure: { byHorizon: { SWING: 1 }, bySymbol: { 'SWING|NIFTY': 1 }, lastPublished: {} },
    }),
    config,
    now: WED_1030_IST,
  });
  assert.equal(symbolFull.decision, 'REJECTED');
  assert.equal(symbolFull.failures.includes('symbolExposure'), true);
});

test('a repeat of a call published minutes ago is suppressed', () => {
  const result = evaluateRisk({
    candidate: candidate(),
    context: context({
      exposure: {
        byHorizon: { SWING: 1 },
        bySymbol: { 'SWING|NIFTY': 1 },
        lastPublished: { 'SWING|NIFTY|BULLISH': new Date(WED_1030_IST - 5 * 60000).toISOString() },
      },
    }),
    config,
    now: WED_1030_IST,
  });
  assert.equal(result.decision, 'REJECTED');
  assert.equal(result.failures.includes('duplicateWindow'), true);
});

test('the loss controls reject once the history feeds them', () => {
  const halting = evaluateRisk({
    candidate: candidate(),
    context: context({ outcomes: { consecutiveLosses: 3, dailyPnlPct: 0, lastLossAt: null } }),
    config,
    now: WED_1030_IST,
  });
  assert.equal(halting.decision, 'REJECTED');
  assert.equal(halting.failures.includes('consecutiveLossHalt'), true);

  const cooled = evaluateRisk({
    candidate: candidate(),
    context: context({
      outcomes: { consecutiveLosses: 1, dailyPnlPct: 0, lastLossAt: new Date(WED_1030_IST - 5 * 60000).toISOString() },
    }),
    config,
    now: WED_1030_IST,
  });
  assert.equal(cooled.decision, 'REJECTED');
  assert.equal(cooled.failures.includes('cooldownAfterLoss'), true);

  const daily = evaluateRisk({
    candidate: candidate(),
    context: context({ outcomes: { consecutiveLosses: 1, dailyPnlPct: -4, lastLossAt: null } }),
    config,
    now: WED_1030_IST,
  });
  assert.equal(daily.decision, 'REJECTED');
  assert.equal(daily.failures.includes('dailyLossLimit'), true);
});

test('an empty context still yields a decision rather than throwing', () => {
  const result = evaluateRisk({ candidate: candidate(), context: {}, config, now: WED_1030_IST });
  assert.equal(['APPROVED', 'REJECTED', 'DEFERRED'].includes(result.decision), true);
});

test('the verdict is deterministic for the same inputs', () => {
  const first = evaluateRisk({ candidate: candidate(), context: context(), config, now: WED_1030_IST });
  const second = evaluateRisk({ candidate: candidate(), context: context(), config, now: WED_1030_IST });
  assert.deepEqual(first, second);
});

test('every check carries a known status and a detail line', () => {
  const result = evaluateRisk({ candidate: candidate(), context: context(), config, now: WED_1030_IST });
  assert.equal(result.checks.length >= 12, true);
  for (const check of result.checks) {
    assert.equal(['PASS', 'FAIL', 'DEFER', 'SKIPPED'].includes(check.status), true);
    assert.equal(typeof check.detail, 'string');
    assert.equal(check.detail.length > 0, true);
  }
});

test('a loss only counts toward the halt when it was material', () => {
  // A run of trivial stops must not be able to switch the system off for the
  // day, and a genuine run of real losses must still halt it.
  const trivial = [{ pnl_pct: -0.4 }, { pnl_pct: -0.4 }, { pnl_pct: -0.4 }];
  assert.equal(lossStreak(trivial, 1), 0);
  const real = [{ pnl_pct: -30 }, { pnl_pct: -35 }, { pnl_pct: -25 }];
  assert.equal(lossStreak(real, 1), 3);
  // With no threshold the behaviour is unchanged: every loss counts.
  assert.equal(lossStreak(trivial, 0), 3);
});

test('a position that never had a price is not a loss in the streak', () => {
  const rows = [{ pnl_pct: null, result: 'NO_PRICE_SOURCE' }, { pnl_pct: -12 }];
  assert.equal(lossStreak(rows, 1), 1);
});

test('the daily return is weighted by capital, not a sum of percentages', () => {
  // Three 1% losses are a 1% day, not a 3% day. The old raw sum would have
  // read -3% and tripped a 3% limit on its own.
  const rows = [
    { pnl_pct: -1, entry: 1000 },
    { pnl_pct: -1, entry: 1000 },
    { pnl_pct: -1, entry: 1000 },
  ];
  assert.equal(weightedDailyReturn(rows), -1);
  // A big loss on a big position dominates a small loss on a small one.
  const mixed = [
    { pnl_pct: -30, entry: 10000 },
    { pnl_pct: -1, entry: 100 },
  ];
  assert.equal(weightedDailyReturn(mixed), -29.71);
  // Nothing priced means nothing to report.
  assert.equal(weightedDailyReturn([]), null);
  assert.equal(weightedDailyReturn([{ pnl_pct: null, entry: 100 }]), null);
});

test('the same name in another horizon is the same money', () => {
  const rows = [
    { horizon: 'INTRADAY', symbol: 'BANKNIFTY', published_at: '2026-10-21T04:11:09Z' },
    { horizon: 'SWING', symbol: 'BANKNIFTY', published_at: '2026-10-21T04:11:09Z' },
    { horizon: 'POSITIONAL', symbol: 'BANKNIFTY', published_at: '2026-10-21T04:11:09Z' },
  ];
  const exposure = summariseExposure(rows, config, Date.parse('2026-10-21T06:00:00Z'));
  assert.equal(exposure.bySymbolAnyHorizon.BANKNIFTY, 3);
  assert.equal(exposure.bySymbol['INTRADAY|BANKNIFTY'], 1);
});
