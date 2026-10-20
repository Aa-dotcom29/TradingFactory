'use strict';

// Slice 4 - the signal builder. Pure functions only: no network, no database, no model.
//
// It takes the bias meter's verdict plus the factual flow/quote features and answers two
// questions per symbol and horizon:
//
//   1. Where is this name in its trade lifecycle? (IDLE -> WATCH -> BUILDING -> READY)
//   2. If it is ready, what exactly is the trade? (instrument, entry, target, stop, liquidity)
//
// Two rules shape the design:
//
//   1. Nothing is invented. A plan that cannot be priced is not a plan: the lifecycle stops at
//      WATCH and records *why*. A READY state therefore means "there is a concrete, liquid
//      trade here", not "the score is high".
//   2. The stage is a small explicit state machine, not a boolean "signal / no signal". Most of
//      the value for a human is in the transition - a setup quietly moving from WATCH to
//      BUILDING is information, while a one-shot alert throws that away. Every stage row is
//      persisted with its reasons, so the history explains itself after the fact.
//
// Weights and thresholds are data, not code: they live in `config_registry` under the `signal`
// family, versioned, so tuning is a reviewable change rather than a deploy.

const { HORIZONS } = require('./topics');
const { parseExpiry } = require('./contract');
const { istClock } = require('./session');

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const num = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const round = (value, digits = 4) => (Number.isFinite(value) ? +value.toFixed(digits) : null);

// IDLE..READY are owned by W4. BLOCKED/ACTIVE/EXITED/EXPIRED belong to the risk gate (W5), the
// publisher (W6) and the evaluator (W7); W4 must never stomp them, or a live position would be
// silently reset to WATCH on the next tick.
const STAGES = ['IDLE', 'WATCH', 'BUILDING', 'READY', 'BLOCKED', 'ACTIVE', 'EXITED', 'EXPIRED'];
const OWNED_STAGES = ['IDLE', 'WATCH', 'BUILDING', 'READY'];
const ENGINE_VERSION = 'signal-engine-1';

const DEFAULT_SIGNAL_CONFIG = {
  version: 'signal-v1',
  strategy: 'bias-follow',
  plan: {
    // Only a strike within this fraction of spot counts as "at the money enough" to trade.
    strikeSearchPct: 0.03,
    // An option-premium stop, as a fraction of the premium paid.
    premiumStopPct: { INTRADAY: 0.25, SWING: 0.3, POSITIONAL: 0.35 },
    // A level stop on the underlying, used only for the spot/futures fallback plan.
    underlyingStopPct: { INTRADAY: 0.004, SWING: 0.02, POSITIONAL: 0.05 },
    // Reward per unit of risk. Target = entry +/- risk * rewardMultiple.
    rewardMultiple: { INTRADAY: 1.5, SWING: 2, POSITIONAL: 2.5 },
    // Liquidity floors. These are a conservative first cut: they are data, so calibration once
    // a full chain/greeks feed is wired in is a `config_registry` change, not a deploy.
    minOptionVolume: 500,
    minOptionOi: 5000,
    minOptionContracts: 3,
    // When no option contract can be anchored, fall back to a level plan on the underlying.
    spotFallback: true,
  },
  stages: {
    readyConfidence: 0.4, // confidence needed to leave BUILDING and become an actionable READY
    scoreDelta: 0.05, // score move that re-writes the stage row even without a stage change
    maxStaleMinutes: 15, // staleness heartbeat, so the age of every stage stays visible
  },
};

function resolveSignalConfig(candidate) {
  const stored = candidate && typeof candidate === 'object' ? candidate : {};
  const merged = { ...DEFAULT_SIGNAL_CONFIG, ...stored };
  for (const section of ['plan', 'stages']) {
    merged[section] = { ...DEFAULT_SIGNAL_CONFIG[section], ...(stored[section] || {}) };
  }
  for (const map of ['premiumStopPct', 'underlyingStopPct', 'rewardMultiple']) {
    merged.plan[map] = { ...DEFAULT_SIGNAL_CONFIG.plan[map], ...((stored.plan && stored.plan[map]) || {}) };
  }
  if (!merged.version) merged.version = DEFAULT_SIGNAL_CONFIG.version;
  return merged;
}

// Reads a horizon-keyed map with a safe fallback, so a half-written config row cannot zero a
// stop or produce a NaN strike.
function horizonValue(map, horizon, fallback) {
  if (!map || typeof map !== 'object') return fallback;
  const value = num(map[horizon]);
  return value === null ? fallback : value;
}

