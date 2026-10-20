# Slice 10 - what the first live session found

A live run is the only test that can fail in ways a test suite cannot. On **Tuesday 20 October
2026** the harness was started by hand at 10:36 IST on what turned out to be **Dussehra**, an NSE
holiday, and in eighty minutes of running it exposed three real defects and one noisy one.

None of them reached a person: `PUBLISH_MODE` was unset, so the publisher was in shadow mode and
nothing was sent to Telegram. One of them would have reached a person the moment that flipped.

This slice is the repair.

---

## 1. An expired contract was priced, and approved

**What was seen.** The first two signals the harness ever composed were:

```
INTRADAY NIFTY - BEARISH
Instrument: NIFTY 19-Oct-2026 22850 PE
Entry: 0.05   Stop: 0.04   Target: 0.07
```

A NIFTY put at five paise. The expiry in the instrument name was **yesterday**.

**Why it happened.** `selectContract` picked the strike nearest spot from the flow snapshot's
`topContracts`. It never looked at the expiry. The flow snapshot is the one NSE published on 19
October, and on that day a 19 October expiry was perfectly valid; the bias meter deliberately
*ages* flow rather than discarding it, so W4 was still reading that snapshot a day later, when the
contract had expired. The "price" it found was the last trade of a dead option.

**Why nothing caught it.** This is the uncomfortable part. Every check the risk gate runs was
satisfied:

- the levels were correctly ordered (`target > entry > stop` for the long premium position);
- the liquidity floors passed, because they read the dead contract's own volume and open interest;
- the confidence was above the floor, because the bias meter's flow component had aged, not vanished;
- the reward:risk ratio was 1.5, as configured.

The data was internally consistent. It was simply about an instrument that no longer existed. A gate
that reads numbers cannot detect that the instrument behind the numbers is gone, so the fix has to
be where the contract is chosen.

**The fix.** `selectContract` now resolves each candidate's expiry to an ISO date and drops anything
before today's IST date. A contract expiring *today* is kept, because it is still tradeable until the
close. An expiry that cannot be parsed is treated as expired - a contract we cannot date is one we
cannot promise is alive. The count of dropped contracts travels with the plan, so the reasons say
`2 expired ignored` rather than silently narrowing the choice.

**Test.** `selectContract refuses a contract that has already expired` reproduces the day exactly:
a 19 October put, a 20 October clock, a 0.05 premium.

---

## 2. Every option plan was unevaluable, forever

**What was seen.** Four times a minute, for as long as the harness ran:

```
WARN position cannot be evaluated  signal=5f750c79...  reason="short plan levels are out of
order (target 0.07, entry 0.05, stop 0.04)"
```

**Why it happened.** A plan carried one field that meant two different things. `plan.direction` is
the **market view** - `BEARISH`, because the bias meter expects the index to fall. The evaluator read
it as the **position side**, and a short position must have `target < entry < stop`.

But a bearish view buys a *put*, and buying a put is a **long position**: it pays when the premium
rises, so its target sits above its entry. W4 wrote exactly that, correctly. W7 then demanded the
level order of a short from the numbers of a long, refused, and did it again fifteen seconds later.
The same conflation also inverted `movePct`, so a put whose premium rose would have been scored as a
loss had it ever been scored at all.

The consequence was total: **no option signal could ever be evaluated.** `outcomes` could only ever
fill with spot plans, so the loss controls and the self-learning proposal - which need thirty closed
trades - would have stayed starved indefinitely, for a reason nobody could see in the dashboard.

**The fix.** A plan now states its own side in `plan.position`, and the evaluator uses it:

- an **option** plan is always `LONG`, because this harness only ever buys options and never writes
  one;
- a **spot** plan is `LONG` or `SHORT` to match the view, which is the one case where the view and
  the side really do coincide;
- when `position` is absent - a row written before the field existed - an option plan is read as
  long, so old rows are judged correctly instead of being parked.

`movePct` now takes a side rather than a direction, which is what it always meant. The evaluated
result carries both `direction` (the view, still reported as `BEARISH`) and `side` (`LONG`), and so
does the recorded outcome, so the distinction is visible after the fact rather than buried in a
worker.

**Tests.** `a bearish option plan is judged as the long position it is` is the regression: a bearish
put that rises to its target closes as `TARGET` with `+10%`, not as UNEVALUABLE.
`a bought put that falls to its stop is a loss, not a win` pins the sign the other way.

---

## 3. A closed market looked open to the whole pipeline

**What was seen.** The harness stored **six quote rows** and then nothing for the rest of the
session. The supervisor went `feed: STALE` at 10:39 and stayed there. The index quotes carried an
exchange stamp of **19 October 16:08 IST**; the equities carried **20 October 06:55 IST**, the
pre-open marker. No trading had happened all day, because 20 October 2026 is Dussehra.

**Why it happened.** The session clock modelled the weekend and the hours, and nothing else. On a
weekday holiday it reported an open market, and every consumer believed it:

- the bias meter did not apply its closed-session confidence cap, so the previous session's frozen
  prices were treated as current;
- the signal builder composed tradeable plans from them and reached `READY`;
- the risk gate saw a normal open session and had no reason to defer;
- ingestion kept polling a market that was not there;
- the supervisor called the resulting silence `STALE`, which was a true alarm raised for the wrong
  reason.

