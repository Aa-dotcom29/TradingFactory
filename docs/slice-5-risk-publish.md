# Slice 5 - Risk gate (W5) and publisher (W6)

Slice 4 produced trade candidates. Slice 5 is what stands between a candidate and the household:
a gate that can refuse, and a publisher that composes the message. Nothing is published unless
every gate passes, and delivery defaults to shadow, so the whole path can be exercised before a
single real alert is sent.

Both new modules are pure apart from one outbound HTTP call, and the gate is authoritative in the
worker - no dashboard route can relax it.

## What shipped

| Area | Detail |
|---|---|
| Risk math | `harness/src/risk.js` - the fourteen checks, the IST session, exposure and loss summaries (pure) |
| W5 worker | `harness/src/workers/w5-risk.js` - reads candidates from the durable table, records every judgement, emits `signal.approved` |
| Publisher | `harness/src/telegram.js` - pure ASCII message formatter plus a dependency-free Bot API client (never throws) |
| W6 worker | `harness/src/workers/w6-publish.js` - writes the immutable signal, delivers once, logs both in `signal_events` |
| Storage | `risk_decisions` gained `candidate_id`, `decision` and `config_version`; new indexes on both decision tables |
| Config | Baseline registered as `risk-v1` in the `risk` family on first run |
| Dashboard | **Risk gate** panel (decision, gate tally, failing gate, reasons) on the overview and all three horizon pages; published-signal cards now carry a `shadow - not delivered` / `delivered` pill |
| Tests | 26 new `risk` unit tests, 10 new `telegram` unit tests, 1 new web formatter test; self-check grew to 28 checks |

## The gate

Fourteen checks run for every candidate:

| Gate | Fails / defers when | State without data |
|---|---|---|
| `enabled` | the gate is switched off in config (fail-closed) | - |
| `killSwitch` | the global kill switch is engaged | - |
| `horizon` | the horizon is not one of the three | - |
| `session` | the market is shut - **deferred**, not rejected | `SKIPPED` if enforcement is off |
| `freshness` | the candidate is older than the horizon limit | `FAIL` if it has no timestamp |
| `confidence` | below `minConfidence` | `FAIL` if absent |
| `rewardRisk` | below `minRewardRisk` | `FAIL` if absent |
| `liquidity` | the plan missed its liquidity floor | - |
| `openPositions` | the horizon is at its position cap | - |
| `symbolExposure` | the symbol already has an open position in that horizon | - |
| `duplicateWindow` | the same call was published minutes ago | `SKIPPED` when nothing matches |
| `consecutiveLossHalt` | losses in a row reached the halt level | `SKIPPED` - no closed trades yet |
| `cooldownAfterLoss` | the last loss is inside the cooldown | `SKIPPED` - no recorded loss |
| `dailyLossLimit` | today is past the daily loss limit | `SKIPPED` - nothing closed today |

Two properties matter more than the list itself.

**It is fail-closed.** A missing input is never an approval. Anything that cannot be evaluated
because the data does not exist reports `SKIPPED` with the reason recorded, so "we could not check
this" is never silently the same as "this passed". Turning the gate off in config *stops*
publishing rather than opening it.

**It explains itself.** Every judgement writes the full check list to `risk_decisions.payload`, so
"why was this rejected" is answered gate by gate. The dashboard renders the tally and names the
failing gates.

### Three outcomes

| Decision | Meaning |
|---|---|
| `APPROVED` | every gate passed; the publisher may deliver it |
| `REJECTED` | at least one gate failed; recorded, never published |
| `DEFERRED` | nothing failed and the market is shut; stays pending and is re-evaluated next tick |

A failure always outranks a deferral. `DEFERRED` exists because a proposal raised outside the
session is not wrong - it is simply early - and rejecting it would be as misleading as publishing
it. Deferred proposals write a decision row only when the reason changes, so an overnight market
does not grow the table a line per tick.

### The session, and what is honest about it

The NSE window (09:15-15:30 IST, weekdays) is checked on an explicit IST offset, so the host
timezone is irrelevant. Public holidays are not modelled: a holiday produces no fresh evidence
upstream, so no candidate is raised in the first place. That is stated rather than hidden.

### The loss controls are wired but not yet fed

The consecutive-loss halt, the post-loss cooldown and the daily loss limit read `outcomes`, which
only exists once the evaluator (W7) runs. Until then they report `SKIPPED` - honestly, not as a
pass. They are unit-tested against synthetic history.

### The open-position ledger, and its caveat

Until W7 can close a position, published signals *are* the open-position ledger, counted over a
horizon-specific window (`holdingDays`: 1 / 30 / 180 days). Per-symbol exposure is capped at one.
The consequence, stated plainly: while there is no exit path, a symbol that has already been
signalled will not be signalled again inside that window. That is deliberate - it stops the same
idea being re-published repeatedly - and it is the first thing W7 should replace.

## Configuration as data

On first run W5 registers the built-in baseline so whatever is executing is inspectable:

```
version     family   status     created_by  config
bias-v1     bias     approved   harness     { thresholds, weights, flow, news, price, materialChange }
signal-v1   signal   approved   harness     { strategy, plan, stages }
risk-v1     risk     approved   harness     { gates: { session, caps, floors, loss controls, holdingDays } }
```

The gate reads these in the worker. There is no dashboard route that writes them: a gate that
could be relaxed from the UI would not be a gate.

## Shadow-first publishing

`PUBLISH_MODE` defaults to `shadow`:

