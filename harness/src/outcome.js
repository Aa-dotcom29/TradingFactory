'use strict';

// Worker 7's decision logic, kept pure so the exit rules are testable without a database, a
// queue or a clock. The worker reads rows, calls these functions, and writes what they return.
//
// The job: a published signal is an open position until something closes it. W7 walks the
// recorded price path, decides whether the target or the stop was reached or whether the
// horizon's holding window simply ran out, and turns that into an `outcomes` row.
//
// Those rows are what the risk gate's loss controls read. Until W7 wrote one, three of the
// fourteen gates reported SKIPPED every single time - not because they were unimplemented, but
// because there had never been a closed trade to learn from.

const { PRICE_SOURCE } = require('./contract');

const RESULT = {
  TARGET: 'TARGET',
  STOP: 'STOP',
  TIME: 'TIME',
  NO_PRICE_SOURCE: 'NO_PRICE_SOURCE', // settled with no verdict: the position could never be priced
};

const STATUS = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',                       // no exit condition met yet - a normal, healthy state
  AWAITING_PRICE_SOURCE: 'AWAITING_PRICE_SOURCE', // a plan we cannot price honestly
  UNEVALUABLE: 'UNEVALUABLE',         // a plan missing the numbers needed to judge it
};

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, places = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

const isBullish = (direction) => String(direction || '').toUpperCase() === 'BULLISH';

// Which way the *position* makes money, which is not the same question as which way the market is
// expected to go.
//
// Buying a put because the view is bearish is still a long position: it pays when the premium
// rises. Treating `direction` as the position side made every option plan unevaluable, because the
// evaluator demanded the level order of a short - target below entry - from a plan whose levels
// were, quite correctly, those of a long. The signal builder has always written long-premium
// levels for bought options, so the refusal was permanent and the learning loop never saw a single
// option trade.
//
// A plan's own `position` wins. When it is absent - a row written before the field existed - an
// option plan is read as long, because this harness only ever buys options and never writes one.
function planSide({ signal = {}, plan = null, kind = null } = {}) {
  const explicit = String((plan && plan.position) || '').toUpperCase();
  if (explicit === 'LONG' || explicit === 'SHORT') return explicit;
  const resolved = kind || planKind(signal, plan);
  if (resolved === 'OPTION') return 'LONG';
  return isBullish(signal && signal.direction) ? 'LONG' : 'SHORT';
}

const isLongSide = (side) => String(side || '').toUpperCase() === 'LONG';

// How much the *position* is up (positive) or down (negative) at a given price, as a percentage of
// entry. It takes the position's side, not the market view - see `planSide` for why that
// distinction cost every option trade its verdict.
function movePct(side, entry, price) {
  const delta = isLongSide(side) ? price - entry : entry - price;
  return (delta / entry) * 100;
}

// Readings must be time-ordered and carry a usable price. Anything else is dropped rather than
// guessed at, and the count is reported so a thin path is visible instead of silent.
//
// A reading may optionally carry high/low. When both are present the reading is treated as a
// bar, and a level counts as reached if the bar touched it - which is the only situation where
// "target and stop both hit" is genuinely possible and has to be adjudicated.
//
// Callers must only pass high/low when they describe that reading's own range. The quote
// payload's high/low are the *day's* range, so the worker passes a bare price; feeding a daily
// range in as a bar would report the target as hit on the open and poison every outcome.
function normalisePath(path) {
  const rows = Array.isArray(path) ? path : [];
  const clean = [];
  for (const row of rows) {
    const at = new Date((row && row.at) || 0).getTime();
    const price = num(row && row.price);
    if (!Number.isFinite(at) || at <= 0 || price === null || price <= 0) continue;
    let high = num(row && row.high);
    let low = num(row && row.low);
    const isBar = high !== null && low !== null && high > 0 && low > 0;
    if (isBar && high < low) [high, low] = [low, high];
    clean.push(isBar ? { at, price, high, low } : { at, price });
  }
  clean.sort((a, b) => a.at - b.at);
  return clean;
}

