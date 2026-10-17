# Evidence ageing

The bias meter turns three inputs into a direction: **news**, **flow** and **price**. Each one can
go stale, and a stale input presented as current is the most dangerous kind of wrong number - it
looks live. This note records how each input is dated, discounted, and kept honest.

It closes two defects found during the slice-7 review:

1. `priceSignal` had no timestamp, so outside a session the last close read as current momentum.
2. `news` and `flow` had no age at all, and a confidence-only change was never written, so a stale
   row could stand in for a fresh one downstream.

## The model

Every component keeps its **score** - the direction of the last read is still information - and
carries its honesty in its **confidence**. A component that cannot be dated is not penalised (we do
not invent staleness we cannot measure); a component that can be dated decays from
`freshMinutes` to `staleConfidenceFloor` at `maxAgeMinutes`.

| Component | Dated by | Session cap | Window (fresh -> floor) |
| --- | --- | --- | --- |
| `price` | `quote.v1.quoteTime`, else the feature `as_of` | yes, `closedSessionConfidence` 0.2 | 15m -> 60m -> 0.2 |
| `flow` | the feature `as_of` (OI snapshots carry no time of their own) | yes, `closedSessionConfidence` 0.2 | 15m -> 60m -> 0.2 |
| `news` | `news.entity.v1.latestAt` (the newest headline on the entity) | **no** | 2h -> 48h -> 0.25 |

Why the asymmetry:

- **Price and flow are session-bound.** Outside the NSE session the most recent close and the last
  session's open-interest build-up are *settled priors*, not live reads. They are capped at
  `closedSessionConfidence` regardless of when we captured them - which matters because an
  after-hours poll can stamp fresh `as_of` on data that is really from the previous session. The
  cap, not the capture time, is what makes that safe.
- **News is not session-bound.** A company announcement made after the close is still news in the
  morning, so capping news by the session would be wrong. It ages from the headline's own
  publication time, and its fade window is aligned with the 48h news aggregation window, so it is
  fully decayed exactly when it drops out of the aggregate.

The knobs live under `price`, `flow` and `news` in the `bias` config family and are human-approved
like every other weight: `freshMinutes`, `maxAgeMinutes`, `staleConfidenceFloor`, and (price, flow)
`closedSessionConfidence`.

## Keeping it visible

`isMaterialChange` now treats a **confidence move** as material (`materialChange.confidenceDelta`,
0.05), alongside a direction flip and a score move. Without this, ageing only changed a number the
ledger never recorded - the stored verdict kept its old confidence until the 15-minute staleness
heartbeat, and W4/W5 read that stale row. With it, a confidence drop reaches `bias_verdicts` and the
`bias.verdict` message the moment it happens.

## Live evidence

Before the change, on a Saturday with the market shut, the recomputed intraday NIFTY verdict was:

```
INTRADAY  NIFTY  BULLISH  conf=0.616   news=1  flow=1  price=1
```

After it, the same features recompute to:

```
INTRADAY  NIFTY  BULLISH  conf=0.216   news=1  flow=0.2  price=0.04
  flow detail:  [flow 0m old; market closed: last session flow is not live]
  price detail: [quote 1468m old; market closed: last close is not live]
```

The direction survives at 0.216 - just above the 0.2 floor - because NIFTY genuinely had a fresh
headline (about 50 minutes old) at the time. That is the intended behaviour: the call is no longer
carried by an eighteen-hour-old close or the previous session's open-interest build-up, it is
carried by fresh news, at a confidence near the floor. Verdicts with no fresh input fall to
`NEUTRAL`.

Recomputed vs the stored ledger matched to four decimals for every symbol whose confidence moved by
at least the material threshold; symbols whose move was smaller correctly stayed unchanged until the
staleness heartbeat.

## Honest limitations

1. **Windows are per component, not per horizon.** A 24-hour-old headline decays the same amount for
   an intraday and a positional verdict. Per-horizon windows would be more precise; they would also
   triple the config surface. The current design is defensible because the horizon *weights* already
   differ (news is 0.1 of intraday and 0.4 of positional), but it is a simplification.
2. **Flow is dated by capture time.** OI snapshots carry no measurement timestamp through
   W0 -> W2 -> `features`, so the after-hours case leans entirely on the session cap. During a
   session the capture time is close to the data time, so the two agree; a source that supplied the
   exchange's own OI timestamp would be dated exactly.
3. **Angel quotes carry no `quoteTime`.** They fall back to `features.as_of` (capture time), which
   again relies on the session cap outside hours. Yahoo is the only feed currently stamping its own
   exchange time.
4. **The score is not aged, only the confidence.** A stale read still votes its direction; it simply
   cannot reach the direction threshold on its own. This is deliberate - it makes the decay
   inspectable in `detail` rather than silently hiding evidence - but it does mean a stale component
   still contributes to the blended score.
