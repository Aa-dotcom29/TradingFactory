# Trading Factory - Market Intelligence Harness Architecture

This document records the decisions behind the harness so future slices stay consistent.
It supersedes the earlier chat-level plan where they differ.

## Goals

- 24/7 autonomous monitoring of Indian market news, OI/volume flow and option data.
- Staged workers: News -> Market Analyser -> Bias Meter -> Signal -> Publisher.
- Multi-user (family) with real logins, three horizons, browser/device independent.
- Every signal stored for at least 90 days, versioned, for backtesting and human-gated learning.

## Non-goals (Slice 0 and by policy)

- No order execution. Execution is always manual; the tool is decision support.
- No LLM in the decision path. Rule engine is authoritative; LLM is optional enrichment.
- No paid managed services in the core path.

## Constraint that shaped the topology

Vercel and Supabase Edge cannot host a 24/7 streaming feed (short-lived execution, no
long-lived sockets). Momentum needs low latency, so the always-on worker is mandatory.

## Topology

```
Sources                      Harness worker (always-on)                    Channels
-------                      --------------------------                    --------
Angel One REST (quotes,      W0 ingest -> Postgres + queue
  greeks, instrument master)   |                +--> W1 news / W2 flow (Slice 2)
NSE (OI spurts, option         |                +--> W3 bias (Sl 3) -> W4 signals (Sl 4)
  chain; cookie-primed)        |                +--> W5 risk (Sl 5) -> W6 publish (Sl 5)
RSS feeds (ET, BS, MC,       W8 supervisor (health, queue, freshness)     Telegram
  Google News)                                                             (shadow-first)
Yahoo Finance (fallback
  quotes, delayed - Sl 5.5)  Postgres: partitioned time-series + queue + signals
```

Hosting options, in order of preference given "avoid commercial":

1. **Oracle Cloud Always Free ARM VM** running `docker-compose.yml` (Postgres + worker + dashboard). Zero cost, truly always-on. **Chosen host.**
2. **Render** paid background worker via `render.yaml` (you already have Render access).
3. A VPS or a home server.

Dashboard (Slice 1) is served from the same host as a PWA using **Next.js 15** (see
`web/` and `docs/slice-1-dashboard.md`), so it is browser- and device-independent. It reads
directly from Postgres; it never talks to a broker.

## Horizons

Three pipelines, one codebase. `horizon` is a first-class column on `signals`, `features` and
queue messages: `INTRADAY`, `SWING`, `POSITIONAL`. Each gets its own risk profile and cadence.

## Data flow and contracts

Everything downstream of W0 is a queued message: `{ topic, idem_key, horizon, payload, version }`.
Idempotency keys make at-least-once delivery safe; `FOR UPDATE SKIP LOCKED` lets many workers
share the queue without a broker.

Workers and what they own:

| Worker | Owns | Emits |
|---|---|---|
| W0 ingest | fetch/normalize/persist raw data | news.raw, flow.snapshot, feature.snapshot |
| W1 news | dedupe, entity, sentiment, severity | news.scored |
| W2 analyser | flow features per symbol (news<->OI<->price correlation moves to W3) | feature.snapshot |
| W3 bias | weighted ensemble verdict | bias.verdict |
| W4 signal | strike/premium/entry/target/stop, liquidity | signal.candidate |
| W5 risk | non-bypassable gates, exposure and loss controls | signal.approved / signal.rejected |
| W6 publish | immutable snapshot + Telegram delivery (shadow-first) | signal.published |
| W7 evaluator | outcomes, hit-rate, calibration | evaluate.signal |
| W8 supervisor | health, queue, freshness, housekeeping | sources_health |

**W0's polling discipline (Slice 9).** Market-derived ingestion is session-gated and repeat-aware,
so a 24/7 process cannot archive a closed market. Once the NSE is shut, the quote, option-premium and
OI-spurt cycles skip themselves (`skipped: market-closed`), and the last in-session reading stands as
the last known price. The quote and premium series additionally drop a batch identical to the one
already stored, because a frozen feed is not new evidence and both are aged by the exchange stamp the
freeze leaves unchanged. The flow series is deliberately **not** fingerprinted: an OI-spurt row carries
no stamp, so the harness ages flow by capture time, and suppressing a capture would quietly age the
bias meter's flow component. See [`slice-9-session-aware-ingestion.md`](slice-9-session-aware-ingestion.md).