| | Row written | Message composed | Telegram called |
|---|---|---|---|
| `shadow` | yes, `snapshot.mode = shadow` | yes, logged verbatim | no |
| `live` | yes, `snapshot.mode = live` | yes | yes |

The immutable `signals` row is written in both modes, so the path is exercised end to end and
auditable before a real alert exists - and a shadow signal can never be mistaken for a delivered
one, because the mode is on every row and every card.

Messages are plain text with no `parse_mode` and every value formatted in code, so the alert
channel cannot carry the mojibake that plagued the older UI.

Delivery is idempotent and retried: the signal row is keyed on the candidate's dedupe key (a
replay finds the existing row), an already-delivered signal is never re-sent, and a delivery
failure `nack`s the queue message so it backs off and retries. W6 also scans for approved
candidates that have no signal row, so a lost notification cannot strand an approved trade.

## Queue topology note

A work queue is not pub/sub, so a topic has exactly one consumer. W5 is the sole consumer of
`signal.candidate` and owns `signal.approved`; W6 is the sole consumer of `signal.approved`. Both,
like W3 and W4, treat messages as triggers and read the durable tables for the numbers, so a
replay reproduces the same decision.

## Verification against a real database

Run against local Postgres 18 (UTF-8) with live NSE OI spurts. Angel One is still not configured,
and the runs landed at ~01:45-01:50 IST on a Saturday - market shut - so the session gate was
exercised in its closed state throughout.

| Check | Result |
|---|---|
| `npm run harness:selfcheck` | 28/28 checks |
| `npm run harness:test` | 107/107, including 26 new `risk` and 10 new `telegram` tests |
| `npm run web:test` | 19/19, including 1 new formatter test |
| `npm run harness:once` (default config) | `risk result: evaluated 2, approved 0, rejected 0, deferred 2` - both candidates deferred on the session; `publish result: published 0` |
| Gate detail (stored) | 14 checks: 8 `PASS`, 1 `DEFER` (session), 4 `SKIPPED` (duplicate window, loss controls), 0 `FAIL` |
| `session.enforce=false` experiment | `approved 2, published 2` - the shadow publisher composed both messages (verbatim in the log) and delivered nothing |
| Exposure at work | after publishing, the next fresh candidates for the same symbols were `REJECTED` on `symbolExposure` **and** `duplicateWindow` - 4 `APPROVED` / 2 `REJECTED` / 2 `DEFERRED` decisions total |
| `holdingDays.POSITIONAL=0` experiment | cleared the ledger, so fresh candidates were approved and published with `snapshot.riskConfigVersion = risk-v1` (the first two signal rows predate that field being wired and carry `null` there) |
| `signals` / `signal_events` | 4 shadow rows, 8 events: `- -> PUBLISHED -> SHADOWED` per signal, each with `mode`, `channel` and the delivery result |
| `config_registry` | `bias-v1`, `signal-v1`, `risk-v1` - all `approved`, all seeded by the workers; every relaxed knob restored to the baseline afterwards |
| `harness:once` (restored config) | `signal persisted 0`, `risk evaluated 0`, `published 0` - steady state, nothing re-fires |
| `GET /dashboard`, `/dashboard/intraday|swing|positional` | all `200`; all four render the **Risk gate** panel, and `positional` renders the shadow pill and a `DEFERRED` row |
| `npm run web:build` | clean |
| Encoding scan | every file touched by this slice is strict ASCII |

Two config experiments were run and reverted (both are recorded above): relaxing the session gate
to prove the approve/publish path, and clearing the exposure window to prove the `riskConfigVersion`
fix. Neither is a code change; both are `config_registry` edits, which is exactly how the gates
are meant to be tuned.

## Files

```
harness/
  db/schema.sql                 risk_decisions candidate_id/decision/config_version, new indexes, migration marker
  src/
    risk.js                     the fourteen gates, IST session, exposure/loss summaries (pure)
    telegram.js                 ASCII message formatter + dependency-free shadow-first client
    workers/w5-risk.js          candidates -> gate -> risk_decisions -> signal.approved
    workers/w6-publish.js       signal.approved -> signals + signal_events -> Telegram (shadow)
    config.js                   telegram + publish blocks, role list
    run.js                      roles w5/w6, ordered --once pipeline, timers, idle-tick keys
    selfcheck.js                6 new slice 5 checks
  test/
    risk.test.js                26 tests over the gate
    telegram.test.js            10 tests over the formatter and client
web/
  components/RiskDecisions.js   the gate's audit trail as a table
  components/SignalList.js      shadow / delivered pill, honest empty state
  lib/queries.js                getRiskDecisions, signal mode, gate counts
  lib/format.js                 decisionTone, publishModeTone
  app/dashboard/page.js         Risk gate section + gate stat tiles
  app/dashboard/[horizon]/page.js  Risk gate section
```

## Next

Slice 6 is go-live: wire Angel One (which also lifts the `price` signal and the whole confidence
band), set `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`, flip `PUBLISH_MODE=live` per horizon,
Intraday last.

Slice 7 is the evaluator (W7): close positions so the exposure ledger and the loss controls are
fed real outcomes, score outcomes, and produce candidate configs for human approval. The gate's
loss controls and the `holdingDays` caveat above both resolve there.

Slice 8 is option-premium persistence: W0 polls the contracts the harness holds and stores each
premium under its own contract key, so an option-premium plan can be scored on the instrument it
actually trades instead of being refused. See [`slice-8-option-quotes.md`](./slice-8-option-quotes.md).
