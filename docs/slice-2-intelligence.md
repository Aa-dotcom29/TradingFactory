# Slice 2 - Intelligence layer (W1 news + W2 flow)

Slice 2 turns the raw rows W0 ingests into cross-item features: scored news rolled up per
entity, and option-flow features per symbol. Everything here is rule-based and deterministic -
no LLM sits anywhere in this path - so any number on the dashboard can be explained from the
stored inputs and replayed offline.

## What shipped

| Area | Detail |
|---|---|
| W0 (changed) | No longer scores news. It fetches, persists time-series rows and enqueues work. |
| W1 news | `harness/src/workers/w1-news.js` - consumes `news.raw`, scores, dedupes, persists, emits `news.scored` |
| W2 flow | `harness/src/workers/w2-flow.js` - consumes `flow.snapshot`, derives per-symbol flow features, emits `feature.snapshot` |
| Intelligence math | `harness/src/intel.js` - pure, unit-tested functions (`aggregateNewsEntities`, `computeFlowFeatures`) |
| Features stored | `features` with `feature_set` `news.entity.v1` (one row per entity) and `flow.v1` (one row per symbol) |
| Dashboard | Overview and all three horizon pages gained an **Entity pressure** and a **Flow features** panel |
| Queue hygiene | Supervisor now drops stale pending notifications so an unbuilt stage cannot grow the queue forever |

## The responsibility split (and why it changed)

The architecture always assigned scoring to W1, but W0 was doing it. Slice 2 fixes that:

| Worker | Consumes | Produces |
|---|---|---|
| W0 ingest | Angel One REST, NSE OI spurts, RSS | `market_snapshots`, `oi_spurts`; enqueues `news.raw`, `flow.snapshot`, `feature.snapshot` |
| W1 news | `news.raw` | `news_items`, `news_seen` (permanent dedupe), `features` `news.entity.v1`; enqueues `news.scored` |
| W2 flow | `flow.snapshot` | `features` `flow.v1`; enqueues `feature.snapshot` |
| W8 supervisor | (read-only) | `sources_health` heartbeat, queue housekeeping |

`news.raw` now carries a plain headline envelope (source, url, title, summary, publishedAt).
W0 still computes the dedupe hash, but only to build the queue idempotency key - otherwise a
5-minute RSS poll would re-enqueue the same story on every cycle.

## The intelligence itself

### `aggregateNewsEntities` - one headline is noise, a cluster is a signal

Groups the stored window of scored news (default 48h) by entity and reports per entity:

- `itemCount`, plus `positive` / `negative` / `neutral` counts
- `netSentiment` - relevance-weighted mean sentiment in [-1, 1]
- `maxSeverity` and its rank
- `pressure` = `netSentiment * (1 + 0.25 * severityRank)`, clamped to [-1, 1] - a loud, severe
  cluster presses harder than a quiet one with the same sentiment
- `topTitles` - the highest-relevance headlines behind the number

### `computeFlowFeatures` - what open interest actually did

Reduces the flat NSE OI-spurt rows to one factual row per symbol:

- `ceOiChange` / `peOiChange` - summed open-interest change for call and put legs
- `pcrOiChange` = `peOiChange / ceOiChange` (`null` when the call leg is zero)
- `longBuildup` / `shortBuildup` / `shortCovering` / `longUnwinding` - the build-up quadrant mix
- `futureOiChange`, `optionCount`, `futureCount` - the split described below
- `topContracts` - largest moves, each labelled `OPTION` or `FUTURE`

It reports the tape and stops there: it never emits a direction. Turning these features into a
verdict is the bias meter's job (Slice 3).

## Two live-feed gotchas this slice locks down

Both were found by checking the features against the real NSE response, not by reasoning alone:

1. **NSE spells the option side out.** Contract rows carry `optionType` as `"Put"` / `"Call"`,
   not `"PE"` / `"CE"`. Comparing against `PE`/`CE` directly silently zeroed every put-call
   ratio. `normalizeOptionType` canonicalises `Put|P|PE -> PE` and `Call|C|CE -> CE`, and both
   spellings are covered by tests.
2. **The contracts endpoint mixes in futures.** Rows for stock/index futures arrive in the same
   payload with `optionType: "-"`, `strikePrice: 0` and `instrumentType: FUTSTK`/`FUTIDX`.
   Folding those into a put-call ratio would corrupt it, so they are counted separately
   (`futureCount`, `futureOiChange`) and labelled in `topContracts`.

## Run it

`HARNESS_ROLE=all` (the default) runs every worker in one process. To split them across
hosts, use `w0`, `w1`, `w2` or `w8`.

```powershell
npm run harness:once       # one full ordered cycle: W0 -> W1 -> W2 -> W8
npm run harness            # 24/7 loop
```

Cadence is controlled by `HARNESS_SCORE_INTERVAL_MS` (default 15000) for the W1/W2 drains,
alongside the existing market/flow/news intervals.

## Verification against a real database

Run against local Postgres 18 (UTF-8), with NSE OI spurts live:

| Check | Result |
|---|---|
| `npm run harness:selfcheck` | 16/16 checks, including entity aggregation, flow features and queue backlog |
| `npm run harness:test` | 35/35, including 12 new `intel` tests |
| `node harness/src/run.js --once` | W0: 319 flow rows, 5 queued news; W1: 5 scored, 119 deduped, 22 entities from 107 items; W2: 60 symbols |
| `features` | `flow.v1` rows for 60 symbols, `news.entity.v1` rows for 22 entities |
| Top flow row | `NIFTY ce=769613 pe=372612 pcr=0.484 opt=87 fut=1` |
| Top entity rows | `MARKET 33 items`, `NIFTY 21`, `SENSEX 15`, each with severity and pressure |
| `GET /dashboard`, `/dashboard/intraday|swing|positional` | all `200`, rendering live Entity pressure and Flow features rows |
| `npm run web:build` | clean |
| Encoding scan | every file touched by this slice is strict ASCII |

## Files

```
harness/
  src/
    intel.js                  pure cross-item intelligence (entity pressure, flow features)
    workers/
      w0-ingest.js            fetch + persist + enqueue (no longer scores news)
      w1-news.js              score, dedupe, persist, entity features
      w2-flow.js              per-symbol flow features
      w8-supervisor.js        heartbeat + stale-notification purge
    queue.js                  added purgeStalePending + backlog
    run.js                    roles all|w0|w1|w2|w8, ordered --once pipeline
  test/intel.test.js          12 tests over the new math
web/
  components/EntityIntel.js   news pressure by entity
  components/FlowFeatures.js  per-symbol flow features
  lib/queries.js              getEntityFeatures, getFlowFeatures
```

## Next

Slice 3 - the bias meter (W3) - is now built: it combines entity pressure, flow features and
price into a versioned verdict per horizon. See `docs/slice-3-bias.md`.