// Which price series a plan can be judged against.
//
// A SPOT (or futures) plan quotes its entry, target and stop on the underlying, and the price
// history we hold is underlying quotes - so the two are on the same instrument and comparable.
//
// An option plan quotes those levels on the option *premium*. Since Slice 8 the harness persists an
// option's own premium series (W0, `option.quote.v1`; W9, `tape_ticks`; or the NSE snapshot in
// `oi_spurts`), so such a plan is scored against that series and not against spot. Until a reading
// exists it is reported as awaiting a price source, and after a short grace window it settles with
// no verdict rather than staying open for the whole holding period. Judging a premium against an
// underlying price would produce a confident, meaningless number and then feed it to the loss
// controls, so a mismatched pair is refused outright.
function planKind(signal, plan) {
  const instrument = String((signal && signal.instrument) || '').toLowerCase();
  const explicit = String((plan && plan.kind) || '').toUpperCase();
  const strike = signal && signal.strike;
  const optionType = signal && signal.option_type;

  // A contract identifier outranks the label. A plan that calls itself SPOT while carrying a
  // strike is contradictory, and a mislabeled option plan scored against the underlying would
  // be confidently wrong - so the identifier wins and the plan is refused a price source.
  if ((strike !== null && strike !== undefined && strike !== '') || optionType) return 'OPTION';
  if (explicit === 'CE' || explicit === 'PE' || explicit === 'OPTION') return 'OPTION';
  if (explicit === 'SPOT' || explicit === 'FUTURE' || explicit === 'FUTURES') return 'UNDERLYING';
  if (instrument.includes('option') || instrument.includes(' ce') || instrument.includes(' pe')) return 'OPTION';
  return 'UNDERLYING';
}