## Data model rules

- Time-series tables (`market_snapshots`, `oi_spurts`, `news_items`, `features`,
  `bias_verdicts`) are range-partitioned by month, with a DEFAULT partition so writes never
  fail.
- News dedupe uses a non-partitioned `news_seen` registry (a hash must be unique globally).
- `signals` is immutable (trigger rejects snapshot edits) and retention-protected
  (trigger rejects deletes inside 90 days).
- Every signal carries `strategy_version`, `engine_version`, `model_version`, `config_version`.
  Without those, backtests and self-learning are meaningless.
- `config_registry` stores candidate configs from the learning loop; only a human approval
  moves one to `approved`. Nothing is auto-promoted.
- Config rows carry a `family` (`bias`, `signal`, `risk`, ...). Each worker resolves "the latest
  approved config" **within its own family**, so one stage can never load another stage's weights.
- `signal_stages` is an append-only lifecycle log (partitioned monthly); the current stage for a
  symbol and horizon is its latest row. `signal_candidates` holds proposals awaiting the risk
  gate and is separate from `signals`, which only ever holds risk-approved trades.
- `risk_decisions` is the gate's audit trail: one row per judgement, carrying the candidate, the
  verdict and the full check list. `signal_events` logs what happened to a published signal
  (published, delivered, delivery failed).

## Rule engine (Slice 2)

`normalize.js` + `lexicon.js` produce, per news item: entities (alias -> NSE symbol),
sentiment in [-1, 1], severity (LOW/MEDIUM/HIGH/CRITICAL) and a recency/entity-weighted
relevance in [0, 1]. Critical severity will gate new signals in W5.

`intel.js` is the cross-item layer on top of that, and is where Slice 2's value lives:

- `aggregateNewsEntities` groups the stored window of scored news by entity. One headline is
  noise; a cluster is a signal. Per entity it reports item count, the relevance-weighted net
  sentiment, the loudest severity seen, and a single `pressure` number in [-1, 1]
  (`netSentiment * (1 + 0.25 * severityRank)`).
- `computeFlowFeatures` reduces the flat NSE OI-spurt rows (underlyings + contracts) to one
  factual row per symbol: CE and PE open-interest change, the put-call ratio of those changes,
  the build-up quadrant mix, and the top contracts by absolute OI change.

Both functions are pure (no network, no DB, no LLM), so a signal can always be explained from
stored inputs and replayed offline. Neither emits a direction: turning these features into a
verdict is W3's job.

## Worker responsibilities (Slice 2 through Slice 5.5 as built)

| Worker | Consumes | Produces |
|---|---|---|
| W0 ingest | Angel One REST, Yahoo Finance fallback, NSE OI spurts, RSS | `market_snapshots`, `oi_spurts`; enqueues `news.raw`, `flow.snapshot`, `feature.snapshot` |
| W1 news | `news.raw` | `news_items` (persisted), `news_seen` (permanent dedupe), `features` set `news.entity.v1`; enqueues `news.scored` |
| W2 flow | `flow.snapshot` | `features` set `flow.v1`; enqueues `feature.snapshot` |
| W3 bias | `news.scored`, `feature.snapshot` (triggers only) | `bias_verdicts`; enqueues `bias.verdict` |
| W4 signals | `bias.verdict` (triggers only) | `signal_stages`, `signal_candidates`; enqueues `signal.candidate` |
| W5 risk | `signal.candidate` (triggers only) | `risk_decisions`; candidate status; enqueues `signal.approved` |
| W6 publish | `signal.approved` (triggers only) | `signals`, `signal_events`; Telegram delivery (shadow unless `PUBLISH_MODE=live`) |
| W8 supervisor | (read-only) | `sources_health` heartbeat, queue housekeeping |

A work queue is not pub/sub, so the topics above are consumed by exactly one stage each: W2
takes `flow.snapshot`, W3 takes `feature.snapshot`, W4 takes `bias.verdict`, W5 takes
`signal.candidate`, W6 takes `signal.approved`.

## Bias meter (Slice 3)

`bias.js` turns features and a price snapshot into a directional verdict per symbol and horizon:

