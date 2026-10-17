# Slice 5.5 - Quote provenance and the Yahoo fallback source

## Why this exists

Slices 0-5 built a complete chain: news -> flow -> bias -> signal -> risk gate -> publisher. It ran
correctly and produced almost nothing useful, because every step was starved of one input. With
Angel One unconfigured, W0 had no quotes, so `priceSignal` returned `unavailable` for every symbol.
The bias meter then combined a thin two-component picture (`news` + `flow`) and every verdict sat
at the evidence floor: coverage 0.40-0.55, confidence 0.02-0.16, direction `NEUTRAL`. W4 then
withheld `READY` because `readyConfidence` (0.4) was never reached, so W5 and W6 had nothing to
evaluate.

That looks like a broken pipeline. It was not. It was a missing feed. This slice adds a free feed
and, more importantly, makes the *origin* of every number explicit so a degraded input can never be
mistaken for a good one.

## What changed

| File | Change |
|---|---|
| `harness/src/sources/yahoo.js` | New. Dependency-free client for the public Yahoo chart API. Maps NSE names to Yahoo tickers, parses `meta` into the `quote.v1` shape, and never throws: failures come back per symbol. |
| `harness/src/workers/w0-ingest.js` | `runMarket` became a provider waterfall. New `persistQuotes` single insert path, `marketViaAngel` and `marketViaYahoo`. |
| `harness/src/config.js` | New `yahoo` block (`HARNESS_YAHOO_*`). |
| `harness/src/workers/w3-bias.js` | `latestFeatureMap` now returns provenance; `bias_verdicts.provenance` is written and the queue payload carries `quoteProvenance`. |
| `harness/src/workers/w4-signals.js` | Same, onto `signal_candidates.provenance`. |
| `harness/db/schema.sql` | Migration `0006_slice5_quote_fallback`: `provenance` on `features`, `bias_verdicts`, `signal_candidates` plus a `features (feature_set, provenance, as_of desc)` index. |
| `harness/src/selfcheck.js` | Three new checks (28 -> 31). |
| `harness/test/yahoo.test.js` | New. Eleven tests, no network: mapping, parsing, fallbacks, per-symbol failure, empty universe. |
| `web/lib/format.js`, `web/components/Provenance.js` | `provenanceTone` / `provenanceLabel` and the pill that renders them. |
| `web/lib/queries.js`, `web/components/BiasPanel.js`, `web/components/SignalCandidates.js` | Provenance is selected and displayed next to the direction on both panels. |

## The provider waterfall

```
runMarket()
  |
  +-- Angel One configured?
  |     yes -> marketViaAngel()
  |              quotes > 0  -> done              (provenance: angel-live)
  |              quotes = 0  -> fall through      (sources_health: angel WARNING/ERROR)
  |     no  -> record `angel DISABLED`
  |
  +-- HARNESS_YAHOO_ENABLED?
  |     no  -> give up: { skipped: 'no-quote-source' }
  |     yes -> marketViaYahoo()                  (provenance: yahoo-delayed)
  |
  +-- both unavailable -> quotes: 0, per-symbol errors recorded, pipeline continues
```

The live broker feed always wins. The fallback exists so a half-configured household still gets a
working pipeline, not so the delayed source becomes normal. The moment Angel One credentials are
set, Yahoo stops being called and the rows revert to `angel-live`.

Symbol mapping is the interesting part. The universe is written in human names (`NIFTY 50`,
`BANK NIFTY`, `MIDCAP NIFTY`, `RELIANCE`) which W3 resolves through `normalizeUniverseSymbol`, so a
Yahoo row must be stored under the *normalised* NSE symbol (`NIFTY`, `BANKNIFTY`, `MIDCPNIFTY`,
`RELIANCE`) or W3 would never match it. Index aliases are explicit because Yahoo uses its own
tickers; equities are just suffixed `.NS`.

| NSE symbol | Yahoo ticker |
|---|---|
| `NIFTY` | `^NSEI` |
| `BANKNIFTY` | `^NSEBANK` |
| `MIDCPNIFTY` | `^NSEMDCP50` |
| `FINNIFTY` | `^CNXFIN` |
| anything else | `<SYMBOL>.NS` |

## Provenance contract

One string travels the whole chain:

| Value | Meaning | Rendered as |
|---|---|---|
| `angel-live` | Angel One SmartAPI, the live broker feed | `live feed` (accent) |
| `yahoo-delayed` | Yahoo Finance; NSE quotes lag the exchange by ~15 min | `delayed quotes` (warn) |
| `null` | no quote was involved for this row (news/flow only) | nothing is rendered |

`null` is the honest default and it is not the same as "live". A verdict built only from news and
flow shows no pill, which is exactly right: there was no price, so there is nothing to attribute.

The value is set once, on the `features` row, and then copied forward. It is never inferred
downstream, so it cannot drift from the row that actually carried the number.

## Verification

Run against local Postgres 18 on Saturday 2026-10-17 around 02:05 IST (market closed), Angel One
unconfigured, `PUBLISH_MODE=shadow`.

