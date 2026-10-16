# Slice 4 - Signal builder (W4)

The signal builder is the stage that turns an opinion into a plan. It reads the bias meter's
verdict together with the factual flow and quote features and answers two questions per symbol
and horizon: where is this name in its trade lifecycle, and if it is ready, what exactly is the
trade?

It is rule-based, deterministic and pure. No LLM sits anywhere in this path, so every stage and
every candidate on the dashboard can be reproduced from the stored inputs.

## What shipped

| Area | Detail |
|---|---|
| Signal math | `harness/src/signals.js` - pure plan construction, liquidity check, lifecycle state machine, material-change gate |
| W4 worker | `harness/src/workers/w4-signals.js` - reads durable tables, persists stages, raises candidates, emits `signal.candidate` |
| Storage | `signal_stages` (append-only, range-partitioned by `as_of`) and `signal_candidates` (one row per READY proposal) |
| Config | Baseline registered in `config_registry` as `signal-v1` (approved, family `signal`) on first run |
| Dashboard | **Signal lifecycle** panel (stage, plan and reasons) plus **trade candidates**, on the overview and all three horizon pages |
| Tests | 20 new `signals` unit tests, 1 new web formatter test; self-check grew to 22 checks |

## The lifecycle

A signal is not a single event. A setup appears, builds, becomes tradeable, and only much later
exits. Modelling that as a boolean "signal / no signal" throws away the most useful information -
the transition - and gives the dashboard nothing to show while a setup is forming. So W4 runs a
small explicit state machine per symbol and horizon:

| Stage | Meaning | Entered when |
|---|---|---|
| `IDLE` | nothing to see | bias is NEUTRAL |
| `WATCH` | a lean, but not tradeable | bias is directional, but there is no plan (no price / no anchorable strike) or the plan is below the liquidity floor |
| `BUILDING` | setup forming | bias is directional with a complete, liquid plan, but confidence is below the ready floor |
| `READY` | a tradeable proposal exists | directional, liquid, and confidence clears the ready floor |

`BLOCKED`, `ACTIVE`, `EXITED` and `EXPIRED` are reserved for the risk gate (W5), the publisher
(W6) and the evaluator (W7). **W4 only ever moves a name between the stages it owns**: if a name
is already in a downstream stage, W4 leaves it alone rather than resetting a live position to
`WATCH` on the next tick.

Every transition is appended to `signal_stages` with the reasons behind it, so the history
explains itself after the fact and the dashboard can show what is forming continuously.

## The plan

A plan is either an option trade or a level plan on the underlying.

- **Option plan.** Bullish verdicts buy calls, bearish ones buy puts. Among the contracts the
  feed actually surfaced, the strike nearest spot is chosen - that is the at-the-money contract,
  where liquidity concentrates. Entry is the traded premium; the stop is a percentage of the
  premium; the target is `stop distance * reward multiple`.
- **Spot / futures level plan.** When no option contract can be anchored (see the limitation
  below), and the underlying price is known, a level plan is produced: entry at spot, a
  percentage stop on the underlying, and the same reward multiple for the target.

A plan that cannot be priced is **not** a plan. If there is no underlying price at all, no plan
is produced and the name sits at `WATCH` with the reason recorded. If a plan forms but fails the
liquidity floor, `buildPlan` still returns it (so the dashboard can show the forming setup) but
`ok` is false; the stage stays at `WATCH`. `READY` therefore means "there is a concrete, liquid
trade here", not "the score is high".

### The honest limitation: OI spurts are not an option chain

The NSE OI-spurt contracts feed answers "where did open interest move unusually", so it surfaces
*outlier* strikes, not the at-the-money ones. In live testing NIFTY's snapshot carried a `23100`
put (near spot) but only a `24500` call (6% away), and several names carried only a futures
contract. That is why, with a bullish NIFTY verdict, the builder falls back to the level plan
rather than buying a deep out-of-the-money call.

The fix is a real option-chain feature set (NSE `option-chain-indices` / `option-chain-equities`,
or Angel One `optionGreek`), which plugs in at `selectContract`: it only needs a better candidate
list. Until then the level plan is the honest default, and it is labelled as such.

## Liquidity

Three floors gate an option plan, all in `config_registry`: the number of option contracts
observed for the symbol, the chosen contract's traded volume, and its open interest. They are a
conservative first cut - because they are data, calibration once a full chain feed is wired in is
a registry change, not a deploy. A spot/level plan needs no contract-level liquidity and says so
explicitly rather than pretending a check happened.

## Why stages are not written every tick