- Evidence sources are independent *signals*: `news` (entity pressure), `flow` (build-up
  quadrant mix plus put-call open-interest change) and `price` (move from previous close and
  position in range).
- Each signal returns a score in [-1, 1] **and** a confidence in [0, 1]. The verdict score is
  the weight-averaged score; confidence is the weight-averaged confidence multiplied by how
  much of the intended evidence weight is actually present (`coverage`).
- A direction is only called above `thresholds.minConfidence`; below it the verdict stays
  NEUTRAL with a low confidence. A thin-data day therefore reads as "we do not know", not as a
  weak call.
- Weights move with the horizon (intraday leans on flow and price, positional on news and
  trend) and live in `config_registry`, not in code. W3 registers the built-in baseline as
  `bias-v1` on first run; a human can supersede it by approving a new version.
- Verdicts are persisted only on a material change (direction flip, `|delta score|` above
  `materialChange.scoreDelta`, or a staleness heartbeat), so 24/7 operation does not write an
  identical row every minute while history stays complete enough to forward-fill.

W2's remaining job - correlating news against OI and price - lands with the signal builder
(W4), where there is an actual entry to correlate against.

## Signal builder (Slice 4)

`signals.js` turns a verdict into a plan and a lifecycle position:

- Each symbol and horizon runs a small state machine: `IDLE -> WATCH -> BUILDING -> READY`.
  `READY` means a concrete, **liquid** trade exists - not merely a high score. `WATCH` means a
  directional lean that cannot yet be traded (no price to anchor a strike, or below the
  liquidity floor), and records why.
- A plan is an option trade (ATM strike nearest spot, entry at the premium, percentage stop,
  target = stop distance x reward multiple) or a level plan on the underlying when no option
  contract can be anchored.
- Transitions are appended to `signal_stages` on a material change only (stage, direction, plan
  signature, score move or staleness), so 24/7 operation does not append an identical row every
  minute. `signal_candidates` holds the proposals raised at `READY`; leaving `READY` supersedes
  any candidate still awaiting risk.
- `BLOCKED/ACTIVE/EXITED/EXPIRED` belong to W5/W6/W7. W4 never overwrites them, so a live
  position cannot be silently reset.
- Config lives in `config_registry` under the `signal` family (`signal-v1`), versioned and
  human-supersedeable, exactly like the bias meter's.

**Known limitation:** the NSE OI-spurt feed reports unusual OI moves, not an option chain, so it
surfaces outlier strikes rather than the at-the-money ones. Until a chain feature set is wired in
(NSE `option-chain-*` or Angel `optionGreek`), most plans are the honest underlying level plan.
The fix only needs a better candidate list in `selectContract`.

## Risk gate and publisher (Slice 5)

`risk.js` decides whether a candidate may be shown to the household at all; `telegram.js` composes
the message. Both are pure apart from the outbound HTTP call.

- The gate is **fail-closed**: a missing input is never an approval. A check that cannot be
  evaluated because the data does not exist reports `SKIPPED` and says why, so "we could not check
  this" is never silently the same as "this passed". Fourteen checks run: gate enabled, kill
  switch, known horizon, session, freshness, confidence floor, reward:risk floor, liquidity, open
  positions in the horizon, per-symbol exposure, duplicate window, consecutive-loss halt,
  post-loss cooldown and the daily loss limit.
- A candidate ends `APPROVED`, `REJECTED` or `DEFERRED`. `DEFERRED` means nothing failed and the
  market is simply shut (the NSE session and weekday check run on an explicit IST offset, so the
  host timezone is irrelevant); the proposal stays pending and is re-evaluated on the next tick. A
  failure always outranks a deferral.
- Loss controls need closed trades, which only exist once the evaluator (W7) runs. Until then they
  report `SKIPPED` rather than pretending to have checked - they are wired and unit-tested, just
  not yet fed.
- Limits live in `config_registry` under the `risk` family (`risk-v1`, registered on first run).
  The gate is read in the worker; **no dashboard route writes these limits**, so it cannot be
  relaxed from the UI.
- Publishing is **shadow-first**. `PUBLISH_MODE` defaults to `shadow`: the exact Telegram message
  is composed and logged, the immutable `signals` row and its `signal_events` are written with
  `snapshot.mode = shadow`, and nothing is sent. Only `PUBLISH_MODE=live` calls the Bot API.
