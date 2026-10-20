# Slice 9 - Session-aware ingestion

## Why this exists

The harness was always meant to run continuously, but its ingestion was written by people picturing a
job that wakes up, takes a reading and goes back to sleep. It had no notion of whether the exchange
was open.

Two of the three market-facing cycles in W0 - the quote poll and the OI-spurt flow poll - fired on a
timer around the clock. Nothing stopped them at the close, and nothing stopped them from storing what
they got:

| Cycle | Cadence | What one cycle writes |
|---|---|---|
| `runMarket` | 10 s | one `market_snapshots` row and one `quote.v1` feature row per symbol |
| `runFlow` | 60 s | the whole NSE OI-spurt table (~319 rows) plus a `flow.snapshot` job for W2 |
| `runOptionQuotes` | 10 s | already session-gated since Slice 8 |

After the close, and all weekend, the broker and NSE keep serving the last numbers they had. The
harness kept asking and kept archiving the answer. A single weekend works out to roughly **23,000
market polls** - about 140,000 quote rows, each duplicated again in `market_snapshots` - and about
**3,900 flow polls**, or **well over a million duplicate `oi_spurts` rows**, plus a W2 job per copy.

Nothing purges them. The retention floor in `db/schema.sql` protects rows from deletion inside ninety
days; it does not sweep old ones. At that rate a 24/7 harness would produce tens of millions of
identical rows a year, on a free-tier database, describing a market that was shut the whole time.

There was a second, subtler fault in the same area. The supervisor judged feed freshness purely by
"how long since the newest `market_snapshots` row?", with a two-minute threshold. Outside trading
hours that question has no sensible answer, so a correct pipeline would have reported a stale feed
every evening and every weekend - an alarm that would be ignored within a week, which is the same as
having no alarm.

## What changed

| File | Change |
|---|---|
| `harness/src/freshness.js` | New, pure. The two questions that were being got wrong: *has this batch changed?* (`batchFingerprint`, `RepeatTracker`) and *is the feed late?* (`feedState`). No database, no timer of its own, no network - the clock and the session are passed in. |
| `harness/src/workers/w0-ingest.js` | `runMarket` and `runFlow` now return early with `skipped: 'market-closed'` once the exchange is shut, mirroring `runOptionQuotes`. Both accept an injectable `now` so the gate is testable. The quote and option-premium persists additionally pass through a `RepeatTracker`, and each path returns what was **stored** next to what was **fetched**. |
| `harness/src/workers/w8-supervisor.js` | `feedFreshness()` delegates to `feedState`, which reports `CLOSED` out of hours instead of `STALE`. |
| `harness/test/freshness.test.js` | New. Seven tests over the fingerprint, the tracker and the feed state. |
| `harness/test/ingest-gate.test.js` | New. Three tests: the closed-market skip for both polls (asserting no provider is touched, using a stub that throws if it is), and the rule that an undated batch is never eligible for suppression. |
| `harness/src/selfcheck.js` | Three new checks (45 -> 48). |

No schema change. Migration `0008` remains the latest, and `npm run harness:schema` is still the
(unchanged) upgrade step.

## Two different questions

The fix turns on noticing that "the market is shut" and "the feed is frozen" are not the same failure
mode, and that the harness needed different behaviour for each.

**A shut market is not a fault.** No reading can exist, so there is nothing to ask for. Asking anyway
burns broker quota re-learning a number we already hold, and hammers NSE's public endpoints
1,000+ times a night for a table that stopped changing at 15:30. So the poll itself is skipped, and
the last in-session reading stands as the last known price. `isMarketOpen()` - the same shared clock
the risk gate and the bias meter already use - is the whole test.

**A frozen feed is not new evidence.** This is the case the session clock cannot see: the market is
nominally open, but the source is handing back what it gave us last time. It happens on an NSE
holiday, when the exchange is shut but `isMarketOpen()` has no way to know, and it happens during a
real feed stall. The repeat guard catches it by fingerprinting the batch and comparing it with the
last one stored for that source. Identical content is not stored twice, whatever the clock says.

The two mechanisms are deliberately independent. Either one alone leaves a hole: the gate misses
holidays, and the guard alone would still spend the night asking.

## Why flow is gated but not fingerprinted

The repeat guard was first written for all three cycles. It survives in two of them, and the reason
the third is different is the most interesting thing in this slice.

