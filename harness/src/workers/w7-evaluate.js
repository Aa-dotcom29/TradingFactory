'use strict';

// Worker 7 - the evaluator.
//
// Every worker before this one describes what to do. W7 is the first that asks what happened.
//
// A published signal is an open position. W7 re-reads each one from `signals` (never from the
// queue payload), walks the price readings recorded since publication, and decides whether the
// target, the stop, or simply the horizon's holding window ended the trade. The verdict becomes
// one immutable `outcomes` row plus an `EXITED`/`EXPIRED` event on the signal.
//
// Those rows are not decoration. The risk gate's loss controls - consecutive-loss halt, cooldown
// after a loss, and the daily loss limit - have been implemented and tested since Slice 5, and
// they have reported SKIPPED on every single evaluation, because `outcomes` was always empty.
// W7 is what fills it.
//
// Three things W7 deliberately does not do:
//
//   * It never scores an option-premium plan against the underlying price. The plan's levels are
//     premiums and spot readings are not premiums, so such a pair is refused outright. Since
//     Slice 8 W0 persists each held option's own premium series, so an option plan is scored
//     against that; until a reading exists it is reported as awaiting a price source, and once its
//     window elapses it settles with no verdict - so it neither invents a return nor stays open
//     forever.
//   * It does not trust the storage time of a quote. A quote is dated by the market timestamp it
//     carries, so a Friday close re-stored on Monday cannot masquerade as fresh momentum.
//   * It does not apply a config change. It may propose one, written as a `candidate` row in
//     `config_registry` that no worker will ever read, because every worker resolves the latest
//     `approved` version. Learning is human-approved or it is not learning.

const config = require('../config');
const db = require('../db');
const queue = require('../queue');
const { TOPICS } = require('../topics');
const { DEFAULT_RISK_CONFIG, resolveRiskConfig } = require('../risk');
const { STATUS, RESULT, evaluateOutcome, scoreOutcomes, proposeConfigChange, planKind, PRICE_SOURCE } = require('../outcome');
const { contractKey, priceSourceFor } = require('../contract');

const log = require('../logger').child({ module: 'w7' });

const ENGINE_VERSION = 'evaluate-engine-1';
const CONFIG_FAMILY = 'risk';
const PROPOSAL_AUTHOR = 'w7-evaluator';
const OUTCOME_RETENTION_DAYS = 90;

class EvaluateWorker {
  constructor(options = {}) {
    this.workerName = options.workerName || config.workerName;
    this.batchSize = options.batchSize || 25;
    this.maxPerDrain = options.maxPerDrain || 500;
    this.leaseSeconds = options.leaseSeconds || 120;
    this.maxPerRun = options.maxPerRun || 200;
    this.dryRun = options.dryRun ?? config.dryRun;
    this.proposals = options.proposals ?? true;
    this.configTtlMs = options.configTtlMs || 60000;
    this.startedAt = new Date().toISOString();
  }

  get sql() {
    return db.client();
  }

  async markSource(source, status, detail) {
    const sql = this.sql;
    if (!sql) return;
    const ok = status === 'HEALTHY';
    await sql`
      insert into sources_health (source, status, detail, last_ok_at, last_error_at, checked_at)
      values (${source}, ${status}, ${detail || null},
              ${ok ? new Date() : null}, ${ok ? null : new Date()}, now())
      on conflict (source) do update set
        status = excluded.status,
        detail = excluded.detail,
        last_ok_at = coalesce(excluded.last_ok_at, sources_health.last_ok_at),
        last_error_at = coalesce(excluded.last_error_at, sources_health.last_error_at),
        checked_at = now()
    `;
  }

  // W7 needs the holding window, which lives in the risk family because that is where "how long
  // a position is held" already belongs. It reads the approved row; it never seeds or edits one,
  // because the limits have exactly one owner (W5) and a second writer is how limits drift.
  async ensureConfig(options = {}) {
    const now = options.now ?? Date.now();
    if (this.configCache && now - this.configCacheAt < this.configTtlMs) return this.configCache;

    let resolved = { version: DEFAULT_RISK_CONFIG.version, config: resolveRiskConfig(null) };
    const sql = this.sql;
    if (sql) {
      try {
        const rows = await sql`
          select version, config
          from config_registry
          where status = 'approved' and family = ${CONFIG_FAMILY}
          order by approved_at desc nulls last, created_at desc
          limit 1
        `;
        if (rows.length) {
          resolved = { version: rows[0].version, config: resolveRiskConfig(rows[0].config) };
        }
      } catch (error) {
        log.warn('could not resolve risk config, using built-in baseline', { error: error.message });
      }
    }

    this.configCache = resolved;
    this.configCacheAt = now;
    return resolved;
  }

