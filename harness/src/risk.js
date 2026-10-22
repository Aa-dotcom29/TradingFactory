'use strict';

// Slice 5 - the risk gate. Pure functions only: no network, no database, no model.
//
// Every trade candidate the signal builder raises has to pass through here before it can become
// a published signal. The gate answers one question - "may this specific proposal be shown to
// the household right now?" - and it answers it the same way every time, from stored data.
//
// Three rules shape it:
//
//   1. Fail-closed. A missing input is never an approval. A gate that cannot be evaluated
//      because the data does not exist is reported as SKIPPED and the fact is recorded, so
//      "we could not check this" is never silently the same as "this passed".
//   2. The limits are data. They live in `config_registry` under the `risk` family, so a
//      threshold change is a reviewable row, not a deploy.
//   3. The gate lives in the worker. No dashboard route can relax it: the worker reads the
//      registry directly, and no API writes these limits.
//
// A proposal ends in one of three places:
//
//   APPROVED  - every gate passed; it may be published.
//   REJECTED  - at least one gate failed; it is recorded and never published.
//   DEFERRED  - nothing failed, but the market is closed, so there is nothing to do yet. The
//               proposal stays pending and is re-evaluated on the next tick.

const { HORIZONS } = require('./topics');
const { DEFAULT_SESSION, istClock, marketSession, istDayStart } = require('./session');

const CHECK_STATES = ['PASS', 'FAIL', 'DEFER', 'SKIPPED'];
const DECISIONS = ['APPROVED', 'REJECTED', 'DEFERRED'];

const num = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const round = (value, digits = 2) => (Number.isFinite(value) ? +value.toFixed(digits) : null);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const DEFAULT_RISK_CONFIG = {
  version: 'risk-v1',
  gates: {
    // false stops all publishing (fail-closed). A maintenance switch, never a bypass.
    enabled: true,
    killSwitch: false,
    session: { ...DEFAULT_SESSION },
    minConfidence: 0.4,
    minRewardRisk: 1.5,
    liquidityRequired: true,
    maxOpenPositions: { INTRADAY: 5, SWING: 8, POSITIONAL: 10 },
    maxOpenPerSymbol: 1,
    // The same name across different horizons is still the same money. A
    // per-horizon cap cannot see that: one household, one account, one
    // name at a time.
    maxOpenPerSymbolAnyHorizon: 1,
    duplicateWindowMinutes: 30,
    maxCandidateAgeMinutes: { INTRADAY: 120, SWING: 2880, POSITIONAL: 10080 },
    dailyLossLimitPct: 3,
    consecutiveLossHalt: 3,
    cooldownAfterLossMinutes: 60,
    // A loss only counts toward the halt and the cooldown when it was this big
    // or bigger. A 0.4% stop is noise: counting it against a three-loss halt
    // lets a run of trivial stops switch the whole system off for the day.
    lossMaterialPct: 1,
    // How long a published signal is treated as an open position for the exposure gates. The
    // evaluator (W7) will close positions properly; until then this window is the ledger.
    holdingDays: { INTRADAY: 1, SWING: 30, POSITIONAL: 180 },
  },
};

const PER_HORIZON_MAPS = ['maxOpenPositions', 'maxCandidateAgeMinutes', 'holdingDays'];

function resolveRiskConfig(candidate) {
  const stored = candidate && typeof candidate === 'object' ? candidate : {};
  const merged = { version: DEFAULT_RISK_CONFIG.version, ...stored };
  merged.gates = { ...DEFAULT_RISK_CONFIG.gates, ...(stored.gates || {}) };
  merged.gates.session = {
    ...DEFAULT_RISK_CONFIG.gates.session,
    ...((stored.gates && stored.gates.session) || {}),
  };
  for (const map of PER_HORIZON_MAPS) {
    merged.gates[map] = {
      ...DEFAULT_RISK_CONFIG.gates[map],
      ...((stored.gates && stored.gates[map]) || {}),
    };
  }
  if (!merged.version) merged.version = DEFAULT_RISK_CONFIG.version;
  return merged;
}

// Reads a horizon-keyed map with a safe fallback, so a half-written config row cannot lift a
// cap or zero an age limit.
function horizonValue(map, horizon, fallback) {
  if (!map || typeof map !== 'object') return fallback;
  const value = num(map[horizon]);
  return value === null ? fallback : value;
}