// The whole decision, in one pure function.
//
// `path` is every price reading recorded for the symbol at or after publication, oldest first.
// Returns a single object describing what to write: nothing here touches the database.
function evaluateOutcome(options = {}) {
  const signal = options.signal || {};
  const plan = (signal.snapshot && signal.snapshot.plan) || null;
  const direction = String(signal.direction || '').toUpperCase();
  const horizon = String(signal.horizon || '').toUpperCase();
  const publishedAt = new Date(signal.publishedAt || signal.published_at || 0).getTime();
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const holdingDays = num(options.holdingDays);
  const windowDays = holdingDays === null || holdingDays <= 0 ? 30 : holdingDays;

  const entry = num(signal.entry);
  const target = num(signal.target);
  const stop = num(signal.stop);

  // What is this plan priced on, and what series was the caller offering? Both are settled before
  // any early return so every verdict can say which instrument it judged and against which series.
  //
  // The default is the ordinary underlying series, not the series the plan would ideally have: a
  // caller who forgets to say which series it loaded must land on the refusal, never on a score.
  const kind = planKind(signal, plan);
  const side = planSide({ signal, plan, kind });
  const priceSource = options.priceSource || PRICE_SOURCE.UNDERLYING;

  const base = {
    horizon, symbol: signal.symbol || null, direction, side, entry, kind, priceSource,
    // Which stored series produced the readings ('option.quote.v1', 'tape_ticks',
    // 'oi_spurts'). The evaluator's priceSource says what kind of instrument the
    // series represents; this says where the numbers actually came from.
    priceSeries: options.priceSeries || null,
  };

  if (!isBullish(direction) && direction !== 'BEARISH') {
    return { status: STATUS.UNEVALUABLE, ...base, reason: `direction ${direction || '(none)'} is not tradable` };
  }
  if (entry === null || entry <= 0) {
    return { status: STATUS.UNEVALUABLE, ...base, reason: 'no usable entry price on the signal' };
  }
  if (target === null || stop === null) {
    return { status: STATUS.UNEVALUABLE, ...base, reason: 'the plan is missing a target or a stop' };
  }
  // Levels are ordered by the side actually held, so a bought put is checked as the long it is.
  if (isLongSide(side)) {
    if (!(target > entry && entry > stop)) {
      return { status: STATUS.UNEVALUABLE, ...base, reason: `long plan levels are out of order (target ${target}, entry ${entry}, stop ${stop})` };
    }
  } else if (!(target < entry && entry < stop)) {
    return { status: STATUS.UNEVALUABLE, ...base, reason: `short plan levels are out of order (target ${target}, entry ${entry}, stop ${stop})` };
  }
  if (!Number.isFinite(publishedAt) || publishedAt <= 0) {
    return { status: STATUS.UNEVALUABLE, ...base, reason: 'the signal has no publication time' };
  }
  const windowMs = windowDays * 86400000;

  // A plan and its price series must describe the same instrument: an option-premium plan's levels
  // are premiums, an underlying plan's are spot. The check is enforced here, in the pure function,
  // so a caller that hands over the wrong series cannot produce a confident, wrong number and feed
  // it to the loss controls. The refusal does not depend on the worker's wiring being correct.
  const optionPlan = kind === 'OPTION';
  const wrongSeries = optionPlan
    ? priceSource !== PRICE_SOURCE.OPTION
    : priceSource !== PRICE_SOURCE.UNDERLYING;

  // A spot plan handed a premium series is a caller bug, not a position we are waiting on, so it
  // is reported as unevaluable rather than parked in a waiting state it would never leave.
  if (wrongSeries && !optionPlan) {
    return {
      status: STATUS.UNEVALUABLE,
      ...base,
      reason: 'an underlying plan was given an option-premium price series',
    };
  }

  const readings = wrongSeries ? [] : normalisePath(options.path).filter((reading) => reading.at >= publishedAt);

  // Nothing to walk: either the plan cannot be priced on the series we hold, or no reading ever
  // arrived. An underlying plan waits for its holding window; an option-premium plan gets a much
  // shorter grace window, because a premium series that never arrived leaves the stop and target
  // unknowable. Settling it as NO_PRICE_SOURCE is honest and stops it looking like a live position
  // for 30 days. Neither path invents an exit or a return.
  if (!readings.length) {
    const reason = optionPlan
      ? 'option-premium plan: needs option quote history, not the underlying price'
      : 'no price readings since publication';
    const graceHours = optionPlan
      ? Math.max(0, (num(options.unpricedGraceHours) ?? 8))
      : null;
    const settleAt = optionPlan ? publishedAt + graceHours * 3600000 : publishedAt + windowMs;
    if (now >= settleAt) {
      return {
        status: STATUS.CLOSED,
        ...base,
        result: RESULT.NO_PRICE_SOURCE,
        unpriced: true,
        exit: null,
        exitAt: null,
        pnlPct: null,
        mfePct: null,
        maePct: null,
        readings: 0,
        heldMinutes: Math.round((now - publishedAt) / 60000),
        heldDays: round((now - publishedAt) / 86400000, 3),
        windowDays,
        graceHours,
        target,
        stop,
        reason: optionPlan
          ? `${reason}; no price source within the ${graceHours}h grace window`
          : `${reason}; the ${windowDays}d holding window elapsed with no price source`,
      };
    }
    return {
      status: optionPlan ? STATUS.AWAITING_PRICE_SOURCE : STATUS.OPEN,
      ...base,
      reason,
      readings: 0,
      target,
      stop,
      ...(optionPlan ? { graceHours } : {}),
    };
  }

  const long = isLongSide(side);
  let exit = null;
  let exitAt = null;
  let result = null;
  let ambiguous = false;

  for (const reading of readings) {
    // A bare price is its own high and low; a bar carries the range it actually traded.
    const reachedHigh = reading.high === undefined ? reading.price : reading.high;
    const reachedLow = reading.low === undefined ? reading.price : reading.low;
    const targetHit = long ? reachedHigh >= target : reachedLow <= target;
    const stopHit = long ? reachedLow <= stop : reachedHigh >= stop;

    if (stopHit && targetHit) {
      // One reading reached both levels, so we cannot know which came first - only a bar can do
      // this. Assume the worse outcome. A decision-support tool that flatters itself on
      // ambiguity is worse than useless.
      exit = stop;
      exitAt = reading.at;
      result = RESULT.STOP;
      ambiguous = true;
      break;
    }
    if (stopHit) {
      exit = stop;
      exitAt = reading.at;
      result = RESULT.STOP;
      break;
    }
    if (targetHit) {
      exit = target;
      exitAt = reading.at;
      result = RESULT.TARGET;
      break;
    }
  }

  const elapsedAtLastReading = readings[readings.length - 1].at - publishedAt;
  const longestWait = Math.max(elapsedAtLastReading, now - publishedAt);

  if (exit === null) {
    if (longestWait < windowMs) {
      return {
        status: STATUS.OPEN,
        ...base,
        reason: `open: ${readings.length} reading(s), no level reached, window ${windowDays}d`,
        readings: readings.length,
        target,
        stop,
        lastPrice: readings[readings.length - 1].price,
      };
    }
    // The holding window ran out. Exit at the last price inside the window - the mark the
    // horizon actually promised to hold for, not whatever drifted in afterwards.
    const windowEnd = publishedAt + windowMs;
    const inside = readings.filter((reading) => reading.at <= windowEnd);
    const last = inside.length ? inside[inside.length - 1] : readings[readings.length - 1];
    exit = last.price;
    exitAt = last.at;
    result = RESULT.TIME;
  }

  // Excursion is measured only up to the exit reading: what the trade did *after* it closed is
  // not this trade's excursion. A bar contributes its own extremes, a bare price just itself.
  const considered = readings.filter((reading) => reading.at <= exitAt);
  let mfe = 0;
  let mae = 0;
  for (const reading of considered) {
    const high = reading.high === undefined ? reading.price : reading.high;
    const low = reading.low === undefined ? reading.price : reading.low;
    const favourable = long ? high : low;
    const adverse = long ? low : high;
    const up = movePct(side, entry, favourable);
    const down = movePct(side, entry, adverse);
    if (up > mfe) mfe = up;
    if (down < mae) mae = down;
  }

  const pnlPct = movePct(side, entry, exit);

  return {
    status: STATUS.CLOSED,
    ...base,
    result,
    ambiguous,
    exit: round(exit, 4),
    exitAt: new Date(exitAt).toISOString(),
    pnlPct: round(pnlPct, 4),
    mfePct: round(mfe, 4),
    maePct: round(mae, 4),
    readings: considered.length,
    heldMinutes: Math.round((exitAt - publishedAt) / 60000),
    heldDays: round((exitAt - publishedAt) / 86400000, 3),
    windowDays,
    target,
    stop,
    win: pnlPct > 0,
  };
}