  // The open ledger: every published signal that has no outcome yet, oldest first. This is the
  // durable path and the source of truth - the queue only ever tells W7 to look again.
  async loadOpenSignals(limit) {
    const sql = this.sql;
    return sql`
      select s.id, s.horizon, s.symbol, s.direction, s.instrument, s.strike, s.option_type,
             s.entry, s.target, s.stop, s.published_at, s.snapshot
      from signals s
      left join outcomes o on o.signal_id = s.id
      where o.id is null
      order by s.published_at asc
      limit ${limit}
    `;
  }

  async loadSignal(id) {
    const sql = this.sql;
    const rows = await sql`
      select id, horizon, symbol, direction, instrument, strike, option_type,
             entry, target, stop, published_at, snapshot
      from signals
      where id = ${id}::uuid
    `;
    return rows[0] || null;
  }

  // The price path, dated by the market timestamp the quote carries rather than by when we
  // happened to store it. The two differ by exactly the amount that would let a stale close
  // register as a fresh level breach, so the quote's own clock wins.
  //
  // Which series to read depends on the plan. An option-premium plan is judged against that
  // option's own premium history (`option.quote.v1`, keyed by the contract), everything else
  // against the underlying quote history. A contract that cannot be identified yields an empty
  // path, so the position is parked as awaiting a price source rather than silently scored against
  // the wrong instrument.
  //
  // The chosen series' high and low are the *day's* range and are deliberately not passed on: a
  // daily high is not a bar, and treating it as one would report the target as hit on the open.
  async loadPricePath(signal) {
    const sql = this.sql;
    const plan = (signal.snapshot && signal.snapshot.plan) || null;
    const source = priceSourceFor(planKind(signal, plan));

    if (source === PRICE_SOURCE.OPTION) {
      const key = contractKey({
        symbol: signal.symbol,
        expiry: plan && plan.expiry,
        strike: signal.strike,
        optionType: signal.option_type,
      });
      if (!key) {
        return { source, path: [], contractKey: null, reason: 'the option contract could not be identified' };
      }
      const path = await sql`
        select coalesce((f.values ->> 'quoteTime')::timestamptz, f.as_of) as at,
               (f.values ->> 'ltp') as price
        from features f
        where f.feature_set = ${source}
          and f.symbol = ${key}
          and f.as_of >= ${signal.published_at}
        order by at asc
      `;
      return { source, path, contractKey: key };
    }

    const path = await sql`
      select coalesce((f.values ->> 'quoteTime')::timestamptz, f.as_of) as at,
             (f.values ->> 'ltp') as price
      from features f
      where f.feature_set = ${source}
        and f.symbol = ${signal.symbol}
        and f.as_of >= ${signal.published_at}
      order by at asc
    `;
    return { source, path };
  }

  async latestEventState(signalId) {
    const sql = this.sql;
    const rows = await sql`
      select new_state from signal_events
      where signal_id = ${signalId}::uuid
      order by at desc
      limit 1
    `;
    return rows.length ? rows[0].new_state : null;
  }

  // Writes the closed trade. Idempotent on signal_id: a replayed trigger or a concurrent scan
  // collides with the existing row instead of inventing a second outcome for one position.
  async recordOutcome(signal, evaluation, configVersion) {
    const sql = this.sql;
    const settled = evaluation.result === RESULT.NO_PRICE_SOURCE || evaluation.result === RESULT.TIME;
    const state = settled ? 'EXPIRED' : 'EXITED';
    const reason = evaluation.unpriced
      ? `${evaluation.result}: ${evaluation.reason}`
      : `${evaluation.result} at ${evaluation.exit} (${evaluation.pnlPct}%) after ${evaluation.heldMinutes} minute(s)`;
    const payload = {
      engineVersion: ENGINE_VERSION,
      configVersion,
      priceSource: evaluation.priceSource || null,
      result: evaluation.result,
      unpriced: Boolean(evaluation.unpriced),
      ambiguous: evaluation.ambiguous,
      exitAt: evaluation.exitAt,
      heldMinutes: evaluation.heldMinutes,
      heldDays: evaluation.heldDays,
      windowDays: evaluation.windowDays,
      entry: evaluation.entry,
      target: evaluation.target,
      stop: evaluation.stop,
      exit: evaluation.exit,
      mfePct: evaluation.mfePct,
      maePct: evaluation.maePct,
      readings: evaluation.readings,
    };

    const inserted = await sql`
      insert into outcomes (
        signal_id, horizon, result, entry, exit, pnl_pct, mfe, mae, bars_held, payload
      ) values (
        ${signal.id}::uuid, ${evaluation.horizon}, ${evaluation.result},
        ${evaluation.entry}, ${evaluation.exit}, ${evaluation.pnlPct},
        ${evaluation.mfePct}, ${evaluation.maePct}, ${evaluation.readings}, ${sql.json(payload)}
      )
      on conflict (signal_id) do nothing
      returning id
    `;
    if (!inserted.length) return { created: false, state };

    const previous = await this.latestEventState(signal.id);
    await sql`
      insert into signal_events (signal_id, previous_state, new_state, reason, market_snapshot)
      values (${signal.id}::uuid, ${previous}, ${state}, ${reason}, ${sql.json(payload)})
    `;
    return { created: true, state };
  }