// ---------------------------------------------------------------------------
// The exchange session
// ---------------------------------------------------------------------------
// `istClock` and `marketSession` live in `../session` so the bias meter's price component can age
// a quote against the same clock the gate uses. They are re-exported below for existing callers.

// ---------------------------------------------------------------------------
// Context summaries (pure, so the exposure and loss rules are testable without a database)
// ---------------------------------------------------------------------------
// Published signals are the open-position ledger until W7 can close them. A signal counts as
// open for a horizon-specific window, so a one-day intraday idea does not hold an exposure slot
// for a month.
function summariseExposure(signals, config, now = Date.now()) {
  const gates = (config && config.gates) || DEFAULT_RISK_CONFIG.gates;
  const byHorizon = {};
  const bySymbol = {};
  const bySymbolAnyHorizon = {};
  const lastPublished = {};
  for (const signal of Array.isArray(signals) ? signals : []) {
    const horizon = String((signal && signal.horizon) || '');
    const symbol = String((signal && signal.symbol) || '');
    const at = new Date((signal && (signal.published_at || signal.publishedAt)) || 0).getTime();
    if (!Number.isFinite(at) || at <= 0) continue;
    const holdingMs = horizonValue(gates.holdingDays, horizon, 30) * 86400000;
    if (now - at > holdingMs) continue;
    byHorizon[horizon] = (byHorizon[horizon] || 0) + 1;
    bySymbol[`${horizon}|${symbol}`] = (bySymbol[`${horizon}|${symbol}`] || 0) + 1;
    bySymbolAnyHorizon[symbol] = (bySymbolAnyHorizon[symbol] || 0) + 1;
    const dupKey = `${horizon}|${symbol}|${String((signal && signal.direction) || '').toUpperCase()}`;
    const prior = lastPublished[dupKey] ? new Date(lastPublished[dupKey]).getTime() : 0;
    if (at > prior) lastPublished[dupKey] = new Date(at).toISOString();
  }
  return { byHorizon, bySymbol, bySymbolAnyHorizon, lastPublished };
}

// Consecutive losses counting back from the most recent closed trade. A null result means
// "there is no history", which the gate reports as SKIPPED rather than as a clean record.
const LOSS_RESULTS = ['LOSS', 'STOPPED_OUT', 'STOP_HIT', 'FAILED'];
// Settled with no verdict: a position that could never be priced. It is neither a loss nor a win,
// so it must not be read as a break in a real losing streak - it is skipped, not counted.
const NEUTRAL_RESULTS = ['NO_PRICE_SOURCE'];

// A loss counts toward the halt and the cooldown only when it was material.
// A 0.4% stop is noise, and a run of noise must not be able to switch the
// system off for a whole trading day.
function isMaterialLoss(pnl, threshold) {
  if (pnl === null || pnl === undefined) return false;
  const limit = Math.abs(Number(threshold) || 0);
  if (limit <= 0) return pnl < 0;
  return pnl <= -limit;
}

// The day's portfolio return, weighted by the capital at risk in each closed
// trade.
//
// Summing per-trade percentages is a units error, and a dangerous one. Three
// trades that each lost 1% is a 1% day, not a 3% day, but the raw sum of a
// dozen outcomes can read -90% while the book is barely down - and a gate that
// believes -90% refuses every candidate for the rest of the session over a
// number that was never a return.
//
// The capital weight is the entry price of each closed plan: the premium or
// share price actually at risk on it. Quantity is not stored on the outcome
// row, so this approximates the true capital base - but it is the same order
// of magnitude as a sum of percentages and, unlike the sum, it does not
// explode with the number of trades.
function weightedDailyReturn(rows) {
  let weighted = 0;
  let weight = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const pnl = num(row && row.pnl_pct);
    if (pnl === null) continue;
    const entry = num(row && row.entry);
    const w = entry === null || entry === 0 ? 1 : Math.abs(entry);
    weighted += pnl * w;
    weight += w;
  }
  if (weight <= 0) return null;
  return round(weighted / weight, 2);
}

