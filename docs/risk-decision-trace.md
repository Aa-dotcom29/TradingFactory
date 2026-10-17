# Why four signals were approved after hours

A trace, kept because the question ("how was this approved with the market shut?") is exactly the
kind the pipeline is supposed to answer from stored data, and the answer deserves to survive.

## The question

The `signals` ledger held four shadow signals, all `POSITIONAL`, all published at ~01:48-01:50 IST
on 2026-10-17 - long after the NSE close. `risk_decisions` showed `APPROVED` for those same minutes,
while the evaluations immediately before and after them were `DEFERRED`.

## What the rows say

`risk_decisions`, oldest first (UTC):

| evaluated_at | decision | session gate |
| --- | --- | --- |
| 2026-10-16T20:16:10Z | DEFERRED | DEFER |
| 2026-10-16T20:18:29Z | **APPROVED** | **SKIPPED** |
| 2026-10-16T20:19:33Z | REJECTED | SKIPPED |
| 2026-10-16T20:20:22Z | **APPROVED** | **SKIPPED** |
| 2026-10-16T20:31:21Z | DEFERRED | DEFER |
| 2026-10-17T10:04:21Z | REJECTED | DEFER |

The distinguishing column is the session gate. When it read `DEFER`, the market was correctly shut.
The four that went on to be approved (or rejected) show `SKIPPED` - and a session check is only ever
`SKIPPED` on one path in `risk.js`:

```js
if (!gates.session.enforce) add('session', 'SKIPPED', 'session enforcement is switched off in config');
```

So during those two minutes the effective risk config had `gates.session.enforce = false`. The stored
`risk-v1` row dates from `2026-10-16T20:16:10.993Z` - the same instant as the first `DEFERRED` row -
and now reads:

```json
"session": { "enforce": true, "openMinutes": 555, "closeMinutes": 930, "weekdaysOnly": true }
```

## The cause

Not a defect in the gate. The Slice 5 live end-to-end test deliberately switched session enforcement
off so the publisher could be exercised while the exchange was shut (a closed market would otherwise
have produced nothing but `DEFERRED` rows). Enforcement was restored afterwards, which is why every
decision from `20:31:21Z` onwards is `DEFER` again. The four `APPROVED` rows are that test's shadow,
not live operation.

The gap it exposed is real, though: an approval that rests on a **switched-off control** was written
with the same `reasons` as an ordinary pass (`["every risk gate passed"]`), so the row gave no hint
that the market-hours check had been skipped. `evaluateRisk` now marks any such check `bypassed` and
names the gates in the reasons:

```
["every risk gate passed", "approved with controls switched off in config: session"]
```

`risk.js` exposes a `bypassed` array as well, so a caller can surface it. The same treatment applies
to the liquidity control, the other switch whose disabling can carry an approval.

## The residue to clear before go-live

The four approved candidates became four published shadow signals, and a published signal is the
open-position ledger until the evaluator closes it. With `holdingDays.POSITIONAL = 180` and
`maxOpenPerSymbol = 1`, they occupy both POSITIONAL slots for NIFTY and RELIANCE until roughly
mid-April 2026, and W7 reports them forever as `0 closed of 4 open`. They are test data sitting in a
real ledger.

Nothing in the code can remove them: `signals` is immutable (a trigger blocks updates) and
retention-protected (a 90-day floor). The remedy is a **ledger reset on the local database before the
`live` flip**, which is a go-live step rather than a feature. The reset must clear `signals`,
`signal_events`, `outcomes`, `signal_candidates`, `signal_stages`, `risk_decisions` and the
`queue_messages` rows, and must leave `config_registry`, `sources_health` and `features` alone.

## Why it cannot recur unattended

The only writer of the `risk` config family is the harness itself (`ensureConfig`, seeding `risk-v1`)
and the evaluator's proposer, which may change exactly one knob - `gates.minConfidence`, and only
ever as a `candidate` row that a human must approve. No dashboard route writes any risk limit. So the
`session.enforce` flag can only move by hand, and since it can no longer move silently, a hand-move
now leaves a reason in the row.
