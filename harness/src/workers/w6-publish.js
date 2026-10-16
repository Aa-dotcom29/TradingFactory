'use strict';

// Worker 6 - the publisher.
//
// Consumes `signal.approved`, writes the immutable published signal row, delivers it, and records
// both in `signal_events`. It is driven by the queue but does not trust it: the message carries a
// candidate id, and everything else is re-read from `signal_candidates`. The signal row is keyed
// on the candidate's dedupe key, so a replayed message publishes the same signal once or nothing
// at all. A safety-net scan also picks up any candidate that is approved but has no signal row,
// which keeps the durable tables - not the queue - the source of truth.
//
// Delivery is shadow-first: PUBLISH_MODE defaults to `shadow`, where the exact message is
// composed and logged but nothing leaves the machine. The row is still written, tagged
// mode=shadow, so the whole path is exercised and auditable before a single real alert is sent.

const config = require('../config');
const db = require('../db');
const queue = require('../queue');
const { TOPICS } = require('../topics');
const { formatSignal, TelegramClient } = require('../telegram');

const log = require('../logger').child({ module: 'w6' });

const ENGINE_VERSION = 'publish-engine-1';
const TERMINAL_STATES = ['DELIVERED', 'SHADOWED'];

class PublishWorker {
  constructor(options = {}) {
    this.workerName = options.workerName || config.workerName;
    this.batchSize = options.batchSize || 25;
    this.maxPerDrain = options.maxPerDrain || 500;
    this.leaseSeconds = options.leaseSeconds || 120;
    this.maxOrphans = options.maxOrphans || 50;
    this.dryRun = options.dryRun ?? config.dryRun;
    this.mode = String(options.mode || config.publish.mode || 'shadow').toLowerCase();
    this.telegram = options.telegram || new TelegramClient({ mode: this.mode });
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

  async loadCandidate(id) {
    const sql = this.sql;
    const rows = await sql`
      select id, as_of, created_at, horizon, symbol, direction, strategy, strategy_version,
             engine_version, config_version, kind, instrument, strike, option_type, expiry,
             entry, target, stop, rr, confidence, score, liquidity_ok, status, dedupe_key,
             setup, reasons
      from signal_candidates
      where id = ${id}::uuid
    `;
    return rows[0] || null;
  }

  // The risk config version that approved this candidate, read from the gate's own decision row
  // so the published signal records which limits were in force. Not carried in memory: a replay
  // or an orphan scan must reach the same answer.
  async latestRiskVersion(candidateId) {
    const sql = this.sql;
    const rows = await sql`
      select config_version from risk_decisions
      where candidate_id = ${candidateId}::uuid and decision = 'APPROVED'
      order by evaluated_at desc
      limit 1
    `;
    return rows.length ? rows[0].config_version : null;
  }

  // Writes the immutable signal row for a candidate, then delivers it once. Idempotent: the
  // unique key is (strategy, setup_key), so a replay finds the existing row instead of a second.
  async publishCandidate(candidate, riskConfigVersion = null) {
    const sql = this.sql;
    const mode = this.telegram.shadow ? 'shadow' : 'live';
    const riskVersion = riskConfigVersion || await this.latestRiskVersion(candidate.id);

    let signalId = null;
    let created = false;
    const existing = await sql`
      select id from signals where setup_key = ${candidate.dedupe_key} limit 1
    `;
    if (existing.length) {
      signalId = existing[0].id;
    } else {
      const snapshot = {
        mode,
        candidateId: candidate.id,
        riskConfigVersion: riskVersion,
        signalConfigVersion: candidate.config_version,
        score: candidate.score === null || candidate.score === undefined ? null : Number(candidate.score),
        plan: candidate.setup,
        reasons: candidate.reasons,
      };
      const inserted = await sql`
        insert into signals (
          horizon, strategy, symbol, direction, instrument, strike, option_type,
          entry, target, stop, rr, probability, confidence, strategy_version, engine_version,
          model_version, config_version, setup_key, snapshot
        ) values (
          ${candidate.horizon}, ${candidate.strategy}, ${candidate.symbol}, ${candidate.direction},
          ${candidate.instrument}, ${candidate.strike}, ${candidate.option_type},
          ${candidate.entry}, ${candidate.target}, ${candidate.stop}, ${candidate.rr}, null,
          ${candidate.confidence}, ${candidate.strategy_version || ENGINE_VERSION}, ${ENGINE_VERSION},
          null, ${candidate.config_version}, ${candidate.dedupe_key}, ${sql.json(snapshot)}
        )
        on conflict (strategy, setup_key) do nothing
        returning id
      `;
      if (inserted.length) {
        signalId = inserted[0].id;
        created = true;
      } else {
        const again = await sql`
          select id from signals where setup_key = ${candidate.dedupe_key} limit 1
        `;
        if (!again.length) {
          throw new Error(`signal row for ${candidate.dedupe_key} was neither inserted nor found`);
        }
        signalId = again[0].id;
      }
    }

    if (created) {
      await sql`
        insert into signal_events (signal_id, previous_state, new_state, reason, market_snapshot)
        values (${signalId}::uuid, null, 'PUBLISHED',
                ${`risk gate approved (${riskVersion || 'risk'})`},
                ${sql.json({ mode, candidateId: candidate.id, horizon: candidate.horizon, riskConfigVersion: riskVersion })})
      `;
    }

    const settled = await sql`
      select new_state from signal_events
      where signal_id = ${signalId}::uuid and new_state in ('DELIVERED', 'SHADOWED')
      order by at desc
      limit 1
    `;
    if (settled.length) return { status: 'already-delivered', state: settled[0].new_state, signalId };

    const text = formatSignal(candidate, { mode });
    const result = await this.telegram.send(text);
    const state = result.delivered ? 'DELIVERED' : (result.skipped === 'shadow' ? 'SHADOWED' : 'DELIVERY_FAILED');
    const reason = result.delivered
      ? 'delivered to telegram'
      : (result.skipped === 'shadow'
        ? 'composed in shadow mode; nothing was delivered'
        : `delivery failed: ${result.error || result.skipped}`);

    await sql`
      insert into signal_events (signal_id, previous_state, new_state, reason, market_snapshot)
      values (${signalId}::uuid, 'PUBLISHED', ${state}, ${reason},
              ${sql.json({ channel: 'telegram', mode, ...result })})
    `;

    if (state === 'SHADOWED') {
      log.info('signal composed (shadow)', {
        horizon: candidate.horizon,
        symbol: candidate.symbol,
        entry: candidate.entry,
        text,
      });
    }

    return { status: state, signalId, delivered: result.delivered };
  }

  // The queue is a latency optimisation. This is the durable path: any candidate the gate has
  // approved but which has no signal row yet is published here, so a lost notification cannot
  // strand an approved trade.
  async publishOrphans() {
    const sql = this.sql;
    const rows = await sql`
      select c.id
      from signal_candidates c
      left join signals s on s.setup_key = c.dedupe_key
      where c.status = 'approved' and s.id is null
      order by c.created_at asc
      limit ${this.maxOrphans}
    `;
    let published = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const candidate = await this.loadCandidate(row.id);
        if (!candidate || candidate.status !== 'approved') continue;
        const result = await this.publishCandidate(candidate);
        if (result.state === 'DELIVERY_FAILED') failed += 1;
        else published += 1;
      } catch (error) {
        failed += 1;
        log.warn('could not publish approved candidate', { id: row.id, error: error.message });
      }
    }
    return { orphans: rows.length, published, failed };
  }

  async process(message) {
    const payload = message && message.payload ? message.payload : {};
    const candidateId = payload.candidateId || payload.candidate_id;
    if (!candidateId) return { status: 'ignored', reason: 'message carried no candidate id' };

    const candidate = await this.loadCandidate(candidateId);
    if (!candidate) return { status: 'ignored', reason: 'candidate no longer exists' };
    if (candidate.status !== 'approved') {
      return { status: 'ignored', reason: `candidate is ${candidate.status}, not approved` };
    }

    const result = await this.publishCandidate(candidate, payload.riskConfigVersion || null);
    return result;
  }

  async drain(options = {}) {
    const max = options.max ?? this.maxPerDrain;
    const summary = { triggers: 0, published: 0, failed: 0, ignored: 0, batches: 0 };
    if (this.dryRun) {
      log.info('publish drain (dry run)');
      return summary;
    }
    if (!this.sql) {
      log.warn('publish drain skipped: no database connection');
      return summary;
    }

    let handled = 0;
    while (handled < max) {
      const messages = await queue.reserve(
        TOPICS.SIGNAL_APPROVED,
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
          if (result.status === 'DELIVERY_FAILED') {
            summary.failed += 1;
            await queue.nack(message.id, result.status);
          } else if (result.status === 'ignored' || result.status === 'already-delivered') {
            summary.ignored += 1;
            await queue.ack(message.id);
          } else {
            summary.published += 1;
            await queue.ack(message.id);
          }
        } catch (error) {
          summary.failed += 1;
          await queue.nack(message.id, error.message).catch(() => {});
          log.warn('could not publish approved signal', { id: message.id, error: error.message });
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
        const orphans = await this.publishOrphans();
        summary.orphans = orphans.orphans;
        summary.published += orphans.published;
        summary.failed += orphans.failed;
      } catch (error) {
        summary.error = error.message;
        log.warn('orphan publish scan failed', { error: error.message });
      }
    }

    const mode = this.telegram.shadow ? 'shadow' : 'live';
    if (summary.failed) {
      await this.markSource('publisher', 'WARNING', `${summary.failed} publish failure(s) (mode ${mode})`);
    } else {
      await this.markSource(
        'publisher',
        'HEALTHY',
        `${summary.published} published, ${summary.ignored || 0} ignored (mode ${mode})`,
      );
    }
    return summary;
  }
}

module.exports = { PublishWorker, ENGINE_VERSION };