The comment in `session.js` had claimed a holiday "simply produces no fresh evidence upstream, so no
candidate is raised in the first place". The live run disproved it: evidence is not required to be
*fresh* to be used, only to be present.

**The fix.** `marketSession` checks a holiday list before it checks the clock. The list is the
published NSE/BSE 2026 list, weekdays only, held in `harness/src/session.js` as data and replaceable
wholesale through `config_registry` (`gates.session.holidays`). Because every consumer already asks
the same clock, one change fixed the ageing, the signal lifecycle, the risk gate, the ingestion
gates and the supervisor together.

The list is year-specific and must be refreshed annually. Its failure mode is benign: dates from a
past year never match, so a stale list degrades to the old weekend-and-hours behaviour rather than
inventing a closure. Muhurat trading is deliberately not modelled - one discretionary evening hour,
announced late, is not worth pretending is a normal session.

**Tests.** `marketSession closes on a published holiday and names the date` (20 October, a Tuesday,
so only the list can close it), `a holiday is CLOSED, not STALE` for the supervisor, and
`a holiday list can be replaced wholesale from config without losing the rest of the session`.

---

## 4. A standing warning was written as an event

The evaluator reported an unevaluable position on **every pass**, which is four times a minute per
position, 5,760 identical lines a day. That is not a log, it is a denial of service against whoever
reads it - and it hid the two real defects above in a wall of repetition.

`evaluateOpen` now reports each distinct reason **once per signal**, counts the passes that agreed
with it, reports again only if the reason changes, and says so when the position becomes evaluable.
The heartbeat already carries the counts, so nothing was lost.

---

## What was deliberately left alone

**NSE OI-spurt requests were timing out all session** (`The operation was aborted due to timeout`,
15s budget, both the underlying and contract endpoints). Angel's own quote calls were succeeding at
the same time, so this is not a dead network. It is unexplained, and it did not cause any of the
above - the flow data that produced the bad contract had been stored successfully the day before.
Worth watching on the next trading day before changing a timeout that might be correct.

---

## Verification

```
harness tests   204/204   (11 new)
selfcheck        51/51    (3 new)
web tests        25/25
```

The same defective inputs, replayed after the fix:

| | before | after |
|---|---|---|
| candidates raised on a holiday | 2 | **0** |
| evaluator warnings | 4/min, forever | **0** |
| supervisor feed state | `STALE` (WARNING) | **`CLOSED`** (info) |
| market / flow / option polls | ran against a closed market | `skipped: market-closed` |

A `harness:once` cycle on the holiday now reports
`market {quotes:0, skipped:"market-closed"}`, `signal {candidates:0}`,
`evaluate {unevaluable:0}` and `feed:"CLOSED"`.

The two artefacts the bug produced were cleared with `harness/scripts/reset-ledger.js --yes`
(2 signals, 2 candidates, 2 risk decisions, 57 stages, 4 events, 340 queue messages). Leaving them
would have held the `maxOpenPerSymbol: 1` slot on NIFTY SWING for thirty days, quietly blocking
every real swing signal on the index. Evidence tables and `config_registry` were untouched.

---

## Follow-up: an idle worker is not a broken one

The first holiday cycle after the fixes still left two false alarms in `sources_health`.

`flow-features WARNING - 0 symbols from 0 snapshot(s)`: W0 correctly stopped enqueuing flow
snapshots once the exchange shut, so W2 drained nothing - and marked that as a warning on every
drain, stamping `last_error_at` each time. A healthy harness would have shown a warn pill from
the close until the next open, every evening, weekend and holiday.

`angel-options WARNING - 2 open option position(s) could not be resolved to a contract`: a real
warning from the defective session, but nothing could clear it. With an empty book W0 returned
before writing anything, so the old row and its old `last_error_at` survived indefinitely.

Both workers now describe the idle state instead of guessing at a fault:

| situation | status | last_error_at |
|---|---|---|
| flow drain empty, exchange shut | `CLOSED` - no flow snapshots while the exchange is shut | untouched |
| flow drain empty, exchange open | `WARNING` - the poll that should have fed it failed | stamped |
| no open option position during the session | `IDLE` - no open option positions to quote | untouched |
| option contract(s) could not be resolved | `WARNING` | stamped |

Neutral statuses (`CLOSED`, `IDLE`) no longer touch `last_error_at`, and the dashboard maps both
to the muted tone, alongside the `CLOSED` feed state the supervisor already reports.

Covered by `harness/test/health-status.test.js` (5 cases).

---

## Still open

1. **The 2026 holiday list is a snapshot, not a feed.** Refresh it each January. It can be replaced
   without a deploy; the built-in copy is a convenience, not the source of truth.
2. **A stale flow snapshot can still name a live contract at a stale premium.** The expiry filter
   removes contracts that no longer exist. It does not detect a same-day contract whose quoted premium
   is hours old, because nothing in the flow payload says when that premium was struck. The bias
   meter's ageing is the only defence, and it is a confidence, not a veto.
3. **Rounded premiums make tiny numbers meaningless.** Levels are rounded to two decimal places, so at
   an entry of 0.05 a one-paise tick is 20% of the position. This is not a bug while the contract
   selection is correct - a live ATM NIFTY option trades in the tens or hundreds - but it is worth
   remembering if a genuinely cheap contract is ever selected.
