'use strict';

// Slice 4 signal builder. Pure functions, so these run with no network and no database.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_SIGNAL_CONFIG,
  resolveSignalConfig,
  horizonValue,
  underlyingPrice,
  selectContract,
  liquidityCheck,
  buildPlan,
  planSignature,
  computeStage,
  isStageMaterialChange,
  candidateDedupeKey,
  isOwnedStage,
} = require('../src/signals');

const config = resolveSignalConfig(null);

const CE = { kind: 'OPTION', optionType: 'CE', contract: 'NIFTY-CE-25000', strike: 25000, expiry: '27OCT2026', price: 120, oi: 20000, volume: 5000, oiChange: 1000, read: 'LONG BUILDUP' };
const PE = { kind: 'OPTION', optionType: 'PE', contract: 'NIFTY-PE-25000', strike: 25000, expiry: '27OCT2026', price: 110, oi: 18000, volume: 4000, oiChange: 800, read: 'SHORT COVERING' };

const FLOW = {
  underlyingPrice: 25000,
  underlyingVolume: 900000,
  optionCount: 6,
  topContracts: [CE, PE],
};

test('resolveSignalConfig merges a partial stored config over the baseline', () => {
  const merged = resolveSignalConfig({
    version: 'signal-v9',
    plan: { premiumStopPct: { INTRADAY: 0.1 } },
    stages: { readyConfidence: 0.6 },
  });
  assert.equal(merged.version, 'signal-v9');
  assert.equal(merged.plan.premiumStopPct.INTRADAY, 0.1);
  assert.equal(merged.plan.premiumStopPct.SWING, DEFAULT_SIGNAL_CONFIG.plan.premiumStopPct.SWING);
  assert.equal(merged.stages.readyConfidence, 0.6);
  assert.equal(merged.stages.scoreDelta, DEFAULT_SIGNAL_CONFIG.stages.scoreDelta);
});

test('resolveSignalConfig tolerates junk without throwing', () => {
  assert.equal(resolveSignalConfig(null).version, DEFAULT_SIGNAL_CONFIG.version);
  assert.equal(resolveSignalConfig('nonsense').stages.readyConfidence, DEFAULT_SIGNAL_CONFIG.stages.readyConfidence);
  assert.equal(resolveSignalConfig({ plan: 'nope' }).plan.strikeSearchPct, DEFAULT_SIGNAL_CONFIG.plan.strikeSearchPct);
});

test('horizonValue reads the horizon key and falls back safely', () => {
  assert.equal(horizonValue({ INTRADAY: 0.5 }, 'INTRADAY', 0.1), 0.5);
  assert.equal(horizonValue({ INTRADAY: 0.5 }, 'SWING', 0.1), 0.1);
  assert.equal(horizonValue(null, 'SWING', 0.1), 0.1);
  assert.equal(horizonValue({ SWING: 'abc' }, 'SWING', 0.1), 0.1);
});

test('underlyingPrice prefers the broker quote, then the NSE underlying value', () => {
  assert.deepEqual(underlyingPrice({ underlyingPrice: 24900 }, { ltp: 25010 }), { price: 25010, source: 'quote' });
  assert.deepEqual(underlyingPrice({ underlyingPrice: 24900 }, null), { price: 24900, source: 'nse-underlying' });
  assert.deepEqual(underlyingPrice(null, { close: 100 }), { price: null, source: null });
  assert.deepEqual(underlyingPrice({ underlyingPrice: 0 }, null), { price: null, source: null });
});

test('selectContract picks the at-the-money strike on the verdict side', () => {
  const call = selectContract({ direction: 'BULLISH', spot: 25020, flow: FLOW, config });
  const put = selectContract({ direction: 'BEARISH', spot: 25020, flow: FLOW, config });
  assert.equal(call.ok, true);
  assert.equal(call.optionType, 'CE');
  assert.equal(call.contract.strike, 25000);
  assert.equal(put.optionType, 'PE');
});

test('selectContract prefers the nearer of two surfaced strikes', () => {
  const flow = {
    topContracts: [
      { ...CE, strike: 25200, volume: 9000 },
      { ...CE, strike: 25050, volume: 100 },
    ],
  };
  const picked = selectContract({ direction: 'BULLISH', spot: 25000, flow, config });
  assert.equal(picked.contract.strike, 25050); // 50 away beats 200 away even at lower volume
});

test('selectContract refuses a strike outside the search band', () => {
  const flow = { topContracts: [{ ...CE, strike: 27000 }] };
  const picked = selectContract({ direction: 'BULLISH', spot: 25000, flow, config });
  assert.equal(picked.ok, false);
  assert.match(picked.reason, /outside the 3% band/);
});