// ---------------------------------------------------------------------------
// Contract selection and liquidity
// ---------------------------------------------------------------------------
function contractList(flow) {
  return flow && Array.isArray(flow.topContracts) ? flow.topContracts.filter(Boolean) : [];
}

// The price the strike is anchored to. A broker quote wins because it is the live trade price;
// the NSE underlying value is the fallback so the pipeline can still form real plans when the
// broker feed is not configured.
function underlyingPrice(flow, quote) {
  const quoted = num(quote && quote.ltp);
  if (quoted !== null && quoted > 0) return { price: quoted, source: 'quote' };
  const nse = num(flow && flow.underlyingPrice);
  if (nse !== null && nse > 0) return { price: nse, source: 'nse-underlying' };
  return { price: null, source: null };
}

// A bullish verdict buys calls, a bearish one buys puts. Among the contracts the OI-spurt feed
// actually surfaced, pick the strike nearest spot; that is the at-the-money contract, which is
// where liquidity concentrates. If every surfaced strike is far from spot we refuse rather than
// quietly selling a deep out-of-the-money lottery ticket.
//
// Expired contracts are dropped first, and this is not a nicety. A flow snapshot outlives the
// session that produced it - the bias meter deliberately ages flow rather than discarding it - so
// on the day after an expiry the snapshot still names contracts that can no longer be bought. One
// of those was selected on 20 October 2026 and priced at 0.05, because 0.05 was the last trade of
// a dead NIFTY put. The risk gate would have approved it: the levels were correctly ordered, the
// liquidity floors read the dead contract's own volume and open interest, and nothing in the
// numbers looked unusual. An expiry that cannot be parsed is treated as expired, because a
// contract we cannot date is one we cannot promise is alive.
function selectContract({ direction, spot, flow, config, now = Date.now() }) {
  const optionType = direction === 'BULLISH' ? 'CE' : 'PE';
  const directional = contractList(flow).filter((c) => (
    c.kind === 'OPTION' && c.optionType === optionType && num(c.strike) !== null
  ));
  if (!directional.length) {
    return { ok: false, optionType, reason: `no ${optionType} strike in the latest flow snapshot` };
  }

  const today = istClock(now).date;
  const live = directional.filter((c) => {
    const expiry = parseExpiry(c.expiry);
    return expiry !== null && expiry >= today;
  });
  if (!live.length) {
    const seen = [...new Set(directional.map((c) => String(c.expiry || '(none)')))]
      .sort()
      .join(', ');
    return {
      ok: false,
      optionType,
      reason: `every ${optionType} strike in the latest flow snapshot has expired `
        + `(expiry ${seen}, today ${today})`,
    };
  }

  const band = Math.abs(spot) * config.plan.strikeSearchPct;
  const near = live.filter((c) => Math.abs(c.strike - spot) <= band);
  if (!near.length) {
    const nearest = live.reduce((best, c) => (
      Math.abs(c.strike - spot) < Math.abs(best.strike - spot) ? c : best
    ));
    return {
      ok: false,
      optionType,
      reason: `nearest ${optionType} strike ${nearest.strike} is outside the `
        + `${round(config.plan.strikeSearchPct * 100, 1)}% band around ${round(spot, 2)}`,
    };
  }

  near.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot)
    || (num(b.volume) || 0) - (num(a.volume) || 0)
    || String(a.expiry || '').localeCompare(String(b.expiry || '')));

  return {
    ok: true,
    optionType,
    contract: near[0],
    considered: near.length,
    droppedExpired: directional.length - live.length,
  };
}

function liquidityCheck({ contract, flow, config }) {
  const reasons = [];
  const volume = num(contract.volume) || 0;
  const oi = num(contract.oi) || 0;
  const optionContracts = num(flow && flow.optionCount) || 0;

  if (optionContracts < config.plan.minOptionContracts) {
    reasons.push(`${optionContracts} option contract(s) below floor ${config.plan.minOptionContracts}`);
  }
  if (volume < config.plan.minOptionVolume) {
    reasons.push(`contract volume ${volume} below floor ${config.plan.minOptionVolume}`);
  }
  if (oi < config.plan.minOptionOi) {
    reasons.push(`contract open interest ${oi} below floor ${config.plan.minOptionOi}`);
  }

  return { ok: reasons.length === 0, volume, oi, optionContracts, reasons };
}