`npm run harness:once`:

```json
"market":  {"quotes":6,"failed":0,"provenance":"yahoo-delayed"}
"bias":    {"computed":51,"persisted":51,"emitted":51,"configVersion":"bias-v1"}
"signal":  {"computed":51,"persisted":51,"candidates":12,"superseded":1,"configVersion":"signal-v1"}
"risk":    {"evaluated":12,"approved":0,"rejected":1,"deferred":11,"recorded":12,"configVersion":"risk-v1"}
"publish": {"published":0,"failed":0,"orphans":0}
```

Stored quotes (`features`, set `quote.v1`, latest `as_of`):

| Symbol | Provenance | LTP | Prev close | Move | Exchange time |
|---|---|---|---|---|---|
| NIFTY | yahoo-delayed | 23146.15 | 22622.70 | +2.31% | 2026-10-16T10:01:07Z |
| BANKNIFTY | yahoo-delayed | 55844.00 | 55316.00 | +0.95% | 2026-10-16T10:01:07Z |
| MIDCPNIFTY | yahoo-delayed | 16946.30 | 16997.30 | -0.30% | 2026-10-16T10:01:07Z |
| TCS | yahoo-delayed | 2465.00 | 2350.00 | +4.89% | 2026-10-16T09:58:55Z |
| RELIANCE | yahoo-delayed | 1211.20 | 1215.00 | -0.31% | 2026-10-16T09:58:55Z |
| HDFCBANK | yahoo-delayed | 728.85 | 726.85 | +0.28% | 2026-10-16T09:58:55Z |

Cross-check: the NIFTY last price (23146.15) matches the underlying price on the NSE OI-spurt rows
already stored by W0, which is an independent source. The Yahoo numbers are therefore the same
numbers NSE is publishing, just late.

Effect on the chain, before vs after, over the same 51 (horizon, symbol) verdicts:

| | Before (no quote) | After (Yahoo) |
|---|---|---|
| `price` component | unavailable everywhere | available for all 6 quoted symbols |
| Directions | 51 NEUTRAL | 36 NEUTRAL / **15 BULLISH** |
| Confidence range | 0.02 - 0.16 | up to **1.00** (NIFTY), 0.85 (RELIANCE) |
| Signal candidates | 0 | **12** |
| Risk decisions | none | 1 REJECTED, 11 DEFERRED (market closed) |

Provenance row counts: `features` 6, `bias_verdicts` 18, `signal_candidates` 12 of 20 total (the
other 8 predate this slice and correctly carry `null`).

`sources_health` shows both sources side by side, labelled:

```
angel          DISABLED  Angel One credentials not configured
yahoo-quotes   HEALTHY   6 delayed quotes
```

Dashboard: all four pages return 200 and render the pill - `/dashboard` 14 pills, each horizon page
18. The `decisionTone` audit trail is unchanged and still present on every page.

Test totals: harness 118/118 (11 new), web 20/20 (1 new), `harness:selfcheck` 31/31 (3 new).

## Known limitations, stated plainly

1. **A quote is now aged (fixed).** `values.quoteTime` records the exchange timestamp and
   `features.as_of` records when we captured it. `priceSignal` now dates the read from `quoteTime`
   (falling back to `as_of` for feeds that do not carry one) and cuts its confidence as the read
   gets older; outside the NSE session the last close is treated as a settled prior, not current
   momentum. The score still reflects the last close, but a closed-market price read is capped at
   0.2 confidence, so it can no longer carry a call on its own. The +2.31% NIFTY figure above
   (Friday's session, read on Saturday) is now tagged `market closed: last close is not live`.
   Remaining caveat: news and flow components are still not aged - only the price leg is, which
   was the specific defect this note recorded.
2. **Yahoo is delayed and unofficial.** Roughly fifteen minutes intraday, no SLA, no key, and it
   could change or rate-limit without notice. It is a bootstrap feed, not the target state. Angel
   One remains the authoritative source and the watermark on the pills is there to keep that
   impossible to forget.
3. **No options data from Yahoo.** The fallback supplies spot only, so `price` is the only component
   it revives. Greeks, the option chain and OI still require Angel One and NSE.
4. **The `FINNIFTY` alias is unverified.** `^NSEI`, `^NSEBANK` and `^NSEMDCP50` were all exercised
   live in the run above (see `MIDCPNIFTY` = 16946.30). `^CNXFIN` is mapped because FINNIFTY is a
   known index name but it is not in the current universe, so it has not been probed. If any alias
   is wrong the failure is a clean per-symbol error in `sources_health`, not a wrong price.

## Environment

```
HARNESS_YAHOO_ENABLED=true
HARNESS_YAHOO_API_ROOT=https://query1.finance.yahoo.com
HARNESS_YAHOO_RANGE=1d
HARNESS_YAHOO_INTERVAL=1d
HARNESS_YAHOO_TIMEOUT_MS=15000
HARNESS_YAHOO_SPACING_MS=400
```

Requests are sequential with a 400 ms gap. There is no published quota, so the client does not
pretend to know one; it is simply polite, and the universe is small.