// ---------------------------------------------------------------------------
// Scoring - what the closed trades say about the machine
// ---------------------------------------------------------------------------
// Deliberately plain statistics. No curve fitting on a handful of trades, and no ratio that
// needs a sample size we do not have yet: every figure here is safe to read at n=1.
function scoreOutcomes(rows) {
  const closed = (Array.isArray(rows) ? rows : []).filter((row) => row && row.pnl_pct !== null && row.pnl_pct !== undefined);
  const total = closed.length;
  const empty = {
    total: 0, wins: 0, losses: 0, flats: 0,
    winRatePct: null, avgPnlPct: null, medianPnlPct: null,
    totalPnlPct: null, avgWinPct: null, avgLossPct: null,
    expectancyPct: null, avgMfePct: null, avgMaePct: null,
    byResult: {}, byHorizon: {},
  };
  if (!total) return empty;

  const pnls = [];
  const wins = [];
  const losses = [];
  const byResult = {};
  const byHorizon = {};
  let mfeSum = 0;
  let maeSum = 0;
  let mfeCount = 0;

  for (const row of closed) {
    const pnl = num(row.pnl_pct);
    if (pnl === null) continue;
    pnls.push(pnl);
    if (pnl > 0) wins.push(pnl);
    else if (pnl < 0) losses.push(pnl);

    const result = String(row.result || 'UNKNOWN').toUpperCase();
    byResult[result] = (byResult[result] || 0) + 1;

    const horizon = String(row.horizon || 'UNKNOWN').toUpperCase();
    if (!byHorizon[horizon]) byHorizon[horizon] = { total: 0, wins: 0, losses: 0, pnlSum: 0 };
    byHorizon[horizon].total += 1;
    if (pnl > 0) byHorizon[horizon].wins += 1;
    if (pnl < 0) byHorizon[horizon].losses += 1;
    byHorizon[horizon].pnlSum += pnl;

    const mfe = num(row.mfe_pct);
    const mae = num(row.mae_pct);
    if (mfe !== null || mae !== null) {
      mfeCount += 1;
      mfeSum += mfe === null ? 0 : mfe;
      maeSum += mae === null ? 0 : mae;
    }
  }

  const measured = pnls.length || 1;
  const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
  const median = (values) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  const winRate = (wins.length / measured) * 100;
  const avgWin = mean(wins);
  const avgLoss = mean(losses);
  // Expectancy per trade: the figure that answers "is this worth running at all". Null until
  // there is at least one of each side, because a 100% win rate off three trades is not one.
  const expectancy = avgWin !== null && avgLoss !== null
    ? (winRate / 100) * avgWin + (1 - winRate / 100) * avgLoss
    : null;

  for (const horizon of Object.keys(byHorizon)) {
    const bucket = byHorizon[horizon];
    bucket.pnlSum = round(bucket.pnlSum, 4);
    bucket.winRatePct = round((bucket.wins / bucket.total) * 100, 2);
  }

  return {
    total,
    wins: wins.length,
    losses: losses.length,
    flats: total - wins.length - losses.length,
    winRatePct: round(winRate, 2),
    avgPnlPct: round(mean(pnls), 4),
    medianPnlPct: round(median(pnls), 4),
    totalPnlPct: round(pnls.reduce((a, b) => a + b, 0), 4),
    avgWinPct: round(avgWin, 4),
    avgLossPct: round(avgLoss, 4),
    expectancyPct: round(expectancy, 4),
    avgMfePct: mfeCount ? round(mfeSum / mfeCount, 4) : null,
    avgMaePct: mfeCount ? round(maeSum / mfeCount, 4) : null,
    byResult,
    byHorizon,
  };
}