On a real tick W4 recomputes every name but only appends a stage row when it says something new:

- the stage changed, or
- the direction changed, or
- the plan signature changed (a new strike, or a moved stop/target), or
- `|score - previous score| >= stages.scoreDelta` (default `0.05`), or
- the stored stage is older than `stages.maxStaleMinutes` (default `15`).

Without this a 24/7 loop would append an identical row every minute for every symbol and horizon.

A candidate is raised only on a **fresh READY entry**, or when a name is still `READY` but its
plan changed underneath the verdict. A plain score move while `READY` is not a new candidate.
When a name leaves `READY`, any candidate still awaiting risk is marked `superseded` - so the
candidate queue can never grow a tail of stale proposals.

## Configuration as data

`config_registry` holds the running stops, reward multiples, liquidity floors and thresholds.
On first run W4 inserts the built-in baseline so whatever is executing is inspectable:

```
version     family   status     created_by  config
bias-v1     bias     approved   harness     { thresholds, weights, flow, news, price, materialChange }
signal-v1   signal   approved   harness     { strategy, plan, stages }
```

This slice also fixed a latent collision: "the latest approved config" was ambiguous once more
than one stage registered a baseline, so one stage could load another's weights. Config rows now
carry a `family` (`bias`, `signal`, ...), existing rows default to `bias`, and each worker scopes
its lookup. A partial or malformed stored config is merged over the built-in baseline by
`resolveSignalConfig`, so a half-written row cannot zero a stop.

## Queue topology note

A work queue is not pub/sub, so a topic must have exactly one consumer. W4 is the sole consumer
of `bias.verdict` and owns `signal.candidate`, which will be consumed by the risk gate (W5).

## Verification against a real database

Run against local Postgres 18 (UTF-8) with live NSE OI spurts. Angel One is still not configured,
so the `price` signal is absent and the builder anchors strikes on the NSE underlying value -
exactly the degraded path it is designed to survive.

| Check | Result |
|---|---|
| `npm run harness:selfcheck` | 22/22 checks |
| `npm run harness:test` | 71/71, including 20 new `signals` tests |
| `npm run web:test` | 18/18, including 1 new formatter test |
| `npm run harness:once` (first) | `signal result: computed 45, persisted 45, candidates 2` on `signal-v1` |
| `npm run harness:once` (again) | `persisted 0, candidates 0` - nothing material changed |
| `signal_stages` | 45 current rows = 15 symbols x 3 horizons: 38 IDLE, 5 BUILDING, 2 READY |
| `signal_candidates` | 2 pending risk: `POSITIONAL NIFTY` (entry 23146 / stop 21988.70 / target 26039.25, R:R 2.5) and `POSITIONAL RELIANCE` (1211 / 1150.45 / 1362.38) |
| Config authority | setting `stages.readyConfidence` to 0.9 moved 2 names READY -> BUILDING and superseded 2 candidates; restoring 0.4 flipped them back and raised 2 fresh candidates |
| `config_registry` | `bias-v1` (family `bias`) and `signal-v1` (family `signal`), both `approved`, seeded by the workers |
| `GET /dashboard`, `/dashboard/intraday|swing|positional` | all `200`, rendering the lifecycle table with live stages, plans and reasons |
| `npm run web:build` | clean |
| Encoding scan | every file touched by this slice is strict ASCII |

## Files

```
harness/
  db/schema.sql                signal_stages + signal_candidates, config_registry.family, migration marker
  src/
    signals.js                 plan construction, liquidity, lifecycle machine, gates (pure)
    workers/w4-signals.js      read verdicts + features -> stages + candidates -> queue
    workers/w3-bias.js         config lookup now scoped to the `bias` family
    intel.js                   flow features carry the underlying price and contract price/OI
    run.js                     role w4, ordered --once pipeline, idle-tick logging
    selfcheck.js               slice 4 wiring checks
  test/signals.test.js         20 tests over the new math
web/
  components/SignalStages.js     lifecycle table with plan and reasons
  components/SignalCandidates.js candidate cards with status and liquidity
  lib/queries.js                 getSignalStages, getSignalStageOverview, getSignalCandidates
  lib/format.js                  stageTone, candidateStatusTone
```

## Next

Slice 5 is the risk gate (W5): consume `signal.candidate`, apply the non-bypassable limits
(consecutive-loss halt, daily loss cap, per-trade stop budget, spread/liquidity limits), record a
pass/fail row per candidate in `risk_decisions`, and only then allow a signal to be published.
The gate lives in the worker - no dashboard endpoint may relax it.