  async evaluateSignal(signal, configVersion) {
    const loaded = await this.loadPricePath(signal);
    const holdingDays = holdingDaysFor(this.configCache?.config, signal.horizon);
    const evaluation = evaluateOutcome({
      signal: {
        horizon: signal.horizon,
        symbol: signal.symbol,
        direction: signal.direction,
        instrument: signal.instrument,
        strike: signal.strike,
        option_type: signal.option_type,
        entry: signal.entry,
        target: signal.target,
        stop: signal.stop,
        publishedAt: signal.published_at,
        snapshot: signal.snapshot,
      },
      path: loaded.path,
      priceSource: loaded.source,
      holdingDays,
      now: Date.now(),
    });

    // Keep the specific reason (an unidentifiable contract) visible instead of letting the generic
    // "awaiting a price source" message hide the one fact a person would need to fix it.
    if (loaded.reason && evaluation.reason) {
      evaluation.reason = `${evaluation.reason} (${loaded.reason})`;
    }

    if (evaluation.status !== STATUS.CLOSED) {
      return { status: evaluation.status, reason: evaluation.reason, signal: signal.id };
    }

    const written = await this.recordOutcome(signal, evaluation, configVersion);
    return {
      status: written.created ? 'CLOSED' : 'ALREADY_CLOSED',
      state: written.state,
      result: evaluation.result,
      pnlPct: evaluation.pnlPct,
      horizon: signal.horizon,
      symbol: signal.symbol,
      signal: signal.id,
    };
  }

  // The durable path. Everything the worker actually acts on is read here, not from a message.
  async evaluateOpen(options = {}) {
    const sql = this.sql;
    const limit = options.limit || this.maxPerRun;
    const { version } = await this.ensureConfig();
    const summary = {
      considered: 0, closed: 0, open: 0, awaiting: 0, unevaluable: 0, failed: 0,
    };
    if (!sql) return summary;

    const rows = await this.loadOpenSignals(limit);
    summary.considered = rows.length;

    for (const row of rows) {
      try {
        const result = await this.evaluateSignal(row, version);
        if (result.status === 'CLOSED') {
          summary.closed += 1;
          log.info('position closed', {
            horizon: result.horizon, symbol: result.symbol,
            result: result.result, pnlPct: result.pnlPct,
          });
        } else if (result.status === STATUS.AWAITING_PRICE_SOURCE) {
          summary.awaiting += 1;
        } else if (result.status === STATUS.UNEVALUABLE) {
          summary.unevaluable += 1;
          log.warn('position cannot be evaluated', { signal: result.signal, reason: result.reason });
        } else {
          summary.open += 1;
        }
      } catch (error) {
        summary.failed += 1;
        log.warn('could not evaluate position', { signal: row.id, error: error.message });
      }
    }
    return summary;
  }

  // Scoring reads the whole closed record inside the retention window, under the unit-correct
  // names the pure scorer expects.
  async loadScoredOutcomes() {
    const sql = this.sql;
    return sql`
      select signal_id, horizon, result, pnl_pct, mfe as mfe_pct, mae as mae_pct, evaluated_at
      from outcomes
      where evaluated_at >= now() - (${OUTCOME_RETENTION_DAYS} || ' days')::interval
    `;
  }

  async scorecard() {
    const rows = await this.loadScoredOutcomes();
    return scoreOutcomes(rows);
  }

