'use strict';

// Worker 9 - live tape and order book.
//
// The REST quote path samples a price every few seconds. That is enough for a bias meter
// but not for a footprint: a footprint needs every print and the book that was standing
// when it arrived. Angel One's SmartAPI WebSocket is the free source that can supply both.
//
// What this worker deliberately does NOT claim:
//   * Snap Quote carries five book levels; Depth mode carries twenty for NSE cash only.
//     Neither is the exchange's full anonymous order book.
//   * The packet has no aggressor flag. `classifySide` estimates the taker from the print
//     against the best bid/ask and records a confidence, so the dashboard can label the
//     result as tape-derived rather than exchange-certified.
//
// The worker keeps a bounded token set: the configured universe plus every open option
// plan. That is enough for the household's open trades and stays inside the broker's
// subscription quota. It re-reads the open plans once a minute and reconciles subscriptions
// instead of reconnecting for every change.

const WebSocket = require('ws');
const config = require('../config');
const db = require('../db');
const log = require('../logger').child({ module: 'w9' });
const { isMarketOpen, marketSession } = require('../session');
const { AngelClient, configured: angelConfigured } = require('../sources/angel-client');
const { contractKey, matchOptionToken, underlyingAlias } = require('../contract');
const {
  MODE, parseAngelPackets, bestPrices, classifySide, volumeDelta, depthSummary,
} = require('../sources/angel-tape');

const SOURCE = 'angel-tape';
const WS_URL = 'wss://smartapisocket.angelone.in/smart-stream';
const MAX_PENDING = 5000;

function exchangeName(type) {
  if (type === 2) return 'NSE';
  if (type === 4) return 'BSE';
  if (type === 5) return 'MCX';
  return 'NSE';
}

function isoNow() {
  return new Date().toISOString();
}

class TapeWorker {
  constructor(options = {}) {
    this.workerName = options.workerName || config.workerName;
    this.angel = options.angel || new AngelClient();
    this.stopped = true;
    this.connecting = false;
    this.socket = null;
    this.reconnectTimer = null;
    this.marketTimer = null;
    this.refreshTimer = null;
    this.healthTimer = null;
    this.flushTimer = null;
    this.lastTickAt = null;
    this.lastError = null;
    this.lastHealthAt = 0;
    this.subscriptions = new Map();
    this.mode3 = new Set();
    this.mode4 = new Set();
    this.lastVolume = new Map();
    this.lastDepthWrite = new Map();
    this.pendingTicks = [];
    this.pendingDepths = [];
    this.stats = { ticks: 0, depths: 0, packets: 0, errors: 0, flushes: 0 };
  }

  get sql() {
    return db.client();
  }

  async markSource(status, detail) {
    const sql = this.sql;
    if (!sql) return;
    const ok = status === 'HEALTHY';
    const fault = status === 'WARNING' || status === 'ERROR';
    try {
      await sql`
        insert into sources_health (source, status, detail, last_ok_at, last_error_at, checked_at)
        values (${SOURCE}, ${status}, ${detail || null},
                ${ok ? new Date() : null}, ${fault ? new Date() : null}, now())
        on conflict (source) do update set
          status = excluded.status,
          detail = excluded.detail,
          last_ok_at = coalesce(excluded.last_ok_at, sources_health.last_ok_at),
          last_error_at = coalesce(excluded.last_error_at, sources_health.last_error_at),
          checked_at = now()
      `;
    } catch (error) {
      log.warn('could not record tape health', { error: error.message });
    }
  }

  async start() {
    if (this.stopped === false) return;
    this.stopped = false;
    if (!config.tape.enabled) {
      await this.markSource('DISABLED', 'HARNESS_TAPE_ENABLED=false');
      return;
    }
    if (config.dryRun) {
      await this.markSource('IDLE', 'dry run; no broker socket opened');
      return;
    }
    if (!angelConfigured()) {
      await this.markSource('DISABLED', 'Angel One credentials are not configured');
      return;
    }
    if (!this.sql) {
      await this.markSource('IDLE', 'no database connection');
      return;
    }

    this.refreshTimer = setInterval(() => {
      this.refreshSubscriptions().catch((error) => log.warn('tape subscription refresh failed', { error: error.message }));
    }, Math.max(15000, config.tape.refreshMs));
    this.healthTimer = setInterval(() => {
      this.health().catch((error) => log.warn('tape health update failed', { error: error.message }));
    }, 30000);
    this.refreshTimer.unref?.();
    this.healthTimer.unref?.();

    await this.connect();
  }