test('selectContract refuses when no contract is on the verdict side', () => {
  const picked = selectContract({ direction: 'BEARISH', spot: 25000, flow: { topContracts: [CE] }, config });
  assert.equal(picked.ok, false);
  assert.match(picked.reason, /no PE strike/);
});

test('liquidityCheck reports every floor that failed', () => {
  const thin = liquidityCheck({ contract: { ...CE, oi: 10, volume: 5 }, flow: { optionCount: 1 }, config });
  assert.equal(thin.ok, false);
  assert.equal(thin.reasons.length, 3);

  const fine = liquidityCheck({ contract: CE, flow: FLOW, config });
  assert.equal(fine.ok, true);
  assert.deepEqual(fine.reasons, []);
});

test('buildPlan prices an option plan from the premium', () => {
  const built = buildPlan({
    symbol: 'NIFTY', horizon: 'INTRADAY', direction: 'BULLISH', flow: FLOW, quote: null, config,
  });
  assert.equal(built.ok, true);
  assert.equal(built.plan.kind, 'OPTION');
  assert.equal(built.plan.instrument, 'NIFTY 27OCT2026 25000 CE');
  assert.equal(built.plan.entry, 120);
  assert.equal(built.plan.stop, 90); // 120 * (1 - 0.25)
  assert.equal(built.plan.target, 165); // 120 * (1 + 0.25 * 1.5)
  assert.equal(built.plan.rr, 1.5);
  assert.equal(built.plan.liquidity.ok, true);
  assert.equal(built.plan.spotSource, 'nse-underlying');
});

test('buildPlan uses a broker quote for spot when present', () => {
  const built = buildPlan({
    symbol: 'NIFTY', horizon: 'INTRADAY', direction: 'BULLISH', flow: FLOW, quote: { ltp: 25100 }, config,
  });
  assert.equal(built.plan.spot, 25100);
  assert.equal(built.plan.spotSource, 'quote');
  // Strike is still chosen from the flow contracts, not the quote.
  assert.equal(built.plan.strike, 25000);
});

test('buildPlan returns an illiquid plan rather than pretending it is tradeable', () => {
  const flow = { ...FLOW, topContracts: [{ ...CE, oi: 10, volume: 5 }] };
  const built = buildPlan({
    symbol: 'NIFTY', horizon: 'INTRADAY', direction: 'BULLISH', flow, quote: null, config,
  });
  assert.equal(built.ok, false);
  assert.equal(built.plan.kind, 'OPTION');
  assert.equal(built.plan.liquidity.ok, false);
  assert.match(built.reason, /liquidity/);
});

test('buildPlan has no plan without a price to anchor the strike', () => {
  const built = buildPlan({
    symbol: 'NIFTY', horizon: 'INTRADAY', direction: 'BULLISH', flow: { topContracts: [CE] }, quote: null, config,
  });
  assert.equal(built.ok, false);
  assert.equal(built.plan, null);
  assert.match(built.reason, /no underlying price/);
});

test('buildPlan falls back to a level plan when no option contract can be anchored', () => {
  const flow = { underlyingPrice: 25000, underlyingVolume: 500000, optionCount: 0, topContracts: [] };
  const bull = buildPlan({ symbol: 'NIFTY', horizon: 'INTRADAY', direction: 'BULLISH', flow, quote: null, config });
  assert.equal(bull.ok, true);
  assert.equal(bull.plan.kind, 'SPOT');
  assert.equal(bull.plan.entry, 25000);
  assert.equal(bull.plan.stop, 24900); // 25000 * (1 - 0.004)
  assert.equal(bull.plan.target, 25150); // 25000 * (1 + 0.004 * 1.5)

  const bear = buildPlan({ symbol: 'NIFTY', horizon: 'INTRADAY', direction: 'BEARISH', flow, quote: null, config });
  assert.equal(bear.plan.stop, 25100);
  assert.equal(bear.plan.target, 24850);
});

test('buildPlan honours spotFallback: false', () => {
  const noFallback = resolveSignalConfig({ plan: { spotFallback: false } });
  const flow = { underlyingPrice: 25000, underlyingVolume: 500000, optionCount: 0, topContracts: [] };
  const built = buildPlan({
    symbol: 'NIFTY', horizon: 'INTRADAY', direction: 'BULLISH', flow, quote: null, config: noFallback,
  });
  assert.equal(built.ok, false);
  assert.equal(built.plan, null);
});

