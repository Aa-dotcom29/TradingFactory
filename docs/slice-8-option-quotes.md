# Slice 8 - Option-premium persistence

## Why this exists

Slice 7 gave the harness an evaluator, and it immediately ran into an honest wall. A plan that trades
an option quotes its entry, target and stop on the option *premium*, while the only price history the
harness kept was the underlying spot. Judging one against the other would produce a confident,
meaningless number and feed it straight into the loss controls, so W7 refused: an option-premium
position showed as `AWAITING_PRICE_SOURCE` while its window was open and settled as `NO_PRICE_SOURCE`
once the window ran out.

That refusal was correct, and it had a cost. Every option signal, which is most of what this pipeline
is for, could close without ever producing an outcome. Nothing was learned from it, and the risk
gate's loss controls stayed dark for exactly the trades that needed them most.

The missing piece was never logic. It was a price series for the instrument the plan actually trades.

## What changed

| File | Change |
|---|---|
| `harness/src/contract.js` | New, pure. The contract identity (`contractKey`), the tolerant expiry parser, the universe-to-master underlying alias, and `matchOptionToken`, which resolves a target to an NFO token. No network, no database, no clock. |
| `harness/src/workers/w0-ingest.js` | New `runOptionQuotes()` cycle: resolve each held option position to its contract, quote it on NFO, persist the premium under `option.quote.v1`. Wired into `runAll` and the scheduler. |
| `harness/src/outcome.js` | `evaluateOutcome` now takes the price series and the source it came from, and refuses a pair that describes different instruments. An option plan with a premium series is scored; without one it is unchanged. |
| `harness/src/workers/w7-evaluate.js` | `loadPricePath` reads the option series for an option plan, keyed by the contract, and the underlying series otherwise. The outcome payload records which series was used. |
| `harness/src/sources/angel-client.js` | The instrument-master download is memoised against concurrent callers, so the two quote paths in one cycle share one 20 MB fetch instead of racing for two. |
| `harness/db/schema.sql` | Migration `0008_slice8_option_quotes`: `market_snapshots.kind` gains `OPTION_QUOTE`, plus a `features (feature_set, symbol, as_of)` index for the evaluator's per-contract read. |
| `harness/scripts/angel-check.js` | A new best-effort step: resolve the at-the-money CE and quote it, proving the premium path end to end. |
| `harness/src/selfcheck.js` | Two new checks (43 -> 45). |
| `harness/test/contract.test.js` | New. Seven tests over the real master shapes. |

## The hard part is the identity

W0 writes a premium series and W7 reads it back. They never talk to each other - a queue message is a
trigger, and the durable tables are the truth - so they have to derive the *same* key independently.
The same contract is described three different ways on the way through:

- the harness carries the universe symbol it has always used: `NIFTY 50`, `BANK NIFTY`, `MIDCAP NIFTY`
- NSE's OI-spurt flow names the expiry as `19-Oct-2026`
- Angel's scrip master stores the expiry as `19OCT2026`, and stores the strike multiplied by **100**:
  the 20300 strike is `2030000.000000`

All of that lives in `harness/src/contract.js`, in one pure module, so the matching rules exist in one
place instead of being re-derived - differently, and eventually wrongly - in a worker and a query. The
canonical key is `NIFTY|2026-10-19|23150|CE`, stored as the `symbol` of an `option.quote.v1` row and
recomputed from the signal when W7 reads it back.

Every convention here was read off a live master rather than assumed. `MIDCAP NIFTY` maps to
`MIDCPNIFTY`, not to anything guessable; the x100 strike scaling is real; the alias table would have
been wrong if it had been invented.

## Only the contracts we hold

W0 does not poll the option chain. It polls the contracts the harness is **actually holding** - open
option positions, resolved to NFO tokens, batched into one call - and writes each premium under its
contract key. A full-chain feed would be an unbounded cost for data nothing reads.

Nothing is enqueued for these rows. The bias meter and the signal builder read `quote.v1`, and an
option contract must never enter the universe as if it were a tradeable symbol. The premium series is
written and read, never fanned out.

The series is also self-describing: each row carries the underlying, expiry, strike, option type and
token, so a stored premium can be traced back to its contract without consulting an instrument master
that changes every day.

## The refusal that survives

The instrument check is enforced in the pure evaluator, not only in the worker. An option plan offered
a spot series is still refused; an underlying plan offered a premium series is `UNEVALUABLE`, because
that is a caller bug rather than a position we are waiting on. A caller that forgets to say which
series it loaded lands on the refusal, never on a score - the default is the ordinary spot series, and
the guard is meaningful only if the default is the one that fails closed.

A contract that cannot be resolved against the daily master is counted and reported, not guessed at.
Pricing the wrong strike would be worse than pricing nothing.

## Verification

The broker path was proved against the live account, not a fixture:

```
PASS  option quote  - NIFTY19OCT2623150CE ltp=69.4 openInterest=6312280 -> 2026-10-17T01:25:09.000Z
```

The at-the-money contract was resolved from the live master through the same matcher W0 uses, then
quoted on NFO with a real premium and open interest.

The write and the read were then proved to agree, end to end against the database: three premium
readings were stored under `NIFTY|2026-10-19|23150|CE`, an option signal on that contract was
evaluated, and W7 walked the premium series back to its target.

```
W7 evaluateSignal: CLOSED / TARGET / pnlPct 10
outcome row: result=TARGET exit=110 pnl_pct=10 mfe=12 mae=0 bars_held=3 price_source=option.quote.v1
```

That test signal was removed afterwards; the ledger is back to its four pre-existing signals and no
outcomes.

Totals: harness tests **183/183** (10 new), selfcheck **45/45** (2 new).

## Known limitations, stated plainly

1. **There is no option quote history before this slice.** An option position opened earlier has no
   premium readings and behaves exactly as it did in Slice 7 - `AWAITING_PRICE_SOURCE`, then
   `NO_PRICE_SOURCE` once the window runs out. There is nothing to reconstruct; the readings were
   never taken.
2. **The premium path starts at the first poll after publication.** The plan's entry comes from the
   flow snapshot, so the first reading can differ from it. That gap is sampling, not error, and it is
   the same gap the underlying series has.
3. **Only held contracts are polled.** A contract that leaves the master, or a signal whose expiry or
   strike cannot be parsed, resolves to nothing and is reported as unresolved. It is never priced
   against a plausible-looking neighbour.
4. **This is decision support.** Nothing here places an order; execution stays manual.