  async stop() {
    this.stopped = true;
    for (const timer of [this.reconnectTimer, this.marketTimer, this.refreshTimer, this.healthTimer, this.flushTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.reconnectTimer = this.marketTimer = this.refreshTimer = this.healthTimer = this.flushTimer = null;
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.removeAllListeners();
      if (socket.readyState < WebSocket.CLOSING) socket.close();
    }
    await this.flush().catch(() => {});
    await this.markSource('IDLE', 'tape worker stopped');
  }

  async connect() {
    if (this.stopped || this.connecting || this.socket) return;
    if (!isMarketOpen()) {
      await this.markSource('IDLE', `market closed: ${marketSession().reason || 'outside the session'}`);
      this.scheduleMarketCheck();
      return;
    }

    this.connecting = true;
    this.lastError = null;
    try {
      await this.angel.login();
      await this.angel.ensureInstruments();
      await this.refreshSubscriptions();
      await this.openSocket();
      await this.markSource('HEALTHY', `${this.subscriptions.size} token(s) subscribed; waiting for first print`);
    } catch (error) {
      this.lastError = error.message;
      this.stats.errors += 1;
      await this.markSource('ERROR', error.message);
      log.warn('tape connect failed', { error: error.message });
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    if (!isMarketOpen()) {
      this.scheduleMarketCheck();
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => log.warn('tape reconnect failed', { error: error.message }));
    }, Math.max(1000, config.tape.reconnectMs));
    this.reconnectTimer.unref?.();
  }

  scheduleMarketCheck() {
    if (this.stopped || this.marketTimer) return;
    this.marketTimer = setTimeout(() => {
      this.marketTimer = null;
      if (isMarketOpen()) this.connect().catch((error) => log.warn('tape open failed', { error: error.message }));
      else this.scheduleMarketCheck();
    }, 60000);
    this.marketTimer.unref?.();
  }

  async loadOpenOptions() {
    const sql = this.sql;
    if (!sql) return [];
    try {
      return await sql`
        select s.id, s.symbol, s.strike, s.option_type, s.snapshot
        from active_signals s
        where s.strike is not null
          and s.option_type in ('CE', 'PE')
        order by s.published_at asc
        limit 100
      `;
    } catch (error) {
      log.warn('could not load open option plans for tape', { error: error.message });
      return [];
    }
  }