  // The self-learning half. W7 proposes; a person decides. Nothing here can change what runs.
  async propose(options = {}) {
    const sql = this.sql;
    if (!sql) return { proposed: false, reason: 'no database connection' };
    if (!this.proposals) return { proposed: false, reason: 'proposals are switched off' };

    const pending = await sql`
      select version from config_registry
      where family = ${CONFIG_FAMILY} and status = 'candidate' and created_by = ${PROPOSAL_AUTHOR}
      order by created_at desc
      limit 1
    `;
    if (pending.length) {
      return { proposed: false, reason: `proposal ${pending[0].version} is already awaiting a human`, pending: pending[0].version };
    }

    const stats = await this.scorecard();
    const { version, config: current } = await this.ensureConfig();
    const proposal = proposeConfigChange({
      stats,
      currentConfig: { version, config: current },
      rules: options.rules,
    });
    if (!proposal.proposed) return proposal;

    const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
    const proposedVersion = `risk-w7-${stamp}`;
    const inserted = await sql`
      insert into config_registry (version, family, created_by, status, metrics, config)
      values (${proposedVersion}, ${CONFIG_FAMILY}, ${PROPOSAL_AUTHOR}, 'candidate',
              ${sql.json({
                reason: proposal.reason,
                change: proposal.change,
                baseVersion: version,
                sample: stats.total,
                winRatePct: stats.winRatePct,
                expectancyPct: stats.expectancyPct,
                ...stats.byHorizon,
              })},
              ${sql.json(proposal.config)})
      on conflict (version) do nothing
      returning version
    `;
    if (!inserted.length) return { proposed: false, reason: 'an identical proposal already exists' };

    log.info('config change proposed for human approval', {
      version: proposedVersion,
      change: proposal.change,
      reason: proposal.reason,
    });
    return { ...proposal, version: proposedVersion };
  }

  async process(message) {
    const payload = message && message.payload ? message.payload : {};
    const signalId = payload.signalId || payload.signal_id;
    if (!signalId) return { status: 'ignored', reason: 'message carried no signal id' };

    const signal = await this.loadSignal(signalId);
    if (!signal) return { status: 'ignored', reason: 'signal no longer exists' };

    const { version } = await this.ensureConfig();
    return this.evaluateSignal(signal, version);
  }

  async drain(options = {}) {
    const max = options.max ?? this.maxPerDrain;
    const summary = { triggers: 0, closed: 0, ignored: 0, batches: 0 };
    if (this.dryRun) {
      log.info('evaluate drain (dry run)');
      return summary;
    }
    if (!this.sql) {
      log.warn('evaluate drain skipped: no database connection');
      return summary;
    }

    let handled = 0;
    while (handled < max) {
      const messages = await queue.reserve(
        TOPICS.PUBLISHED,
        this.workerName,
        Math.min(this.batchSize, max - handled),
        this.leaseSeconds,
      );
      if (!messages.length) break;
      summary.batches += 1;

      for (const message of messages) {
        handled += 1;
        summary.triggers += 1;
        try {
          const result = await this.process(message);
          if (result.status === 'CLOSED') summary.closed += 1;
          else summary.ignored += 1;
          await queue.ack(message.id);
        } catch (error) {
          await queue.nack(message.id, error.message).catch(() => {});
          log.warn('could not evaluate signal', { id: message.id, error: error.message });
        }
      }
    }
    return summary;
  }

  async runOnce(options = {}) {
    const drained = await this.drain(options);
    const summary = { ...drained };

    if (!this.dryRun && this.sql) {
      try {
        const evaluated = await this.evaluateOpen(options);
        summary.open = evaluated.considered;
        summary.closed += evaluated.closed;
        summary.awaiting = evaluated.awaiting;
        summary.unevaluable = evaluated.unevaluable;
        summary.failed = evaluated.failed;

        const stats = await this.scorecard();
        summary.scorecard = { total: stats.total, wins: stats.wins, losses: stats.losses, winRatePct: stats.winRatePct };
      } catch (error) {
        summary.error = error.message;
        log.warn('open-position scan failed', { error: error.message });
      }

      if (this.proposals) {
        try {
          const proposal = await this.propose(options);
          summary.proposal = proposal.proposed ? proposal.version : null;
          if (!proposal.proposed) summary.proposalReason = proposal.reason;
        } catch (error) {
          log.warn('proposal pass failed', { error: error.message });
        }
      }
    }

    const detail = `${summary.closed || 0} closed of ${summary.open || 0} open`
      + `${summary.awaiting ? `, ${summary.awaiting} awaiting a price source` : ''}`
      + `${summary.unevaluable ? `, ${summary.unevaluable} unevaluable` : ''}`;
    if (summary.failed) {
      await this.markSource('evaluator', 'WARNING', `${summary.failed} evaluation failure(s)`);
    } else {
      await this.markSource('evaluator', 'HEALTHY', detail);
    }
    return summary;
  }
}

// The holding window comes from the risk config, which is where it already belongs, and it is
// resolved through the same helper the gate uses so the two can never disagree about how long a
// position is open.
function holdingDaysFor(riskConfig, horizon) {
  const gates = (riskConfig && riskConfig.gates) || DEFAULT_RISK_CONFIG.gates;
  const map = gates.holdingDays || DEFAULT_RISK_CONFIG.gates.holdingDays;
  const value = map && map[String(horizon || '').toUpperCase()];
  return Number.isFinite(Number(value)) ? Number(value) : 30;
}

module.exports = { EvaluateWorker, ENGINE_VERSION, holdingDaysFor };
