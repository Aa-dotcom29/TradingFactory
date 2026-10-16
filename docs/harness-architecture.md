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
  greeks, instrument master)   |                |
NSE (OI spurts, option         |                +--> later: W1..W7
  chain; cookie-primed)        v
RSS feeds (ET, BS, MC,       W8 supervisor (health, queue, freshness)
  Google News)
                             Postgres: partitioned time-series + queue + signals
```

Hosting options, in order of preference given "avoid commercial":

1. **Oracle Cloud Always Free ARM VM** running `docker-compose.yml` (Postgres + worker). Zero cost, truly always-on.
2. **Render** paid background worker via `render.yaml` (you already have Render access).
3. A VPS or a home server.

Dashboard (Slice 1) is served from the same host as a PWA, so it is browser- and device-independent.

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
| W2 analyser | features, news<->OI<->price correlation | feature.snapshot |
| W3 bias | weighted ensemble verdict | bias.verdict |
| W4 signal | strike/premium/entry/target/stop, liquidity | signal.candidate |
| W5 risk | non-bypassable gates + sizing | signal.approved / signal.rejected |
| W6 publish | Telegram + dashboard + immutable snapshot | signal.published |
| W7 evaluator | outcomes, hit-rate, calibration | evaluate.signal |
| W8 supervisor | health, queue, freshness, housekeeping | sources_health |

## Data model rules

- Time-series tables (`market_snapshots`, `oi_spurts`, `news_items`, `features`) are
  range-partitioned by month, with a DEFAULT partition so writes never fail.
- News dedupe uses a non-partitioned `news_seen` registry (a hash must be unique globally).
- `signals` is immutable (trigger rejects snapshot edits) and retention-protected
  (trigger rejects deletes inside 90 days).
- Every signal carries `strategy_version`, `engine_version`, `model_version`, `config_version`.
  Without those, backtests and self-learning are meaningless.
- `config_registry` stores candidate configs from the learning loop; only a human approval
  moves one to `approved`. Nothing is auto-promoted.

## Rule engine (Slice 2 preview)

`normalize.js` + `lexicon.js` produce, per news item: entities (alias -> NSE symbol),
sentiment in [-1, 1], severity (LOW/MEDIUM/HIGH/CRITICAL) and a recency/entity-weighted
relevance in [0, 1]. Critical severity will gate new signals in W5.

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