  async refreshSubscriptions() {
    if (!this.angel.instruments) return;
    const wanted = new Map();

    const indices = this.angel.resolveIndexTokens();
    for (const row of indices) {
      wanted.set(String(row.token), {
        token: String(row.token), symbol: underlyingAlias(row.name), contract: null, exchangeType: 1, depth: false,
      });
    }

    const equities = this.angel.resolveEquityTokens(config.universe.equities);
    for (const row of equities) {
      wanted.set(String(row.token), {
        token: String(row.token), symbol: underlyingAlias(row.name), contract: null, exchangeType: 1, depth: true,
      });
    }

    const open = await this.loadOpenOptions();
    for (const row of open) {
      const plan = (row.snapshot && row.snapshot.plan) || {};
      const target = {
        symbol: row.symbol, expiry: plan.expiry, strike: row.strike, optionType: row.option_type,
      };
      const key = contractKey(target);
      const match = key ? matchOptionToken(this.angel.instruments, target) : null;
      if (!match) continue;
      wanted.set(String(match.token), {
        token: String(match.token), symbol: underlyingAlias(row.symbol), contract: key, exchangeType: 2, depth: false,
      });
    }

    const mode3 = new Set(wanted.keys());
    const mode4 = new Set(
      [...wanted.values()].filter((row) => row.depth).slice(0, Math.max(0, config.tape.depthTokens)).map((row) => row.token),
    );

    const added3 = [...mode3].filter((token) => !this.mode3.has(token));
    const removed3 = [...this.mode3].filter((token) => !mode3.has(token));
    const added4 = [...mode4].filter((token) => !this.mode4.has(token));
    const removed4 = [...this.mode4].filter((token) => !mode4.has(token));

    this.subscriptions = wanted;
    this.mode3 = mode3;
    this.mode4 = mode4;

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      if (removed3.length) this.send({ action: 0, params: { mode: MODE.SNAP_QUOTE, tokenList: this.groupTokens(removed3) } });
      if (removed4.length) this.send({ action: 0, params: { mode: MODE.DEPTH, tokenList: this.groupTokens(removed4) } });
      if (added3.length) this.send({ action: 1, params: { mode: MODE.SNAP_QUOTE, tokenList: this.groupTokens(added3) } });
      if (added4.length) this.send({ action: 1, params: { mode: MODE.DEPTH, tokenList: this.groupTokens(added4) } });
    }
  }

  groupTokens(tokens) {
    const groups = new Map();
    for (const token of tokens) {
      const info = this.subscriptions.get(String(token));
      if (!info) continue;
      const type = info.exchangeType;
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type).push(String(token));
    }
    return [...groups.entries()].map(([exchangeType, values]) => ({ exchangeType, tokens: values }));
  }

  send(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify({ correlationID: 'tf-tape', ...payload }));
    } catch (error) {
      log.warn('tape send failed', { error: error.message });
    }
  }

  subscribeAll() {
    if (this.mode3.size) this.send({ action: 1, params: { mode: MODE.SNAP_QUOTE, tokenList: this.groupTokens([...this.mode3]) } });
    if (this.mode4.size) this.send({ action: 1, params: { mode: MODE.DEPTH, tokenList: this.groupTokens([...this.mode4]) } });
  }

  openSocket() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(WS_URL, {
        headers: {
          'x-client-code': config.angel.clientId,
          Authorization: this.angel.accessToken,
          'x-api-key': config.angel.apiKey,
          'x-feed-token': this.angel.feedToken,
        },
        handshakeTimeout: 15000,
        maxPayload: 4 * 1024 * 1024,
      });
      this.socket = socket;
      let settled = false;
      const fail = (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      socket.on('open', () => {
        this.lastError = null;
        this.subscribeAll();
        settled = true;
        resolve();
      });
      socket.on('message', (data) => this.onMessage(data));
      socket.on('error', (error) => {
        this.lastError = `WebSocket error: ${error.message}`;
        this.stats.errors += 1;
        fail(new Error(this.lastError));
      });
      socket.on('close', (code, reason) => {
        if (this.socket === socket) this.socket = null;
        const detail = `WebSocket closed (${code})${reason ? `: ${String(reason)}` : ''}`;
        this.lastError = detail;
        if (!this.stopped) {
          this.markSource('WARNING', detail).catch(() => {});
          this.scheduleReconnect();
        }
      });
    });
  }

  onMessage(data) {
    if (typeof data === 'string') return;
    if (!Buffer.isBuffer(data)) return;
    // Text frames arrive as Buffers in some ws versions. A JSON control/error frame is
    // worth logging; a binary packet never starts with '{'.
    if (data.length && data[0] === 0x7b) {
      try {
        const body = JSON.parse(data.toString('utf8'));
        if (body && body.type) log.warn('tape control message', { type: body.type, message: body.message });
      } catch {
        // Not a control frame; fall through to the packet decoder.
      }
      return;
    }
    const packets = parseAngelPackets(data);
    for (const packet of packets) this.handlePacket(packet);
  }

  handlePacket(packet) {
    const info = this.subscriptions.get(String(packet.token));
    if (!info) return;
    this.stats.packets += 1;
    const capturedAt = isoNow();
    const exchangeAt = packet.lastTradeAt || packet.exchangeAt || null;
    const { bestBid, bestAsk } = bestPrices(packet);

    if (packet.mode === MODE.DEPTH) {
      this.queueDepth(info, packet, capturedAt, exchangeAt);
      return;
    }

    const previous = this.lastVolume.get(String(packet.token)) || {};
    const delta = volumeDelta(previous.volume, packet.volume, packet.lastQty);
    const side = classifySide({
      ltp: packet.ltp,
      bestBid: bestBid ?? previous.bestBid,
      bestAsk: bestAsk ?? previous.bestAsk,
      previousLtp: previous.ltp,
    });

    if (delta > 0 && packet.ltp !== null) {
      this.queueTick({
        captured_at: capturedAt,
        exchange_at: exchangeAt,
        symbol: info.symbol,
        contract: info.contract,
        token: String(packet.token),
        exchange: exchangeName(packet.exchangeType),
        ltp: packet.ltp,
        last_qty: packet.lastQty,
        volume_delta: delta,
        cum_volume: packet.volume,
        total_buy_qty: packet.totalBuyQty,
        total_sell_qty: packet.totalSellQty,
        open_interest: packet.openInterest,
        best_bid: bestBid,
        best_ask: bestAsk,
        side: side.side,
        side_confidence: side.confidence,
        source: 'angel-ws',
        quality: 'SNAPSHOT',
      });
      this.lastTickAt = capturedAt;
    }

    this.lastVolume.set(String(packet.token), {
      volume: packet.volume !== null ? packet.volume : previous.volume,
      ltp: packet.ltp !== null ? packet.ltp : previous.ltp,
      bestBid: bestBid ?? previous.bestBid,
      bestAsk: bestAsk ?? previous.bestAsk,
      at: capturedAt,
    });

    if (packet.bids.length || packet.asks.length) {
      this.queueDepth(info, packet, capturedAt, exchangeAt);
    }
  }

  queueTick(row) {
    this.pendingTicks.push(row);
    if (this.pendingTicks.length > MAX_PENDING) this.pendingTicks.splice(0, this.pendingTicks.length - MAX_PENDING);
    this.scheduleFlush();
  }

  queueDepth(info, packet, capturedAt, exchangeAt) {
    const token = String(packet.token);
    const now = Date.now();
    const last = this.lastDepthWrite.get(token) || 0;
    if (now - last < Math.max(250, config.tape.snapshotMs)) return;
    const summary = depthSummary(packet);
    const row = {
      captured_at: capturedAt,
      exchange_at: exchangeAt,
      symbol: info.symbol,
      contract: info.contract,
      token,
      exchange: exchangeName(packet.exchangeType),
      levels: summary.levels,
      bids: packet.bids,
      asks: packet.asks,
      best_bid: summary.bestBid,
      best_ask: summary.bestAsk,
      bid_qty: summary.bidQty,
      ask_qty: summary.askQty,
      imbalance: summary.imbalance,
      source: 'angel-ws',
    };
    const existingIndex = this.pendingDepths.findIndex((item) => item.token === token);
    if (existingIndex >= 0) {
      if (this.pendingDepths[existingIndex].levels >= row.levels) return;
      this.pendingDepths.splice(existingIndex, 1);
    }
    this.pendingDepths.push(row);
    if (this.pendingDepths.length > MAX_PENDING) this.pendingDepths.splice(0, this.pendingDepths.length - MAX_PENDING);
    this.lastDepthWrite.set(token, now);
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((error) => log.warn('tape flush failed', { error: error.message }));
    }, 500);
    this.flushTimer.unref?.();
  }

  async flush() {
    const sql = this.sql;
    if (!sql) return;
    const ticks = this.pendingTicks.splice(0, this.pendingTicks.length);
    const depths = this.pendingDepths.splice(0, this.pendingDepths.length);
    if (!ticks.length && !depths.length) return;
    try {
      if (ticks.length) {
        await sql`insert into tape_ticks ${sql(ticks)}`;
        this.stats.ticks += ticks.length;
      }
      if (depths.length) {
        const depthRows = depths.map((row) => ({
          ...row,
          bids: sql.json(row.bids),
          asks: sql.json(row.asks),
        }));
        await sql`insert into order_book_snapshots ${sql(depthRows)}`;
        this.stats.depths += depths.length;
      }
      this.stats.flushes += 1;
    } catch (error) {
      this.stats.errors += 1;
      log.warn('tape insert failed; dropping batch', { ticks: ticks.length, depths: depths.length, error: error.message });
    }
  }

  async health() {
    const now = Date.now();
    if (now - this.lastHealthAt < 15000) return;
    this.lastHealthAt = now;
    if (this.stopped) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      await this.markSource(this.lastError ? 'WARNING' : 'IDLE', this.lastError || 'socket not connected');
      return;
    }
    const stale = this.lastTickAt && now - Date.parse(this.lastTickAt) > 45000;
    const detail = [
      `${this.subscriptions.size} token(s)`,
      `${this.stats.ticks} tick(s)`,
      `${this.stats.depths} depth snapshot(s)`,
      this.lastTickAt ? `last print ${Math.round((now - Date.parse(this.lastTickAt)) / 1000)}s ago` : 'no print yet',
    ].join('; ');
    await this.markSource(stale ? 'STALE' : 'HEALTHY', detail);
  }
}

module.exports = { TapeWorker, SOURCE };