// ---------------------------------------------------------------------------
// Proposals - the self-learning half, which cannot learn by itself
// ---------------------------------------------------------------------------
// W7 may propose a config change. It may never apply one. A proposal is written as a
// `candidate` row in config_registry, which every worker ignores when it resolves "latest
// approved" - so an unapproved proposal has no effect anywhere in the pipeline.
//
// A minimum sample size guards the whole thing: below it, W7 proposes nothing at all, because
// tuning weights against a dozen trades is how a quiet system talks itself into losses.
const DEFAULT_PROPOSAL_RULES = {
  minTrades: 30,
  minTradesPerHorizon: 20,
};

function proposeConfigChange(options = {}) {
  const stats = options.stats || {};
  const horizonStats = options.horizonStats || null;
  const rules = { ...DEFAULT_PROPOSAL_RULES, ...(options.rules || {}) };
  const current = options.currentConfig || null;

  if (!stats.total || stats.total < rules.minTrades) {
    return {
      proposed: false,
      reason: `only ${stats.total || 0} closed trade(s); ${rules.minTrades} needed before proposing anything`,
    };
  }

  const signals = [];
  if (stats.winRatePct !== null && stats.winRatePct < 40) {
    signals.push(`win rate ${stats.winRatePct}% is below 40%`);
  }
  if (stats.expectancyPct !== null && stats.expectancyPct < 0) {
    signals.push(`expectancy ${stats.expectancyPct}% per trade is negative`);
  }
  if (stats.avgMaePct !== null && stats.avgLossPct !== null
      && Math.abs(stats.avgMaePct) > Math.abs(stats.avgLossPct)) {
    signals.push(`average adverse excursion ${stats.avgMaePct}% runs deeper than the average realised loss ${stats.avgLossPct}%`);
  }

  if (!signals.length) {
    return {
      proposed: false,
      reason: `no rule triggered across ${stats.total} closed trade(s)`,
      metrics: stats,
    };
  }

  // One concrete, conservative change: raise the confidence floor, which narrows what gets
  // through rather than loosening anything. W7 proposes tightening only - it has no business
  // proposing that the system take more risk.
  const family = 'risk';
  const base = current && current.config ? current.config : null;
  if (!base || !base.gates) {
    return { proposed: false, reason: 'no current risk config to propose a change against' };
  }

  const step = 0.05;
  const ceiling = 0.95;
  const from = num(base.gates.minConfidence) ?? 0.4;
  const to = round(Math.min(ceiling, from + step), 4);
  if (to <= from) {
    return { proposed: false, reason: `confidence floor is already at the ${ceiling} ceiling`, metrics: stats };
  }

  return {
    proposed: true,
    family,
    reason: signals.join('; '),
    metrics: stats,
    horizonStats,
    change: {
      path: 'gates.minConfidence',
      from,
      to,
      direction: 'tighten',
    },
    config: {
      ...base,
      gates: { ...base.gates, minConfidence: to },
    },
  };
}

module.exports = {
  RESULT,
  STATUS,
  evaluateOutcome,
  scoreOutcomes,
  proposeConfigChange,
  planKind,
  planSide,
  isLongSide,
  movePct,
  PRICE_SOURCE,
  DEFAULT_PROPOSAL_RULES,
};
