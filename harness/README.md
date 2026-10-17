# Trading Factory - Market Intelligence Harness (Slice 0)

Autonomous, staged market-intelligence pipeline for Indian equity/F&O workflows. Slice 0 is
the **backbone**: the database schema, the worker queue, the W0 ingestion worker, and the W8
supervisor. Later slices add news scoring, bias, signal building, risk, publishing and the
evaluator on top of exactly these structures.

## Design principles

- **Free / self-hosted first.** Postgres + Node only. No managed queue, no paid auth, no
  paid monitoring. Runs on an Oracle Cloud "Always Free" VM, a VPS, Docker Compose, or Render.
- **Reuse, do not rewrite.** Broker auth, TOTP, instrument master and the NSE session clock
  come from the existing `angel-feed.js`.
- **Rule-based core.** Sentiment/severity/entity extraction is a lexicon, not an LLM. An LLM
  (via OpenRouter) is optional enrichment behind `HARNESS_LLM_ENABLED`.
- **Graceful degradation.** A dead source is recorded in `sources_health`, never fatal. The
  pipeline must survive NSE blocking us or a feed being down.
- **Replayable.** Every hand-off is a queued message with an idempotency key.
- **Immutable, versioned signals.** Published signals cannot be edited and cannot be deleted
  inside the 90-day retention floor, so backtesting and self-learning stay honest.

## Layout

```
harness/
  db/schema.sql            partitions, immutability, retention floor, SQL queue
  Dockerfile               worker image (non-root)
  scripts/apply-schema.js  apply schema without psql
  src/config.js            env-driven configuration
  src/logger.js            JSON line logger
  src/db.js                Postgres client (boots without a DB)
  src/queue.js             FOR UPDATE SKIP LOCKED queue
  src/topics.js            canonical queue topics + horizons
  src/lexicon.js           sentiment / severity / entity data
  src/normalize.js         pure normalization + scoring
  src/sources/rss.js       dependency-free RSS/Atom reader
  src/sources/nse.js       cookie-primed OI spurts + option chain
  src/sources/angel-client.js  batched quotes + option greeks
  src/workers/w0-ingest.js     ingestion worker
  src/workers/w8-supervisor.js health / queue / freshness watcher
  src/run.js               entrypoint (--once, --dry, --role=)
  src/selfcheck.js         wiring validation, no credentials needed
  test/                    node:test unit tests
```

## Commands

```bash
npm run harness:selfcheck     # validate wiring (no credentials needed)
npm run harness:angel-check   # validate Angel One credentials (see docs/angel-one-onboarding.md)
npm run harness:test          # unit tests
npm run harness:schema        # apply schema.sql to DATABASE_URL
npm run harness:once          # run a single ingestion cycle
npm run harness               # run continuously (W0 + W8)
npm run harness:daily         # single cycle, dry (no network/DB)
```

## Running on a free always-on host

```bash
cp .env.example .env          # fill in Angel One credentials
docker compose up -d --build
docker compose logs -f worker
```

The Postgres container applies `harness/db/schema.sql` on first boot, so there is no manual
migration step for a fresh volume.

## Queue topics

`news.raw`, `news.scored`, `flow.snapshot`, `feature.snapshot`, `bias.verdict`,
`signal.candidate`, `signal.approved`, `signal.rejected`, `signal.published`,
`evaluate.signal`. W0 currently produces the first three; later slices consume them.

## Not in Slice 0 (by design)

Dashboard/auth (Slice 1), news scoring + bias (Slice 2), evaluator (Slice 3), signal +
risk + publisher (Slice 4). Publication and real-world enablement come last, per horizon,
Intraday last.
