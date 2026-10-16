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
NSE (OI spurts, option         |                +--> W3 bias (Slice 3) -> W4 signals (Slice 4)
  chain; cookie-primed)        |                +--> later: W5..W7
RSS feeds (ET, BS, MC,       W8 supervisor (health, queue, freshness)
  Google News)
                             Postgres: partitioned time-series + queue + signals
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
| W5 risk | non-bypassable gates + sizing | signal.approved / signal.rejected |
| W6 publish | Telegram + dashboard + immutable snapshot | signal.published |
| W7 evaluator | outcomes, hit-rate, calibration | evaluate.signal |
| W8 supervisor | health, queue, freshness, housekeeping | sources_health |

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
- Config rows carry a `family` (`bias`, `signal`, ...). Each worker resolves "the latest approved
  config" **within its own family**, so one stage can never load another stage's weights.
- `signal_stages` is an append-only lifecycle log (partitioned monthly); the current stage for a
  symbol and horizon is its latest row. `signal_candidates` holds proposals awaiting the risk
  gate and is separate from `signals`, which only ever holds published trades.

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

## Worker responsibilities (Slice 2 through Slice 4 as built)

| Worker | Consumes | Produces |
|---|---|---|
| W0 ingest | Angel One REST, NSE OI spurts, RSS | `market_snapshots`, `oi_spurts`; enqueues `news.raw`, `flow.snapshot`, `feature.snapshot` |
| W1 news | `news.raw` | `news_items` (persisted), `news_seen` (permanent dedupe), `features` set `news.entity.v1`; enqueues `news.scored` |
| W2 flow | `flow.snapshot` | `features` set `flow.v1`; enqueues `feature.snapshot` |
| W3 bias | `news.scored`, `feature.snapshot` (triggers only) | `bias_verdicts`; enqueues `bias.verdict` |
| W4 signals | `bias.verdict` (triggers only) | `signal_stages`, `signal_candidates`; enqueues `signal.candidate` |
| W8 supervisor | (read-only) | `sources_health` heartbeat, queue housekeeping |

A work queue is not pub/sub, so the topics above are consumed by exactly one stage each: W2
takes `flow.snapshot`, W3 takes `feature.snapshot`, W4 takes `bias.verdict`.

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
