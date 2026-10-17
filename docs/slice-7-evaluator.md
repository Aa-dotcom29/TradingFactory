# Slice 7 - The evaluator

## Why this exists

Slices 0-6 built a chain that decides what to do: news -> flow -> bias -> signal -> risk gate ->
publisher. Nothing in it ever asked what happened next.

The cost was concrete. `risk.js` has fourteen gates. Four of them exist to stop a *losing streak*
from being compounded - `consecutiveLossHalt`, `cooldownAfterLoss`, `dailyLossLimit`, and the
published-history half of `duplicateWindow`. All four were implemented in Slice 5, all four had
tests, and all four reported `SKIPPED` on **every single evaluation since the day they shipped**:

```
consecutiveLossHalt  SKIPPED  no closed trades recorded yet
cooldownAfterLoss    SKIPPED  no recorded loss to cool down from
dailyLossLimit       SKIPPED  no closed trades today
```

They were not broken. They were starved. W5 reads `outcomes`, `outcomes` was always empty because
nothing wrote it, and the result was a risk gate approving on ten of fourteen gates with every
loss-avoidance control dark. Published signals also doubled as the open-position ledger, which is
why `maxOpenPerSymbol` had to be pinned at 1.

W7 is the missing half of the loop. It closes positions, writes outcomes, scores them, and proposes
config changes for a person to approve.

## What changed

| File | Change |
|---|---|
| `harness/src/outcome.js` | New. The pure decision logic: exit selection, ambiguity adjudication, MFE/MAE, scoring, and proposal generation. No database, no clock, no queue. |
| `harness/src/workers/w7-evaluate.js` | New worker. Queue trigger + durable scan, price-path read, outcome/event writes, scorecard, and the proposal pass. |
| `harness/db/schema.sql` | Migration `0007_slice7_evaluate`: `outcomes (signal_id)` becomes **unique** (idempotency), plus `evaluated_at` and `(horizon, result)` indexes. |
| `harness/src/workers/w6-publish.js` | Emits the `signal.published` topic that was declared for it in Slice 0 and never sent. |
| `harness/src/run.js` | Role `w7` added to `ROLES`, the `--once` pipeline and the scheduler. |
| `harness/src/selfcheck.js` | Six new checks (31 -> 37). |
| `harness/test/outcome.test.js` | New. 34 tests, no network, no database. |
| `harness/scripts/approve-config.js` | New. `npm run harness:config` - list proposals, approve one, retire one. |
| `web/lib/queries.js` | `getOutcomes`, `getOpenPositions`, `getOutcomeStats`, `getProposals`; counts added to `getHealth` and `getHorizonPulse`. |
| `web/components/Outcomes.js`, `web/components/Proposals.js` | The settled ledger and the approval queue. |
| `web/lib/format.js` | `outcomeTone`, `resultTone`, `resultLabel`. |

## The exit decision

A published signal is an open position until something closes it. W7 walks the price readings
recorded at or after publication, in time order, and takes the **first** level reached:

| Direction | Target reached when | Stop reached when |
|---|---|---|
| `BULLISH` | price `>=` target | price `<=` stop |
| `BEARISH` | price `<=` target | price `>=` stop |

If nothing is reached and the horizon's holding window has elapsed, the position closes as `TIME` at
the last price **inside** the window - the mark the horizon actually promised to hold for, not
whatever drifted in afterwards.

Three rules are worth stating because they are where an evaluator usually lies to itself:

1. **Ambiguity resolves to the stop.** A reading may carry `high`/`low`, and a bar can touch both
   levels. We cannot know the order, so the worse outcome is assumed and the outcome row records
   `ambiguous: true`. Only a bar can do this - a bare price is its own high and low, so the common
   path is never ambiguous.
2. **Levels are validated before anything is judged.** A long whose target sits below its entry, or
   whose stop sits above it, is `UNEVALUABLE`. Deciding anyway would launder a data bug into a
   trade record.
3. **Excursion stops at the exit.** MFE and MAE are measured only across the readings up to and
   including the exit, because what the price did after the position closed is not this trade's
   excursion.

## What it refuses to do