- Delivery is retried through the queue (a failure `nack`s the message) and is idempotent: the
  signal row is keyed on the candidate's dedupe key, and an already-delivered signal is never
  re-sent. W6 also scans for approved candidates with no signal row, so a lost notification cannot
  strand an approved trade.

**Open-position ledger caveat.** Until W7 can close a position, published signals *are* the
open-position ledger, counted over a horizon-specific window (`holdingDays`). Per-symbol exposure
is capped at one, so in the meantime a symbol that has already been signalled will not be
signalled again inside that window. That is deliberate while there is no exit path, and it is the
first thing W7 should replace.

## Quote provenance and the fallback source (Slice 5.5)

The bias meter's `price` component is the strongest single input, and it needs exactly two numbers
per symbol: a last price and a previous close. With no quote source configured the pipeline still
runs, but every verdict collapses to `NEUTRAL` at the evidence floor, which makes the whole chain
look broken when it is really just starved. Slice 5.5 closes that gap and, more importantly, makes
the *origin* of every number explicit.

- **Provider waterfall.** W0 tries the live broker feed first (Angel One) and falls back to Yahoo
  Finance only when Angel is unconfigured, errors, or returns no rows. The chosen provider is
  recorded in `market_snapshots.provider` and, for quotes, in `features.provenance`.
- **Provenance travels with the number.** The value is written on `features` (`quote.v1`),
  carried onto `bias_verdicts.provenance`, and again onto `signal_candidates.provenance`, so an
  audit can go from a published signal back to the exact source of its price. The queue messages
  carry it too (`quoteProvenance`, `provenance`).
- **A delayed read is never dressed up as a live one.** Yahoo's NSE quotes lag the exchange (about
  fifteen minutes intraday), so they are tagged `yahoo-delayed` and rendered as a caution pill.
  Angel rows are `angel-live`. Both the health panel (`yahoo-quotes HEALTHY ... delayed quotes`)
  and the bias/signal panels show the tag; nothing assumes a live tick.
- **Nothing is invented.** A symbol Yahoo does not answer for produces a per-symbol error, never a
  fabricated price; the batch keeps going and the failures are counted in `sources_health`.

**Evidence ageing.** Every input that can go stale is dated and discounted, so a verdict is never
carried by numbers from a previous session presented as current:

- **price** dates each read from its exchange timestamp (`values.quoteTime`), falling back to
  `features.as_of` for feeds that omit one, and cuts confidence as the read ages. Outside the NSE
  session the most recent close is a settled prior, so the component is capped at
  `closedSessionConfidence` (0.2) and its detail records `market closed: last close is not live`.
- **flow** dates each snapshot from the feature `as_of` and is treated the same way: OI spurts are
  intraday-session data, so outside the session the last build-up is a settled prior and the
  component is capped at `closedSessionConfidence`.
- **news** ages from the newest headline on the entity (`values.latestAt`), not from when it was
  captured, and is deliberately *not* session-capped: an announcement made after the close is still
  news in the morning. Its fade window (2h -> 48h) matches the news aggregation window.

Each component keeps its score - the direction of the last read is still information - and reports
its reduced confidence and age in `detail`. A confidence move is itself a material change
(`materialChange.confidenceDelta`), so aged evidence reaches `bias_verdicts` and every stage
downstream instead of a stale row standing in for it. `freshMinutes` is set to the Yahoo fallback's
known delay so a normal delayed read is not punished. The session clock is shared with the risk gate
via `harness/src/session.js`, so both stages agree on when the market is open.

## Optional LLM

`HARNESS_LLM_ENABLED=true` + `OPENROUTER_API_KEY` enables OpenRouter enrichment. Guardrails:
structured JSON output only, mandatory source citation, numbers only from feeds, and full
fallback to the rule engine on any error or quota exhaustion. Free OpenRouter models are fine
here because the layer is non-critical.

## Retention and learning

- Retention floor is 90 days, enforced in the database.
- Archive to object storage before pruning; keep 12-18 months for backtesting.
- W7 scores signals nightly; candidate configs are reviewed by the owner before promotion.

## Security

- Broker credentials live only in the worker environment; never in the repo or the browser.
- `DATABASE_SSL` defaults to required for non-local hosts.
- The worker image runs as a non-root user.