Quotes and option premiums carry the exchange's own timestamp (`quoteTime`), and both the bias meter
and the evaluator age a reading by *that stamp*, not by when it was captured. When the guard fires,
the stamp it fires on is the same stamp the reading would be aged by - so suppressing the batch
provably cannot change how the reading is aged. It is a storage change and nothing else.

OI-spurt rows have no stamp. NSE does not publish one, so the harness dates flow evidence by its
**capture time**: W2 writes `flow.v1` with the snapshot's `capturedAt`, and the bias meter ages the
flow component by that `as_of`. Suppressing an "unchanged" flow capture would therefore have quietly
aged the flow component of the brain while the market was wide open - trading off decision quality
for disk space, and doing it invisibly.

The guard was removed from the flow path. The cost is bounded and small: on a holiday the poll now
runs for the session and archives the static table for roughly one extra trading day's worth of
rows, about 7% on top of what in-session polling already writes. The session gate is where almost all
of the flow saving comes from - it removes the ~76% of the day when nothing can change.

The same reasoning tightened the other two paths: the guard only applies when **every** reading in
the batch carries a stamp. A stock or index whose timestamp could not be parsed degrades to `null`,
is aged by its capture time, and must therefore be re-stored - otherwise an unparseable feed would
be indistinguishable from a frozen one.

## The guard lives in memory, on purpose

`RepeatTracker` keeps one fingerprint per source in a `Map` in the worker process, rather than
comparing against the database. The question is asked on the hot path - every ten seconds - and the
worker is long-lived, so the answer is already in hand. A restart costs at most one duplicate row,
which is a better trade than a database round-trip on every poll to learn something the process could
have remembered.

The fingerprint canonicalises key order before hashing, so a payload is judged on what it says rather
than on the order it happened to be built in.

## Storing nothing is not failing

Both poll paths now distinguish **what the source answered** from **what was worth storing**, and the
provider waterfall keys off the former:

```
quotes: stored, fetched: rows.length, provenance
```

Without that split, a frozen-but-healthy Angel feed would look like an empty response, `runMarket`
would fall through to the Yahoo fallback, and the pipeline would report a provider failure every time
the market was quiet. The source-health detail says both numbers - `6 quotes (0 new)` - instead of
implying the broker returned nothing.

## Verification

Unit tests: the fingerprint ignores key order and changes with the payload; the tracker suppresses a
repeat and lets a moved reading through; sources are tracked separately; a weekend batch reads
`CLOSED` even when the last reading is a day old; the staleness threshold still applies during a live
session.

The gates are tested by observation, not by inspection. A stub provider that throws if it is called
stands in for the broker, and the polls must return `market-closed` without touching it:

```
PASS  slice 9 market-derived polls stop once the exchange is shut  - market=market-closed flow=market-closed
PASS  slice 9 a frozen feed is recognised rather than re-archived
PASS  slice 9 a closed market reads CLOSED so the supervisor is not falsely alarmed overnight  - state=CLOSED
```

Totals: harness tests **193/193** (10 new), selfcheck **48/48** (3 new).

## Known limitations, stated plainly

1. **NSE holidays read as stale _(fixed in Slice 10)_**. Public holidays were not modelled anywhere in
   the harness, so on one the session clock said "open" while the exchange was shut. The market poll
   stored one batch and then suppressed the identical repeats, the flow poll kept archiving the static
   table for the day (the guard that would have stopped it was removed on purpose, above), and the
   supervisor reported `STALE` for the day. That false positive was the deliberate trade: a warning
   that fires on fifteen known holidays is better than a silent gap that hides a genuine feed failure
   during trading hours. It was the right trade, and it was still worse than the fix - on 20 October
   2026 the same gap let a closed market look open to the *whole* pipeline, not just the supervisor.
   See [`slice-10-live-session-fixes.md`](./slice-10-live-session-fixes.md).
2. **The last reading before the close is the record.** Flow stops being polled at 15:30, so the
   final archived flow snapshot is the one taken just before the close, not any post-close revision
   NSE may publish. Nothing downstream reads flow out of hours, and the next session's first poll
   supersedes it, but the archive is one reading short of "settled".
3. **The repeat guard resets on restart.** A worker that restarts mid-holiday stores one duplicate
   batch before it recognises the freeze again. Bounded at one per restart, by design.
4. **No signals are affected.** This slice changes when data is fetched and stored, not how it is
   scored. Bias weights, the signal lifecycle, the risk gate and the publisher are untouched.