**It will not score an option-premium plan against the underlying price.** An option plan's entry,
target and stop are on the option *premium*, and the underlying quote is not a premium. The two are
different instruments, so the comparison would produce a confident, meaningless number and feed it
straight into the loss controls. The check is enforced inside the pure evaluator, not just in the
worker, so a caller that hands over the wrong series cannot slip one through.

Since Slice 8 that refusal no longer means "never scored": W0 persists each held option's own premium
history under `option.quote.v1`, keyed by the contract (`NIFTY|2026-10-19|23150|CE`), and W7 judges an
option plan on that. A position with no premium readings yet is `awaiting price source` while its
window is open, and settles as `NO_PRICE_SOURCE` once the window elapses. The plan label does not get
the last word either: if a plan carries a strike it is treated as an option plan even if it calls
itself `SPOT`.

**It will not trust the storage time of a quote.** A price reading is dated by the market timestamp
the quote carries (`values.quoteTime`), not by `features.as_of` - when we happened to store it. A
Friday close re-stored on Monday therefore cannot masquerade as a fresh level breach. This is the
same staleness discipline the bias meter still lacks, and it matters most for `INTRADAY`.

**It will not apply a config change.** See below.

## The holding window is shared with the gate

W7 resolves its holding window from the `risk` config family - the same place, and through the same
helper, that W5 uses for the exposure gates. `holdingDays` is `{ INTRADAY: 1, SWING: 30,
POSITIONAL: 180 }`. A position cannot be "open" to the exposure gate and "closed" to the evaluator at
the same time, because there is only one definition.

## Proposals: the machine suggests, a person decides

When the record is weak - below a 40% win rate, negative expectancy, or adverse excursion running
deeper than realised losses - W7 proposes **one** change: raising `gates.minConfidence` by 0.05. It
only ever tightens. It has no business proposing that the system take more risk.

Two guards make that safe rather than decorative:

- **A minimum sample size.** Below 30 closed trades W7 proposes nothing at all. Tuning weights
  against a dozen trades is how a quiet system talks itself into losses.
- **A proposal cannot be live.** It is written as a `candidate` row in `config_registry`. Every
  worker resolves the latest `approved` version, so an unapproved proposal has no effect anywhere in
  the pipeline. One proposal at a time is held open, so the queue cannot fill with variations.

Approval is a deliberate, auditable act:

```
npm run harness:config -- --list
npm run harness:config -- --approve=risk-w7-20261017T101500 --by=owner@tradingfactory.test
npm run harness:config -- --retire=<version>
```

The row records who approved it and when, and keeps the evidence that motivated it in `metrics`.

## Verification

### Unit (no database)

`harness/test/outcome.test.js` - 34 tests: target/stop/time for both directions, first-level-wins,
same-bar ambiguity, bars versus bare prices, excursion bounds, window-end marking, pre-publication
filtering, ordering, all six refusal paths, plan-kind resolution, scoring, and every proposal guard.

### End to end, against a scratch database

The live ledger cannot hold a test fixture - published signals are immutable and retention-protected,
so a synthetic signal would be a permanent fake trade in the household record. The proof therefore
runs against a throwaway database (`tradingfactory_w7check`), which is dropped afterwards.

Two positions are seeded 40 days back with their outcome already determined in the price path: one
that runs to its target (+10%) and one that collapses to its stop (-20%). One deliberately clean
candidate is seeded with good confidence, good reward:risk, liquidity, a fresh timestamp and a
symbol nobody holds - so any gate that fails afterwards can only be a loss control.

**Before W7** - the gate judges the candidate and the loss controls are dark:

```
latest risk decision: DEFERRED (14 gates)
  session              DEFER    NSE is closed at the weekend (session 09:15-15:30 IST)
  consecutiveLossHalt  SKIPPED  no closed trades recorded yet
  cooldownAfterLoss    SKIPPED  no recorded loss to cool down from
  dailyLossLimit       SKIPPED  no closed trades today
```

**W7 runs** (`--role=w7 --once`):

```
position closed  horizon=SWING symbol=RELIANCE result=STOP   pnlPct=-20
position closed  horizon=SWING symbol=NIFTY    result=TARGET pnlPct=10
evaluate result  closed=2 open=2 awaiting=0 unevaluable=0 failed=0
                 scorecard={total:2, wins:1, losses:1, winRatePct:50}
                 proposalReason="only 2 closed trade(s); 30 needed before proposing anything"
```