function instrumentName(symbol, contract, optionType) {
  const parts = [symbol];
  if (contract.expiry) parts.push(String(contract.expiry));
  if (contract.strike !== null && contract.strike !== undefined) parts.push(String(contract.strike));
  parts.push(optionType);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Plan construction
// ---------------------------------------------------------------------------
// Returns { ok, plan, reason }. `ok` means "there is a concrete, liquid trade right now". A plan
// can still be returned when `ok` is false (for example a formed but illiquid option plan) so
// the dashboard can show the setup that is forming.
function buildPlan({ symbol, horizon, direction, flow, quote, config, now = Date.now() }) {
  const anchor = underlyingPrice(flow, quote);
  if (anchor.price === null) {
    return { ok: false, plan: null, reason: 'no underlying price (no broker quote and no NSE underlying value)' };
  }

  const spot = anchor.price;
  const reward = horizonValue(config.plan.rewardMultiple, horizon, 2);
  const underlyingStopPct = horizonValue(config.plan.underlyingStopPct, horizon, 0.02);
  const directionSign = direction === 'BULLISH' ? 1 : -1;
  const pick = selectContract({ direction, spot, flow, config, now });

  if (pick.ok) {
    const contract = pick.contract;
    const premium = num(contract.price);
    if (premium === null || premium <= 0) {
      return {
        ok: false,
        plan: null,
        reason: `${pick.optionType} ${contract.strike} was surfaced without a traded premium`,
        spot,
      };
    }

    const premiumStopPct = horizonValue(config.plan.premiumStopPct, horizon, 0.3);
    const liquidity = liquidityCheck({ contract, flow, config });
    const plan = {
      kind: 'OPTION',
      symbol,
      horizon,
      direction,
      // The position, as distinct from the view. A bearish view buys a put, and buying a put is a
      // long position: it profits when the premium rises. The evaluator orders the levels by this
      // field, not by `direction`, and reading the two as the same thing made every option plan
      // unevaluable - it demanded a short's level order from a long's numbers, forever.
      position: 'LONG',
      spot: round(spot, 2),
      spotSource: anchor.source,
      instrument: instrumentName(symbol, contract, pick.optionType),
      strike: round(num(contract.strike), 2),
      optionType: pick.optionType,
      expiry: contract.expiry || null,
      entry: round(premium, 2),
      stop: round(premium * (1 - premiumStopPct), 2),
      target: round(premium * (1 + premiumStopPct * reward), 2),
      rr: round(reward, 2),
      premiumStopPct,
      liquidity,
      reasons: [
        `ATM ${pick.optionType} ${contract.strike}${contract.expiry ? ` ${contract.expiry}` : ''} `
          + `from ${pick.considered || 1} surfaced ${pick.optionType} strike(s)`
          + (pick.droppedExpired ? `, ${pick.droppedExpired} expired ignored` : ''),
        `spot ${round(spot, 2)} (${anchor.source})`,
      ],
    };

    if (!liquidity.ok) {
      return {
        ok: false,
        plan,
        reason: `plan formed but liquidity is below the floor (${liquidity.reasons.join('; ')})`,
      };
    }
    return { ok: true, plan, reason: null };
  }

  if (!config.plan.spotFallback) {
    return { ok: false, plan: null, reason: pick.reason };
  }

  const stopLevel = spot * (1 - directionSign * underlyingStopPct);
  const plan = {
    kind: 'SPOT',
    symbol,
    horizon,
    direction,
    // A level plan on the underlying really is short when the view is bearish, so here the side
    // does follow the view - unlike an option plan, which is always long premium.
    position: directionSign === 1 ? 'LONG' : 'SHORT',
    spot: round(spot, 2),
    spotSource: anchor.source,
    instrument: `${symbol} spot/futures`,
    strike: null,
    optionType: null,
    expiry: null,
    entry: round(spot, 2),
    stop: round(stopLevel, 2),
    target: round(spot * (1 + directionSign * underlyingStopPct * reward), 2),
    rr: round(reward, 2),
    underlyingStopPct,
    // A level plan on an index/underlying needs no contract-level liquidity, but we say so
    // explicitly rather than pretending we checked something.
    liquidity: {
      ok: true,
      volume: num(flow && flow.underlyingVolume) || 0,
      oi: null,
      optionContracts: num(flow && flow.optionCount) || 0,
      reasons: ['spot fallback plan: no contract-level liquidity check'],
    },
    reasons: [pick.reason, `spot ${round(spot, 2)} (${anchor.source})`],
  };
  return { ok: true, plan, reason: null };
}

// Stable identity of a plan, used to notice that a still-READY setup has changed underneath the
// verdict (a new strike or a moved stop), which re-writes the stage row and re-candidates.
function planSignature(plan) {
  if (!plan) return 'none';
  return [
    plan.kind,
    plan.position || 'X',
    plan.instrument,
    plan.entry,
    plan.stop,
    plan.target,
    plan.liquidity ? (plan.liquidity.ok ? 'liq' : 'illiquid') : 'noliq',
  ].join('|');
}

// ---------------------------------------------------------------------------
// The lifecycle state machine
// ---------------------------------------------------------------------------
function computeStage({ verdict, plan, planReason, config }) {
  const direction = String(verdict.direction || 'NEUTRAL').toUpperCase();

  if (direction === 'NEUTRAL') {
    return {
      stage: 'IDLE',
      planReady: false,
      liquidityOk: false,
      reasons: [`bias NEUTRAL (score ${verdict.score})`],
    };
  }

  if (!plan) {
    return {
      stage: 'WATCH',
      planReady: false,
      liquidityOk: false,
      reasons: [`bias ${direction} but no tradeable plan yet`, planReason || 'no plan'],
    };
  }

  const liquidityOk = Boolean(plan.liquidity && plan.liquidity.ok);
  if (!liquidityOk) {
    return {
      stage: 'WATCH',
      planReady: true,
      liquidityOk: false,
      reasons: [
        `bias ${direction} with a formed plan, but it is not tradeable yet`,
        ...(plan.liquidity && Array.isArray(plan.liquidity.reasons) ? plan.liquidity.reasons : []),
      ],
    };
  }

  const confidence = num(verdict.confidence);
  if (confidence !== null && confidence >= config.stages.readyConfidence) {
    return {
      stage: 'READY',
      planReady: true,
      liquidityOk: true,
      reasons: [`bias ${direction} at ${round(confidence, 2)} confidence with a tradeable ${plan.kind} plan`],
    };
  }

  return {
    stage: 'BUILDING',
    planReady: true,
    liquidityOk: true,
    reasons: [
      `bias ${direction} with a tradeable plan, confidence ${round(confidence === null ? 0 : confidence, 2)} `
        + `below the ready floor ${config.stages.readyConfidence}`,
    ],
  };
}

// A stage row is only written when it says something new. Without this a 24/7 loop would append
// an identical row every minute for every symbol and horizon. Mirrors the bias meter's gate.
function isStageMaterialChange(previous, next, { scoreDelta, maxStaleMinutes }, now = Date.now()) {
  if (!previous) return true;
  if (previous.stage !== next.stage) return true;
  if (previous.direction !== next.direction) return true;
  if ((previous.plan_signature || 'none') !== next.planSignature) return true;
  const priorScore = num(previous.score);
  if (priorScore === null || Math.abs(priorScore - next.score) >= scoreDelta) return true;
  const priorAt = previous.as_of instanceof Date ? previous.as_of.getTime() : Date.parse(previous.as_of || '');
  if (!Number.isFinite(priorAt)) return true;
  return now - priorAt >= maxStaleMinutes * 60000;
}

// A READY-entry (or a materially changed READY) is what produces a candidate. Deduping on the
// minute keeps a replay or a crash-restart from emitting the same candidate twice.
function candidateDedupeKey({ horizon, symbol, direction, plan, readyAt }) {
  const bucket = new Date(readyAt).toISOString().slice(0, 16);
  return [
    horizon,
    symbol,
    direction,
    plan.kind,
    plan.strike === null || plan.strike === undefined ? 'X' : plan.strike,
    plan.expiry || 'X',
    bucket,
  ].join('|');
}

function isOwnedStage(stage) {
  return OWNED_STAGES.includes(String(stage || '').toUpperCase());
}

module.exports = {
  STAGES,
  OWNED_STAGES,
  HORIZONS,
  ENGINE_VERSION,
  DEFAULT_SIGNAL_CONFIG,
  resolveSignalConfig,
  horizonValue,
  underlyingPrice,
  selectContract,
  liquidityCheck,
  instrumentName,
  buildPlan,
  planSignature,
  computeStage,
  isStageMaterialChange,
  candidateDedupeKey,
  isOwnedStage,
};
