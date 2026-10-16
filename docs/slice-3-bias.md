# Slice 3 - Bias meter (W3)

The bias meter is the first stage that produces an opinion. It reads the Slice 2 features plus a
price snapshot and answers one question per symbol and horizon: is the weight of evidence
bullish, bearish, or not enough to say?

It is rule-based, deterministic and pure. No LLM sits anywhere in this path, so every verdict on
the dashboard can be reproduced from the stored inputs.

## What shipped

| Area | Detail |
|---|---|
| Bias math | `harness/src/bias.js` - pure signals, combination, universe and material-change gate |
| W3 worker | `harness/src/workers/w3-bias.js` - reads durable tables, persists verdicts, emits `bias.verdict` |
| Storage | `bias_verdicts`, range-partitioned by `as_of`, indexed on `(horizon, symbol, as_of desc)` |
| Config | Baseline registered in `config_registry` as `bias-v1` (approved) on first run |
| Dashboard | **Bias meter** panel on the overview and all three horizon pages, plus a bull/bear stat |
| Tests | 14 new `bias` unit tests; self-check grew to 19 checks |

## The shape of a verdict

Each symbol and horizon gets a score in `[-1, 1]` **and** a confidence in `[0, 1]`. They are not
the same number and are deliberately not collapsed into one:

- `score` - what the available evidence leans towards.
- `confidence` - the weight-averaged confidence of that evidence, multiplied by `coverage`, the
  share of the intended evidence weight that is actually present.
- `direction` - only called once `confidence` clears `thresholds.minConfidence`.

So a name with one headline and no flow reads as `score +0.73, confidence 2% -> NEUTRAL`. That is
the honest answer. Withholding a direction when the evidence is thin is the single most important
property of this stage: a bad call that looks confident is worse than no call.

## The evidence sources

| Signal | Reads | Direction | Confidence |
|---|---|---|---|
| `news` | entity pressure for the symbol | the weighted sentiment, severity-escalated | headlines vs `fullConfidenceAt`; halved on CRITICAL |
| `flow` | build-up quadrant mix + put-call OI change | standard price+OI table (long buildup bullish, short buildup bearish, covering/unwinding at half weight) | option contracts vs `fullConfidenceAt`, reduced when only one leg is present |
| `price` | move from previous close, position in range | momentum plus range position | 1.0, or 0.7 on a snapshot with no intraday range |

Weights move with the horizon, because the same news matters far less to a five-minute trade
than to a positional one:

```
INTRADAY   { flow: 0.5,  price: 0.4, news: 0.1 }
SWING      { flow: 0.3,  price: 0.4, news: 0.3 }
POSITIONAL { flow: 0.15, price: 0.45, news: 0.4 }
```

These live in `config_registry`, not in code. W3 registers the built-in baseline as `bias-v1` on
first run, and a human can supersede it by approving a new version - which is also the hook the
Slice 5 learning loop will use.

## Why verdicts are not written every tick

On a real tick, W3 recomputes all verdicts but only persists the ones that say something new:

- the direction flipped, or
- `|score - previous score| >= materialChange.scoreDelta` (default `0.05`), or
- the stored verdict is older than `materialChange.maxStaleMinutes` (default `15`).

Without this, a 24/7 loop would write an identical row every minute for every symbol and horizon.
History stays complete enough to forward-fill for backtesting, and a staleness heartbeat keeps
the age of every verdict visible.

## Configuration as data

`config_registry` holds the running weights and thresholds. On first run W3 inserts the built-in
baseline so whatever is executing is inspectable:

```
version    status     created_by  config
bias-v1    approved   harness     { thresholds, weights, flow, news, price, materialChange }
```

A partial or malformed stored config is merged over the built-in baseline by `resolveConfig`, so a
half-written row cannot crash the meter or silently zero a weight.

## Verification against a real database

Run against local Postgres 18 (UTF-8) with live NSE OI spurts. Angel One is not configured yet,
so the `price` signal is absent throughout - which is exactly the thin-evidence path being tested.

| Check | Result |
|---|---|
| `npm run harness:selfcheck` | 19/19 checks |
| `npm run harness:test` | 51/51, including 14 new `bias` tests |
| `npm run harness:once` | `bias result: triggers 420, computed 45, persisted 45` then `persisted 0` on the next run (nothing material changed) |
| `bias_verdicts` | 45 rows = 15 tracked symbols x 3 horizons |
| Direction split | 38 NEUTRAL, 7 BULLISH - no bearish cluster in the window |
| Highest-confidence call | `POSITIONAL NIFTY BULLISH score 0.188 conf 0.55` (flow and news both present) |
| Thin-evidence example | `INTRADAY KOTAKBANK NEUTRAL score 0.73 conf 0.02` (one headline, no flow, no quote) |
| `config_registry` | `bias-v1`, `approved`, seeded by the worker |
| `GET /dashboard`, `/dashboard/intraday|swing|positional` | all `200`, rendering the bias panel with live rows |
| `npm run web:build` | clean |
| Encoding scan | every file touched by this slice is strict ASCII |

## Queue topology note

A work queue is not pub/sub, so a topic must have exactly one consumer. W2 owns `flow.snapshot`
and W3 owns `feature.snapshot`; giving W3 `flow.snapshot` as well would have made the two stages
race for the same rows and silently halve the bias refresh rate.

## Files

```
harness/
  db/schema.sql             bias_verdicts (partitioned) + feature-set index + migration marker
  src/
    bias.js                 signals, combination, universe, material-change gate (pure)
    workers/w3-bias.js      read features -> verdicts -> persist + emit
    run.js                  role w3, ordered --once pipeline, idle-tick logging
    selfcheck.js            bias wiring checks
  test/bias.test.js         14 tests over the new math
web/
  components/BiasPanel.js   verdict table with per-signal evidence pills
  lib/queries.js            getBias, getBiasOverview
  lib/format.js             scoreTone (dead-banded so +0.02 does not read as bullish)
```

## Next

Slice 4 builds on verdicts: turn a `BULLISH` verdict into an actual tradeable candidate (strike,
premium, entry, target, stop, liquidity check) and emit `signal.candidate` for the risk gate.