Outcomes written, and the excursion arithmetic is right in both directions:

| Symbol | Result | Entry -> exit | P&L | MFE | MAE | Readings |
|---|---|---|---|---|---|---|
| RELIANCE | STOP | 100 -> 80 | -20% | 0% | -22% | 2 |
| NIFTY | TARGET | 100 -> 110 | +10% | 11% | 0% | 2 |

**After W7**, the same candidate is judged again and the loss controls are live:

```
latest risk decision: REJECTED (14 gates)
  session              DEFER    NSE is closed at the weekend (session 09:15-15:30 IST)
  consecutiveLossHalt  PASS     0 consecutive loss(es), halt level 3
  cooldownAfterLoss    FAIL     the last loss was 0 min ago; cooling down for 60 min
  dailyLossLimit       FAIL     today is -10%, past the 3% daily loss limit
```

Two things are established at once. The loss controls now read real numbers instead of `SKIPPED`.
And the decision moved from `DEFERRED` to `REJECTED` **while the market was shut** - so a failing
loss control outranks the holiday deferral, exactly as the gate's ordering promises.

After the proof the scratch database is dropped; the household ledger is untouched.

### The live ledger

`npm run harness:once` on Saturday 2026-10-17 (market closed), Angel One unconfigured:

```
risk result     evaluated=11 approved=0 rejected=3 deferred=8
publish result  published=0 orphans=0
evaluate result triggers=0 closed=0 open=4 awaiting=0 unevaluable=0 failed=0
                scorecard={total:0, wins:0, losses:0, winRatePct:null}
                proposalReason="only 0 closed trade(s); 30 needed before proposing anything"
```

Four published positions, none of them at a level, none past its window, so none closed. That is the
correct answer, not a failure: it reports zero honestly rather than manufacturing a resolution.

Totals: harness tests **152/152** (34 new), web tests **22/22** (2 new), selfcheck **37/37**
(6 new), `next build` clean.

## Known limitations, stated plainly

1. **A position that is never priced settles with no verdict once its window elapses.** If a symbol
   stops being polled, no readings arrive and no level is ever reached, so there is nothing to judge.
   Instead of staying open forever, the position is closed as `NO_PRICE_SOURCE` with no exit and no
   pnl once the horizon's holding window has run out - it settles the ledger without inventing a
   return, and the risk gate's loss streak skips it rather than reading it as a break. While the
   window is still open it simply shows as `open`.
2. **An option position is only scored once its premium history exists.** Since Slice 8 W0 polls the
   held contracts and persists each premium under `option.quote.v1`, so an option-premium plan is
   judged on its own premium series. A position whose contract cannot be resolved, or which was
   opened before the premium series began, has no readings and shows as `awaiting price source` while
   its window is open, settling as `NO_PRICE_SOURCE` once the window runs out - so it holds no
   exposure slot forever and never invents a return. The premium path starts at the first poll after
   publication, and there is no option quote history for positions opened before this slice.
3. **`bars_held` counts readings, not bars.** With a quote polled every few seconds, one reading is
   one observation. It is honest but coarse; `payload.heldMinutes` carries the real duration.
4. **Excursion uses the readings, not intra-bar extremes.** The quote payload's `high`/`low` are the
   *day's* range, so passing them in as a bar would report the target as hit on the open. The path
   therefore uses `ltp` only, and MFE/MAE are as coarse as the sampling. The module supports real
   bars via per-reading `high`/`low` as soon as a source provides them.
5. **The proposal rule is conservative and narrow.** Raising `minConfidence` is the only change W7
   can suggest. Bias weights, signal thresholds and the other twelve risk gates are not tuned by
   anything. That is intentional for a first pass, but it is not "self-learning" in any broad sense -
   it is one knob, moved one way, only after evidence.
6. **`dailyLossLimit` uses the UTC day boundary.** `date_trunc('day', now())` in the gate means the
   daily loss window resets at 00:00 UTC, which is 05:30 IST - before the NSE opens, so the trading
   day and the loss day happen to line up. It is correct by accident of offset, not by design, and it
   would be worth making explicit before it is relied on.

## Environment

No new configuration. W7 reads the `risk` config family that W5 already registers, and shares
`holdingDays` with the gate. `HARNESS_ROLE=w7` runs it alone; `all` includes it.
