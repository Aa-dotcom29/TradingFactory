// End-to-end documentation for every harness worker, keyed W0..W9.
//
// Each entry is written from the worker's own source (harness/src/workers/*.js
// header contract, its SQL, and the shared queue topics in harness/src/topics.js)
// so the detail page states facts, not aspirations: where data enters the
// system, what shape it has, who consumes it, and what each worker deliberately
// does NOT do. Consumers list both queue topics (worker-to-worker) and durable
// tables (read by other workers or dashboard surfaces).

export const WORKER_DOCS = {
  W0: {
    id: 'W0', slug: 'w0', name: 'Ingest', lane: 'main pipeline',
    file: 'harness/src/workers/w0-ingest.js',
    cadence: 'quotes + option premiums every 10s, OI flow every 60s, RSS every 5 min (market hours)',
    does: [
      'W0 is the only worker that talks to the public market data internet. It fetches raw quotes, open-interest spurts and headlines, writes them as time-series snapshots, and enqueues downstream work for W1, W2 and W3.',
      'It deliberately does not score sentiment, extract entities or form any view - scoring belongs to later workers, so W0 stays a faithful recorder. A failing source is written to sources_health and never stops the other sources: one dead feed cannot take the machine down with it.',
      'Option polling re-reads the active_signals view, so only open option plans are quoted, and the Angel instrument master is cached on disk (harness/data/angel-instruments.json, refreshed every 12h by default) instead of re-downloading the ~35 MB file each cycle.',
    ],
    consumes: {
      external: [
        { name: 'RSS market feeds', detail: 'Economic Times markets, Business Standard markets, Moneycontrol market reports, Google News "indian stock market" - configurable via HARNESS_RSS_FEEDS, 40 items per feed max.' },
        { name: 'NSE nseindia.com', detail: 'Open-interest spurt snapshots for underlyings and F&O contracts (HARNESS_NSE_ENABLED, paced at >= 1.2s between calls).' },
        { name: 'Yahoo Finance', detail: 'Batched delayed NSE quotes (query1.finance.yahoo.com). Every row is tagged yahoo-delayed because Yahoo lags the exchange; the bias meter accepts it as the price component.' },
        { name: 'Angel One SmartAPI', detail: 'Instrument master (margincalculator.angelbroking.com OpenAPIScripMaster.json), batched quotes, and the option premium/Greek endpoint. Credentials live in .env only.' },
      ],
      queue: [],
      tables: ['active_signals (open option plans to quote, read-only)'],
    },
    produces: [
      { table: 'market_snapshots', shape: 'provider, symbol, kind (QUOTE | GREEK | CHAIN), payload jsonb - one row per fetched quote or option quote.' },
      { table: 'oi_spurts', shape: 'scope (UNDERLYING | CONTRACT), symbol/contract, oi, oi_change, volume, price, price_change_pct, spurt_score, read, strike/option_type - the flow evidence W2 reduces.' },
      { table: 'features (quote.v1)', shape: 'symbol, as_of, values jsonb - the delayed quote feature the bias meter and evaluator read.' },
      { table: 'ingest_runs', shape: 'started_at, finished_at, ok, worker, summary jsonb - one row per cycle for run-level audit.' },
      { table: 'sources_health', shape: 'one row per source: rss, yahoo-quotes, nse-oi-spurts, angel, angel-options (HEALTHY / WARNING / ERROR / DISABLED).' },
    ],
    emits: [
      { topic: 'news.raw', to: 'W1', what: 'normalized-but-unscored headline' },
      { topic: 'flow.snapshot', to: 'W2', what: 'raw OI-spurt rows just captured' },
      { topic: 'feature.snapshot', to: 'W3', what: '"quote inputs changed" trigger (numbers come from tables, not the payload)' },
    ],
    consumers: [
      { who: 'W1 News', via: 'queue news.raw', what: 'scores every headline' },
      { who: 'W2 Flow', via: 'queue flow.snapshot', what: 'reduces OI spurts to flow.v1 features' },
      { who: 'W3 Bias', via: 'queue feature.snapshot + table features (quote.v1)', what: 'price component of every bias verdict' },
      { who: 'W7 Evaluate', via: 'tables features (quote.v1), oi_spurts', what: 'entry/exit price series and option premium fallback' },
      { who: 'W8 Supervisor', via: 'table market_snapshots', what: 'feed freshness state (FRESH / STALE)' },
      { who: 'Dashboard', via: 'getLatestQuote, getQuoteSeries, getFlow, EntityIntel', what: 'quote chips, flow table, freshness banner' },
    ],
    limits: [
      'Never scores or judges what it fetches.',
      'A DISABLED source (credentials absent) is reported as DISABLED, never faked as healthy.',
      'Does not trade, publish or emit any signal itself.',
    ],
  },

  W1: {
    id: 'W1', slug: 'w1', name: 'News', lane: 'main pipeline',
    file: 'harness/src/workers/w1-news.js',
    cadence: 'every 15s, draining the news.raw queue',
    does: [
      'W1 consumes news.raw headlines from W0, applies the rule-based scorer, deduplicates permanently through news_seen, persists news_items, and emits news.scored per item.',
      'It then rolls the rolling window up into entity-level features (news.entity.v1) that the bias meter and the dashboard read - which companies a headline touches, how severe, how relevant.',
      'The LLM is deliberately absent here: scoring is deterministic and replayable, so a signal can always be explained from the stored item alone.',
    ],
    consumes: {
      external: [],
      queue: [{ topic: 'news.raw', from: 'W0 Ingest', what: 'normalized-but-unscored headline' }],
      tables: ['news_seen (global dedupe registry)', 'news_items (rolling window it re-aggregates)'],
    },
    produces: [
      { table: 'news_items', shape: 'published_at, source, url, title, summary, entities jsonb, sentiment numeric, severity, relevance, dedupe_hash - partitioned by published_at.' },
      { table: 'features (news.entity.v1)', shape: 'symbol, as_of, values jsonb - per-entity severity/sentiment/relevance rollup over the window.' },
      { table: 'news_seen', shape: 'dedupe_hash primary key, first_seen - a headline is scored exactly once, ever.' },
      { table: 'sources_health', shape: 'row news-scoring.' },
    ],
    emits: [
      { topic: 'news.scored', to: 'W3', what: 'entity/sentiment/severity enriched item (trigger only)' },
    ],
    consumers: [
      { who: 'W3 Bias', via: 'queue news.scored + table features (news.entity.v1)', what: 'sentiment component of bias verdicts' },
      { who: 'Dashboard', via: 'getNews, getEntityFeatures (NewsList, EntityIntel)', what: 'headline feed and entity intel panel' },
    ],
    limits: [
      'No LLM in the path - same input always yields the same score.',
      'Never fetches anything itself; W0 is its only window on the news world.',
    ],
  },

  W2: {
    id: 'W2', slug: 'w2', name: 'Flow', lane: 'main pipeline',
    file: 'harness/src/workers/w2-flow.js',
    cadence: 'every 15s, draining the flow.snapshot queue',
    does: [
      'W2 consumes flow.snapshot (the NSE OI-spurt rows W0 captured) and reduces them to one factual feature row per symbol: CE/PE open-interest change, put-call ratio and the build-up quadrant mix (long buildup, short buildup, short covering, long unwinding).',
      'It persists them as flow.v1 and emits feature.snapshot per symbol for W3. It reports what the tape did, never what to do about it - the bias meter turns these into a verdict later.',
      'While the exchange is shut there is nothing to build, so an empty drain reports its expected state instead of crying fault.',
    ],
    consumes: {
      external: [],
      queue: [{ topic: 'flow.snapshot', from: 'W0 Ingest', what: 'raw OI-spurt rows' }],
      tables: [],
    },
    produces: [
      { table: 'features (flow.v1)', shape: 'symbol, as_of, values jsonb - CE/PE OI change, PCR, build-up quadrant mix, factual and unhedged.' },
      { table: 'sources_health', shape: 'row flow-features.' },
    ],
    emits: [
      { topic: 'feature.snapshot', to: 'W3', what: 'flow inputs changed trigger' },
    ],
    consumers: [
      { who: 'W3 Bias', via: 'queue feature.snapshot + table features (flow.v1)', what: 'flow component of bias verdicts' },
      { who: 'W7 Evaluate', via: 'table oi_spurts (raw rows)', what: 'option premium fallback, third in chain (option.quote.v1 -> tape_ticks -> oi_spurts)' },
      { who: 'Dashboard', via: 'getFlow, getFlowFeatures (FlowPanel, FlowFeatures)', what: 'OI-spurt table and per-symbol flow feature' },
    ],
    limits: [
      'Never converts a flow reading into a direction - that is W3\'s job.',
      'Never fabricates a reading when the market is closed; empty means empty.',
    ],
  },

  W3: {
    id: 'W3', slug: 'w3', name: 'Bias', lane: 'main pipeline',
    file: 'harness/src/workers/w3-bias.js',
    cadence: 'every 15s, triggered by news.scored and feature.snapshot',
    does: [
      'W3 reads the durable feature tables (flow.v1, news.entity.v1, quote.v1) and produces one directional verdict per tracked symbol and horizon: BULLISH, NEUTRAL or BEARISH, with a score, confidence, coverage, per-component breakdown and the evidence rows behind it.',
      'Verdicts are persisted to bias_verdicts and emitted as bias.verdict for W4. Queue messages only say "inputs changed"; the numbers always come from the tables, so a replay produces exactly the same verdict.',
      'Rows are only written when they say something new - a direction flip, a material score move, or a staleness heartbeat - so 24/7 operation does not append an identical row every minute.',
    ],
    consumes: {
      external: [],
      queue: [
        { topic: 'news.scored', from: 'W1 News', what: 'sentiment inputs changed' },
        { topic: 'feature.snapshot', from: 'W0 Ingest / W2 Flow', what: 'quote/flow inputs changed' },
      ],
      tables: ['features (flow.v1, news.entity.v1, quote.v1)', 'bias_verdicts (previous verdicts, to detect change)', 'config_registry (family bias - approved scoring weights, e.g. bias-v1)'],
    },
    produces: [
      { table: 'bias_verdicts', shape: 'symbol, horizon (INTRADAY/SWING/POSITIONAL), direction, score, confidence, coverage, components jsonb, evidence jsonb, config_version, engine_version - partitioned by as_of.' },
      { table: 'sources_health', shape: 'row bias-meter.' },
    ],
    emits: [
      { topic: 'bias.verdict', to: 'W4', what: 'direction + probability + evidence (trigger only)' },
    ],
    consumers: [
      { who: 'W4 Signal', via: 'queue bias.verdict + table bias_verdicts', what: 'the direction it advances names on' },
      { who: 'Dashboard', via: 'getBias, getBiasOverview (BiasPanel, ConsensusMeter)', what: 'per-horizon bias table and house read' },
    ],
    limits: [
      'No discretionary override: weights come from the approved config family, not from the UI.',
      'An untracked symbol with no evidence yields no verdict row - absence is shown, never guessed.',
    ],
  },

  W4: {
    id: 'W4', slug: 'w4', name: 'Signal', lane: 'main pipeline',
    file: 'harness/src/workers/w4-signals.js',
    cadence: 'every 15s, triggered by bias.verdict',
    does: [
      'W4 reads the latest bias verdict per symbol and horizon together with the factual flow and quote features, and advances each name along its trade lifecycle: IDLE -> WATCH -> BUILDING -> READY.',
      'Every stage transition is persisted to signal_stages with the reasons behind it. When a name enters READY, W4 writes a concrete tradeable proposal (option or spot, with entry, target, stop, R:R, liquidity check) into signal_candidates and emits signal.candidate for the risk gate.',
      'Like W3 it never trusts queue payloads - all numbers come from durable tables, so a replay reproduces the same stages and candidates. It only moves names through the stages it owns; BLOCKED/ACTIVE/EXITED/EXPIRED belong to W5/W6/W7 and W4 leaves those alone rather than resetting a live position.',
    ],
    consumes: {
      external: [],
      queue: [{ topic: 'bias.verdict', from: 'W3 Bias', what: 'direction changed (trigger only)' }],
      tables: ['bias_verdicts', 'features (flow.v1, quote.v1)', 'signal_stages (current stage per name)', 'config_registry (family signal - e.g. signal-v1)'],
    },
    produces: [
      { table: 'signal_stages', shape: 'symbol, horizon, stage (IDLE/WATCH/BUILDING/READY/BLOCKED/ACTIVE/EXITED/EXPIRED), previous_stage, direction, score, confidence, plan jsonb, reasons jsonb, config_version - every transition kept.' },
      { table: 'signal_candidates', shape: 'horizon, symbol, direction, strategy, kind (OPTION/SPOT), instrument, strike, option_type, expiry, entry, target, stop, rr, confidence, score, liquidity_ok, status=pending_risk, dedupe_key unique, setup jsonb, reasons jsonb.' },
      { table: 'sources_health', shape: 'row signal-builder.' },
    ],
    emits: [
      { topic: 'signal.candidate', to: 'W5', what: 'proposal awaiting risk (id by dedupe_key)' },
    ],
    consumers: [
      { who: 'W5 Risk', via: 'queue signal.candidate + table signal_candidates', what: 'the only thing allowed to move it past pending_risk' },
      { who: 'Dashboard', via: 'getSignalStages, getSignalStageOverview, getSignalCandidates (SignalStages, SignalCandidates)', what: 'lifecycle ladder and queued proposals' },
    ],
    limits: [
      'Never approves anything - proposing is all it does.',
      'Never touches a name already in a W5/W6/W7-owned stage.',
      'Rows are written only on material change, so replays stay cheap.',
    ],
  },

  W5: {
    id: 'W5', slug: 'w5', name: 'Risk', lane: 'main pipeline',
    file: 'harness/src/workers/w5-risk.js',
    cadence: 'every 15s, triggered by signal.candidate',
    does: [
      'W5 is the gate. Every candidate from W4 waits in signal_candidates with status pending_risk, and nothing proceeds without W5.',
      'It re-reads each candidate from the durable table (never from the queue payload), runs it through the pure gate in risk.js - exposure caps, horizon limits, liquidity, and the loss controls fed by outcomes (consecutive-loss halt, cooldown after a loss, daily loss limit) - then marks it APPROVED, REJECTED or DEFERRED.',
      'APPROVED candidates are marked and emitted as signal.approved for the publisher (W6). REJECTED candidates are recorded with why and are never published. DEFERRED stays pending (market closed) and re-evaluates next tick. Every terminal evaluation writes a risk_decisions row, so "why was this never published" is always answerable afterwards.',
    ],
    consumes: {
      external: [],
      queue: [{ topic: 'signal.candidate', from: 'W4 Signal', what: 'a proposal to judge' }],
      tables: [
        'signal_candidates (pending_risk rows)',
        'config_registry (family risk - the limits themselves; read-only here)',
        'outcomes (loss-control state: consecutive losses, cooldown, daily loss)',
        'active_signals (current open exposure)',
        'risk_decisions (previous decisions, to avoid duplicate rows)',
      ],
    },
    produces: [
      { table: 'risk_decisions', shape: 'signal_id, horizon, evaluated_at, passed boolean, reasons jsonb, payload jsonb - one row per terminal evaluation.' },
      { table: 'signal_candidates', shape: 'status: pending_risk -> approved | rejected (deferred stays pending_risk).' },
      { table: 'sources_health', shape: 'row risk-gate.' },
    ],
    emits: [
      { topic: 'signal.approved', to: 'W6', what: 'risk-passed candidate' },
    ],
    consumers: [
      { who: 'W6 Publish', via: 'queue signal.approved + tables signal_candidates, risk_decisions', what: 're-reads the candidate and publishes only if approved' },
      { who: 'Dashboard', via: 'getRiskDecisions (RiskDecisions)', what: 'approved/rejected audit feed' },
    ],
    limits: [
      'Risk limits live in config_registry and are read here, in the worker: no dashboard route can write them - a gate relaxable from the UI would not be a gate.',
      'Never publishes, never edits a signal - it only decides pass/fail and records why.',
      'A deferred proposal writes a row only when its reason changes, so an overnight market does not grow the table a line per tick.',
    ],
  },

  W6: {
    id: 'W6', slug: 'w6', name: 'Publish', lane: 'main pipeline',
    file: 'harness/src/workers/w6-publish.js',
    cadence: 'every 15s, draining signal.approved (plus a safety-net scan)',
    does: [
      'W6 consumes signal.approved, writes the immutable published signal row, delivers it, and records both facts in signal_events. The message carries only a candidate id; everything else is re-read from signal_candidates.',
      'The signal row is keyed on the candidate dedupe_key, so a replayed message publishes the same signal once or nothing at all. A safety-net scan also picks up any approved candidate that has no signal row - the durable tables, not the queue, are the source of truth.',
      'Delivery is shadow-first: PUBLISH_MODE defaults to shadow, where the exact message is composed and logged but nothing leaves the machine. The row is still written and tagged mode=shadow, so the whole path is exercised and auditable before a single real alert is sent. Only PUBLISH_MODE=live calls Telegram.',
    ],
    consumes: {
      external: [
        { name: 'Telegram Bot API', detail: 'api.telegram.org - used ONLY when PUBLISH_MODE=live for that horizon; token and chat id come from TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID in .env.' },
      ],
      queue: [{ topic: 'signal.approved', from: 'W5 Risk', what: 'candidate id (payload re-read from tables)' }],
      tables: ['signal_candidates', 'risk_decisions', 'signals + signal_events (dedupe check)'],
    },
    produces: [
      { table: 'signals', shape: 'horizon, strategy, symbol, direction, instrument, strike, option_type, entry, target, stop, rr, probability, confidence, published_at, mode (shadow|live), immutable ledger row keyed on the candidate dedupe key.' },
      { table: 'signal_events', shape: 'append-only lifecycle events (PUBLISHED, later EXITED/EXPIRED...).' },
      { table: 'sources_health', shape: 'row publisher (WARNING when a delivery fails).' },
    ],
    emits: [
      { topic: 'signal.published', to: 'W7', what: 'delivered signal id' },
    ],
    consumers: [
      { who: 'W7 Evaluate', via: 'queue signal.published + table signals', what: 'treats it as an open position to settle' },
      { who: 'Trade workspace', via: 'table signals (getSignals, SignalList)', what: 'signal cards, Trade Entered button (actionable check reads active_signals)' },
      { who: 'Household channel', via: 'Telegram message (live mode only)', what: 'the human-readable alert' },
      { who: 'Dashboard', via: 'getSignals, getHorizonPulse, signal counts', what: 'published ledger and open counts' },
    ],
    limits: [
      'Shadow-first: without PUBLISH_MODE=live nothing is ever sent, yet every row and event still exists for audit.',
      'Never creates a signal from thin air - only approved candidates with a dedupe key become signals.',
      'Execution stays manual: the published row is an alert, not an order.',
    ],
  },

  W7: {
    id: 'W7', slug: 'w7', name: 'Evaluate', lane: 'main pipeline',
    file: 'harness/src/workers/w7-evaluate.js',
    cadence: 'every 15s, draining signal.published; settlement runs after market close',
    does: [
      'Every worker before this one describes what to do. W7 is the first that asks what happened.',
      'A published signal is an open position. W7 re-reads each one from signals (never from the queue payload), walks the price readings recorded since publication, and decides whether the target, the stop, or simply the horizon\'s holding window ended the trade. The verdict becomes one immutable outcomes row plus an EXITED/EXPIRED event on the signal.',
      'Those rows feed the risk gate\'s loss controls (consecutive-loss halt, cooldown, daily loss limit) - implemented since Slice 5 but only meaningful once outcomes exist. W7 also scores closed outcomes against their config versions and writes config proposals (status=candidate in config_registry) that a human must approve before any learning change takes effect.',
    ],
    consumes: {
      external: [],
      queue: [{ topic: 'signal.published', from: 'W6 Publish', what: 'signal id to settle (row re-read from signals)' }],
      tables: [
        'signals / active_signals (only actionable, non-voided signals)',
        'features (quote.v1 and option.quote.v1 - price/premium series)',
        'tape_ticks (live prints, option premium fallback #2)',
        'oi_spurts (option premium fallback #3)',
        'outcomes (previous results for config scoring)',
        'config_registry (versions being scored, proposals being written)',
      ],
    },
    produces: [
      { table: 'outcomes', shape: 'signal_id, horizon, result, entry, exit, pnl_pct, mfe, mae, bars_held, payload jsonb - one immutable row per settled trade.' },
      { table: 'signal_events', shape: 'EXITED / EXPIRED events appended to the signal lifecycle.' },
      { table: 'config_registry', shape: 'candidate config proposals from outcome scoring - written, never activated; activation is human-only.' },
      { table: 'sources_health', shape: 'row evaluator.' },
    ],
    emits: [],
    consumers: [
      { who: 'W5 Risk', via: 'table outcomes', what: 'loss controls: consecutive-loss halt, cooldown, daily loss limit' },
      { who: 'Dashboard', via: 'getOutcomes, getOutcomeStats, getEvaluatorOutcome (Outcomes panel, win rate)', what: 'settled trades and performance stats' },
      { who: 'Governance', via: 'config_registry proposals', what: 'human approval loop before any learning change' },
    ],
    limits: [
      'Never scores an option plan against the underlying spot - plan levels are premiums, so such a pair is refused outright; an option plan is scored against its own premium series (option.quote.v1 -> tape_ticks -> oi_spurts), else NO_PRICE_SOURCE after an 8h grace (HARNESS_UNPRICED_GRACE_HOURS).',
      'Never evaluates a voided, closed or retired signal - it reads active_signals, so retired shadow configs stop looking open.',
      'Never activates a config proposal itself; shadow-first governance stays human-approved.',
    ],
  },

  W8: {
    id: 'W8', slug: 'w8', name: 'Supervise', lane: 'support lane',
    file: 'harness/src/workers/w8-supervisor.js',
    cadence: 'heartbeat every 30s, housekeeping every hour',
    does: [
      'W8 watches the health of the whole harness: worker heartbeat, queue depth and dead letters, and feed freshness. It is intentionally read-only except for its own heartbeat and queue housekeeping, so it can never corrupt pipeline data.',
      'Its sources_health row (harness-supervisor) carries a compact JSON health summary: pending messages, dead letters, oldest pending age, feed state (FRESH/STALE) and uptime. A non-HEALTHY state is logged as a warning, which is what makes trouble visible before a human goes looking.',
      'Housekeeping purges completed queue messages after 7 days and stale pending ones after 2 hours, plus old tape/depth rows - the dashboard stays fast without anyone restarting anything.',
    ],
    consumes: {
      external: [],
      queue: [{ topic: 'queue_messages (stats)', from: 'all workers', what: 'depth, dead letters, oldest pending - read-only' }],
      tables: ['market_snapshots, tape_ticks, order_book_snapshots (freshness windows)', 'sources_health (all worker rows, indirectly via the dashboard)'],
    },
    produces: [
      { table: 'sources_health', shape: 'row harness-supervisor with JSON detail { pending, deadLetters, oldestPendingMin, feed, uptimeSec }.' },
      { table: 'queue_messages', shape: 'housekeeping only: purge done (>7d) and stale pending (>2h).' },
    ],
    emits: [],
    consumers: [
      { who: 'Dashboard', via: 'getHealth (HealthTable, StatusBanner, RailStatus)', what: 'the health feed every page shows' },
      { who: 'Agent Arcade', via: 'sources_health harness-supervisor', what: 'the W8 module status and lane totals on this board' },
      { who: 'All workers', via: 'queue housekeeping', what: 'keeps queue_messages bounded so cycles stay fast' },
    ],
    limits: [
      'Read-only by design - it writes only its own heartbeat and purges queue rows, never pipeline data.',
      'It monitors; it does not repair. Alerts are for humans.',
    ],
  },

  W9: {
    id: 'W9', slug: 'w9', name: 'Tape', lane: 'support lane',
    file: 'harness/src/workers/w9-tape.js',
    cadence: 'long-lived WebSocket during market hours; open plans re-read every 60s',
    does: [
      'The REST quote path samples a price every few seconds - enough for a bias meter, but not for a footprint. A footprint needs every print and the book that was standing when it arrived. W9 holds an Angel One SmartAPI WebSocket open and writes both.',
      'It keeps a bounded token set: the configured universe plus every open option plan (read from active_signals). It re-reads open plans once a minute and reconciles subscriptions instead of reconnecting for every change, so it stays inside the broker quota.',
      'What it deliberately does NOT claim: Snap Quote carries five book levels, Depth mode twenty for NSE cash only - neither is the exchange full anonymous order book. The packet has no aggressor flag, so classifySide estimates the taker from the print against the best bid/ask and records a confidence, letting the dashboard label the result tape-derived rather than exchange-certified.',
    ],
    consumes: {
      external: [
        { name: 'Angel One SmartAPI WebSocket', detail: 'live trade-by-trade prints and book snapshots for NSE cash + F&O tokens; requires the same .env credentials as W0.' },
        { name: 'Instrument master (cached file)', detail: 'harness/data/angel-instruments.json - resolves symbols/contracts to exchange tokens before subscribing.' },
      ],
      queue: [],
      tables: ['active_signals (open option plans to subscribe)'],
    },
    produces: [
      { table: 'tape_ticks', shape: 'symbol, contract, token, ltp, last_qty, volume_delta, cum_volume, total_buy_qty, total_sell_qty, open_interest, best_bid/ask, side (BUY/SELL/UNKNOWN), side_confidence (HIGH/MEDIUM/LOW/NONE), quality - partitioned by captured_at.' },
      { table: 'order_book_snapshots', shape: 'symbol, contract, token, levels actually received, bids/asks jsonb, best_bid/ask, bid_qty/ask_qty, imbalance - throttled to one per snapshot window.' },
      { table: 'sources_health', shape: 'row angel-tape (IDLE when the market is shut).' },
    ],
    emits: [],
    consumers: [
      { who: 'W7 Evaluate', via: 'table tape_ticks', what: 'option premium series, second in the fallback chain' },
      { who: 'Trade workspace', via: 'getTapeAnalytics, momentum/flow/theta panels', what: 'prints, footprint, imbalance behind every live judgment' },
      { who: 'Dashboard', via: 'FootprintPanel, OrderBookPanel', what: 'footprint chart and depth ladder (labelled tape-derived)' },
      { who: 'W8 Supervisor', via: 'table tape_ticks, order_book_snapshots', what: 'freshness window for feed state' },
    ],
    limits: [
      'Five book levels from Snap Quote, twenty in Depth mode for NSE cash - never the full exchange order book.',
      'Side is estimated, never certified: side_confidence is stored so the UI can say how sure it is.',
      'Tape stores facts; it never turns a print into a recommendation.',
    ],
  },
};

// Board order, for prev/next navigation on the detail pages.
export const WORKER_ORDER = ['W0', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9'];

export function workerDocBySlug(slug) {
  const key = String(slug || '').toUpperCase();
  return Object.prototype.hasOwnProperty.call(WORKER_DOCS, key) ? WORKER_DOCS[key] : null;
}

export function adjacentWorkers(id) {
  const i = WORKER_ORDER.indexOf(id);
  if (i < 0) return { prev: null, next: null };
  return {
    prev: i > 0 ? WORKER_DOCS[WORKER_ORDER[i - 1]] : null,
    next: i < WORKER_ORDER.length - 1 ? WORKER_DOCS[WORKER_ORDER[i + 1]] : null,
  };
}