test('computeStage walks IDLE -> WATCH -> BUILDING -> READY', () => {
  const plan = buildPlan({
    symbol: 'NIFTY', horizon: 'INTRADAY', direction: 'BULLISH', flow: FLOW, quote: null, config,
  }).plan;

  const idle = computeStage({
    verdict: { direction: 'NEUTRAL', score: 0, confidence: 0 }, plan, config,
  });
  assert.equal(idle.stage, 'IDLE');

  const noPlan = computeStage({
    verdict: { direction: 'BULLISH', score: 0.5, confidence: 0.9 },
    plan: null,
    planReason: 'no underlying price',
    config,
  });
  assert.equal(noPlan.stage, 'WATCH');
  assert.ok(noPlan.reasons.some((r) => r.includes('no underlying price')));

  const illiquid = computeStage({
    verdict: { direction: 'BULLISH', score: 0.5, confidence: 0.9 },
    plan: { ...plan, liquidity: { ok: false, reasons: ['thin'] } },
    config,
  });
  assert.equal(illiquid.stage, 'WATCH');

  const building = computeStage({
    verdict: { direction: 'BULLISH', score: 0.5, confidence: 0.3 }, plan, config,
  });
  assert.equal(building.stage, 'BUILDING');
  assert.equal(building.liquidityOk, true);

  const ready = computeStage({
    verdict: { direction: 'BULLISH', score: 0.5, confidence: 0.4 }, plan, config,
  });
  assert.equal(ready.stage, 'READY');
});

test('planSignature changes when the trade changes', () => {
  const plan = buildPlan({
    symbol: 'NIFTY', horizon: 'INTRADAY', direction: 'BULLISH', flow: FLOW, quote: null, config,
  }).plan;
  const same = { ...plan };
  const moved = { ...plan, entry: 130, target: 175 };
  assert.equal(planSignature(plan), planSignature(same));
  assert.notEqual(planSignature(plan), planSignature(moved));
  assert.equal(planSignature(null), 'none');
});

test('isStageMaterialChange only fires on a real change or staleness', () => {
  const gate = config.stages;
  const now = Date.parse('2026-10-16T12:00:00.000Z');
  const previous = {
    stage: 'BUILDING', direction: 'BULLISH', score: 0.5, plan_signature: 'a', as_of: new Date(now - 60000),
  };
  const same = { stage: 'BUILDING', direction: 'BULLISH', score: 0.51, planSignature: 'a' };
  assert.equal(isStageMaterialChange(previous, same, gate, now), false);
  assert.equal(isStageMaterialChange(previous, { ...same, score: 0.6 }, gate, now), true);
  assert.equal(isStageMaterialChange(previous, { ...same, stage: 'READY' }, gate, now), true);
  assert.equal(isStageMaterialChange(previous, { ...same, planSignature: 'b' }, gate, now), true);
  assert.equal(isStageMaterialChange(previous, { ...same, direction: 'BEARISH' }, gate, now), true);
  assert.equal(isStageMaterialChange(null, same, gate, now), true);

  const stale = { ...previous, as_of: new Date(now - 20 * 60000) };
  assert.equal(isStageMaterialChange(stale, same, gate, now), true);
});

test('candidateDedupeKey is stable within a minute and distinct across plans', () => {
  const plan = buildPlan({
    symbol: 'NIFTY', horizon: 'INTRADAY', direction: 'BULLISH', flow: FLOW, quote: null, config,
  }).plan;
  const base = { horizon: 'INTRADAY', symbol: 'NIFTY', direction: 'BULLISH', plan };
  const at = Date.parse('2026-10-16T12:00:10.000Z');
  assert.equal(
    candidateDedupeKey({ ...base, readyAt: at }),
    candidateDedupeKey({ ...base, readyAt: at + 5000 }), // same minute bucket
  );
  assert.notEqual(
    candidateDedupeKey({ ...base, readyAt: at }),
    candidateDedupeKey({ ...base, readyAt: at + 60000 }),
  );
  assert.notEqual(
    candidateDedupeKey({ ...base, readyAt: at }),
    candidateDedupeKey({ ...base, plan: { ...plan, strike: 25100 }, readyAt: at }),
  );
});

test('isOwnedStage separates W4 stages from downstream ones', () => {
  assert.equal(isOwnedStage('READY'), true);
  assert.equal(isOwnedStage('WATCH'), true);
  assert.equal(isOwnedStage('ACTIVE'), false);
  assert.equal(isOwnedStage('BLOCKED'), false);
  assert.equal(isOwnedStage('EXITED'), false);
});