function lossStreak(outcomes, materialPct = 0) {
  const rows = Array.isArray(outcomes) ? outcomes : [];
  if (!rows.length) return null;
  let streak = 0;
  let sawVerdict = false;
  for (const outcome of rows) {
    const pnl = num(outcome && outcome.pnl_pct);
    const result = String((outcome && outcome.result) || '').toUpperCase();
    if (pnl === null && NEUTRAL_RESULTS.some((token) => result.includes(token))) continue;
    sawVerdict = true;
    const isLoss = pnl !== null
      ? pnl < 0
      : LOSS_RESULTS.some((token) => result.includes(token));
    if (!isLoss) break;
    if (materialPct > 0 && !isMaterialLoss(pnl, materialPct)) break;
    streak += 1;
  }
  return sawVerdict ? streak : null;
}

function summariseOutcomes(rows, todayPnlPct = null, lastLossAt = null, todayCount = 0, materialPct = 0) {
  const list = Array.isArray(rows) ? rows : [];
  let lastMaterialLossAt = null;
  for (const row of list) {
    const pnl = num(row && row.pnl_pct);
    const result = String((row && row.result) || '').toUpperCase();
    if (pnl === null && NEUTRAL_RESULTS.some((token) => result.includes(token))) continue;
    const isLoss = pnl !== null
      ? pnl < 0
      : LOSS_RESULTS.some((token) => result.includes(token));
    if (isLoss && isMaterialLoss(pnl, materialPct)) {
      lastMaterialLossAt = row.evaluated_at || null;
      break;
    }
  }
  return {
    consecutiveLosses: lossStreak(list, materialPct),
    recent: list.length,
    dailyPnlPct: todayCount > 0 ? num(todayPnlPct) : null,
    lastLossAt: lastLossAt || null,
    lastMaterialLossAt: lastMaterialLossAt || null,
  };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------
// Returns { decision, approved, checks, failures, reasons, configVersion }. `checks` is the full
// audit trail, so the dashboard can explain a rejection gate by gate.
function evaluateRisk({ candidate, context = {}, config, now = Date.now() }) {
  const gates = config.gates;
  const horizon = String((candidate && candidate.horizon) || '').toUpperCase();
  const symbol = String((candidate && candidate.symbol) || '');
  const direction = String((candidate && candidate.direction) || '').toUpperCase();
  const checks = [];
  const add = (gate, status, detail, extra = {}) => {
    if (!CHECK_STATES.includes(status)) throw new Error(`unknown risk check status: ${status}`);
    checks.push({ gate, status, detail, ...extra });
  };

  // 1. The gate can be stopped, but stopping it fails closed rather than opening it.
  if (!gates.enabled) add('enabled', 'FAIL', 'the risk gate is switched off in config; publishing is halted');
  else add('enabled', 'PASS', 'risk gate enabled');
  if (gates.killSwitch) add('killSwitch', 'FAIL', 'the global kill switch is engaged');
  else add('killSwitch', 'PASS', 'kill switch not engaged');

  // 2. A known horizon is required before anything else can be trusted.
  if (!HORIZONS.includes(horizon)) {
    add('horizon', 'FAIL', `unknown horizon "${horizon || 'none'}"`);
  } else {
    add('horizon', 'PASS', horizon);
  }

  // 3. Session. We can only enter while the exchange is open, so a proposal raised outside hours
  //    is deferred rather than rejected - it may still be valid when the market opens.
  //    Switching session enforcement off is the one control whose disabling turns the market-hours
  //    requirement into a plain APPROVED, so the skip is marked `bypassed` and named in the
  //    decision's reasons. An approval that leaned on a switched-off control must never look like
  //    an ordinary one in the audit trail.
  const session = context.session || marketSession(now, gates.session);
  if (!gates.session.enforce) {
    add('session', 'SKIPPED', 'session enforcement is switched off in config', { bypassed: true });
  } else if (session.open) {
    add('session', 'PASS', 'inside the NSE session');
  } else {
    add('session', 'DEFER', session.reason || 'outside the NSE session');
  }

  // 4. Freshness. A plan is a statement about right now; an old one is not tradeable.
  const asOf = new Date((candidate && (candidate.as_of || candidate.created_at)) || 0).getTime();
  const maxAge = horizonValue(gates.maxCandidateAgeMinutes, horizon, 1440);
  if (!Number.isFinite(asOf) || asOf <= 0) {
    add('freshness', 'FAIL', 'the candidate carries no usable timestamp, so its age is unknown', {
      ageMinutes: null, maxAge,
    });
  } else {
    const ageMinutes = Math.max(0, Math.round((now - asOf) / 60000));
    if (ageMinutes > maxAge) {
      add('freshness', 'FAIL', `candidate is ${ageMinutes} min old, past the ${maxAge} min limit for ${horizon}`, {
        ageMinutes, maxAge,
      });
    } else {
      add('freshness', 'PASS', `candidate is ${ageMinutes} min old (limit ${maxAge})`, { ageMinutes, maxAge });
    }
  }

  // 5. Conviction and payoff shape. A candidate that cannot state its own confidence or its
  //    reward:risk is malformed, and a malformed proposal is never approved.
  const confidence = num(candidate && candidate.confidence);
  if (confidence === null) {
    add('confidence', 'FAIL', 'the candidate carries no confidence');
  } else if (confidence < gates.minConfidence) {
    add('confidence', 'FAIL', `confidence ${round(clamp(confidence, 0, 1), 2)} is below the floor ${gates.minConfidence}`, {
      confidence,
    });
  } else {
    add('confidence', 'PASS', `confidence ${round(clamp(confidence, 0, 1), 2)} clears the floor ${gates.minConfidence}`, {
      confidence,
    });
  }

  const rr = num(candidate && candidate.rr);
  if (rr === null) {
    add('rewardRisk', 'FAIL', 'the candidate carries no reward:risk');
  } else if (rr < gates.minRewardRisk) {
    add('rewardRisk', 'FAIL', `reward:risk ${round(rr, 2)} is below the floor ${gates.minRewardRisk}`, { rr });
  } else {
    add('rewardRisk', 'PASS', `reward:risk ${round(rr, 2)} clears the floor ${gates.minRewardRisk}`, { rr });
  }

  // 6. Liquidity. A contract-level spread check needs a bid/ask feed this harness does not have
  //    yet, so the plan's own liquidity verdict stands in and the note records what is missing.
  if (!gates.liquidityRequired) {
    add('liquidity', 'SKIPPED', 'liquidity enforcement is switched off in config', { bypassed: true });
  } else if (candidate && candidate.liquidity_ok === true) {
    add('liquidity', 'PASS', 'plan liquidity floor met (spread not yet measurable: no book feed)');
  } else {
    add('liquidity', 'FAIL', 'the plan did not clear its liquidity floor when the candidate was raised');
  }

  // 7. Exposure. Published signals are the open-position ledger until W7 can close them.
  const exposure = context.exposure || {};
  const openHere = num((exposure.byHorizon || {})[horizon]) || 0;
  const maxOpen = horizonValue(gates.maxOpenPositions, horizon, 5);
  if (openHere >= maxOpen) {
    add('openPositions', 'FAIL', `${openHere} open ${horizon} position(s), at the cap of ${maxOpen}`, {
      openHere, maxOpen,
    });
  } else {
    add('openPositions', 'PASS', `${openHere}/${maxOpen} ${horizon} position(s) open`, { openHere, maxOpen });
  }

  const symbolOpen = num((exposure.bySymbol || {})[`${horizon}|${symbol}`]) || 0;
  const maxPerSymbol = num(gates.maxOpenPerSymbol);
  if (symbolOpen >= (maxPerSymbol === null ? 1 : maxPerSymbol)) {
    add('symbolExposure', 'FAIL', `${symbol} already has ${symbolOpen} open ${horizon} position(s)`);
  } else {
    add('symbolExposure', 'PASS', `${symbol} has ${symbolOpen} open ${horizon} position(s)`, { symbolOpen });
  }

  // The same name held in another horizon is the same money. Without this,
  // one contract can be taken once per horizon and the loss controls then
  // count three separate bets where the household only ever made one.
  const symbolOpenAny = num((exposure.bySymbolAnyHorizon || {})[symbol]) || 0;
  const maxAnyPerSymbol = num(gates.maxOpenPerSymbolAnyHorizon);
  if (maxAnyPerSymbol !== null && symbolOpenAny >= maxAnyPerSymbol) {
    add('symbolExposureAnyHorizon', 'FAIL', `${symbol} already has ${symbolOpenAny} open position(s) across all horizons`);
  } else {
    add('symbolExposureAnyHorizon', 'PASS', `${symbol} has ${symbolOpenAny} open position(s) across all horizons`, { symbolOpenAny });
  }

  // 8. Duplicate suppression: a fresh proposal for a name we just published is noise.
  const lastAt = (exposure.lastPublished || {})[`${horizon}|${symbol}|${direction}`];
  if (!lastAt) {
    add('duplicateWindow', 'SKIPPED', 'no matching call was published within the holding window');
  } else {
    const minutes = Math.max(0, Math.round((now - new Date(lastAt).getTime()) / 60000));
    if (minutes < gates.duplicateWindowMinutes) {
      add('duplicateWindow', 'FAIL', `the same ${horizon} ${symbol} ${direction} call was published ${minutes} min ago`);
    } else {
      add('duplicateWindow', 'PASS', `the last matching call was ${minutes} min ago`);
    }
  }

  // 9. Loss controls. These need closed trades, which only exist once the evaluator (W7) is
  //    running; until then they report SKIPPED rather than pretending to have checked.
  const outcomes = context.outcomes || {};
  if (outcomes.consecutiveLosses === null || outcomes.consecutiveLosses === undefined) {
    add('consecutiveLossHalt', 'SKIPPED', 'no closed trades recorded yet');
  } else if (outcomes.consecutiveLosses >= gates.consecutiveLossHalt) {
    add('consecutiveLossHalt', 'FAIL', `${outcomes.consecutiveLosses} consecutive losses; new entries are halted`);
  } else {
    add('consecutiveLossHalt', 'PASS', `${outcomes.consecutiveLosses} consecutive loss(es), halt level ${gates.consecutiveLossHalt}`);
  }

  if (!outcomes.lastLossAt) {
    add('cooldownAfterLoss', 'SKIPPED', 'no recorded loss to cool down from');
  } else {
    // The cooldown follows a MATERIAL loss. A 0.4% stop is not a reason to
    // stop trading for an hour.
    const lastLoss = outcomes.lastMaterialLossAt || outcomes.lastLossAt;
    const minutes = Math.max(0, Math.round((now - new Date(lastLoss).getTime()) / 60000));
    if (minutes < gates.cooldownAfterLossMinutes) {
      add('cooldownAfterLoss', 'FAIL', `the last material loss was ${minutes} min ago; cooling down for ${gates.cooldownAfterLossMinutes} min`);
    } else {
      add('cooldownAfterLoss', 'PASS', `the last material loss was ${minutes} min ago`);
    }
  }

  if (outcomes.dailyPnlPct === null || outcomes.dailyPnlPct === undefined) {
    add('dailyLossLimit', 'SKIPPED', 'no closed trades today');
  } else if (outcomes.dailyPnlPct <= -Math.abs(gates.dailyLossLimitPct)) {
    add('dailyLossLimit', 'FAIL', `today is ${round(outcomes.dailyPnlPct, 2)}%, past the ${gates.dailyLossLimitPct}% daily loss limit`);
  } else {
    add('dailyLossLimit', 'PASS', `today is ${round(outcomes.dailyPnlPct, 2)}%, limit ${gates.dailyLossLimitPct}%`);
  }

  const failures = checks.filter((check) => check.status === 'FAIL');
  const deferred = checks.filter((check) => check.status === 'DEFER');
  const bypassed = checks.filter((check) => check.bypassed).map((check) => check.gate);
  const decision = failures.length ? 'REJECTED' : (deferred.length ? 'DEFERRED' : 'APPROVED');
  const reasons = decision === 'REJECTED'
    ? failures.map((check) => `${check.gate}: ${check.detail}`)
    : decision === 'DEFERRED'
      ? deferred.map((check) => `${check.gate}: ${check.detail}`)
      : ['every risk gate passed'];

  // An approval that rested on a control disabled in config must not read as an ordinary pass, so
  // the bypassed gates are named. This is precisely the "how was this approved after hours?"
  // question, answered by the stored row rather than by an investigation.
  if (decision === 'APPROVED' && bypassed.length) {
    reasons.push(`approved with controls switched off in config: ${bypassed.join(', ')}`);
  }

  return {
    decision,
    approved: decision === 'APPROVED',
    checks,
    failures: failures.map((check) => check.gate),
    deferred: deferred.map((check) => check.gate),
    bypassed,
    reasons,
    configVersion: config.version,
  };
}

module.exports = {
  isMaterialLoss,
  weightedDailyReturn,
  CHECK_STATES,
  DECISIONS,
  DEFAULT_RISK_CONFIG,
  resolveRiskConfig,
  horizonValue,
  istClock,
  marketSession,
  istDayStart,
  summariseExposure,
  summariseOutcomes,
  lossStreak,
  evaluateRisk,
};
