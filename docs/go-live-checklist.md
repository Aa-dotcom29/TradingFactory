# Go-live checklist

The harness is built end to end (slices 0-7). This is the ordered runbook for switching it from
"writes a ledger nobody receives" to "sends real alerts to the household". It is written so that
every step is checkable, and so that nothing sends until you say so.

Three things can only come from you: Angel One credentials, a Telegram bot, and a hosting account.
Everything else is done.

## What is already true

- Publishing is **shadow-first**. `PUBLISH_MODE` defaults to `shadow`: the exact message is composed
  and the immutable `signals` row is written, but nothing leaves the machine. Only the exact string
  `live` sends.
- The risk gate is **fail-closed** and market-hours enforced (09:15-15:30 IST, weekdays). An approval
  that leaned on a switched-off control now says so in its stored reasons.
- Delivery can be enabled **one horizon at a time** (`PUBLISH_MODE_SWING=live`), so Intraday - where
  a late or wrong alert costs the most - can be turned on last.
- The daily-loss window is the **IST trading day**, not the UTC day.

---

## Phase 0 - inputs only you can supply

| Need | Env | Where to get it |
| --- | --- | --- |
| Angel One SmartAPI | `ANGEL_CLIENT_ID`, `ANGEL_API_KEY`, `ANGEL_PASSWORD`, `ANGEL_TOTP_SECRET` | https://smartapi.angelone.in - see [`angel-one-onboarding.md`](./angel-one-onboarding.md) |
| Telegram bot | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | below |
| Hosting | - | Oracle Always Free - see [`oracle-deploy.md`](./oracle-deploy.md) |

### Telegram, exactly

1. In Telegram, talk to **@BotFather** -> `/newbot` -> give it a name and a username. Copy the token
   it returns into `TELEGRAM_BOT_TOKEN`.
2. Send any message to your new bot from the account (or the group) that should receive signals.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and read
   `result[0].message.chat.id`. That number is `TELEGRAM_CHAT_ID`. For a group it is negative - add
   the bot to the group first, then send a message in the group.

Nothing secret should ever be pasted into the dashboard or committed. `.env` is git-ignored.

---

## Phase A - verify the feeds (no market session required)

1. `npm run harness:angel-check` must end with `Angel One is ready.` It checks credentials, login +
   TOTP, the instrument master, a FULL quote (and whether the exchange timestamp is present), an
   at-the-money option premium and option greeks, printing PASS/FAIL for each.
2. Apply the schema, so a database upgraded from an earlier build picks up the latest migration
   (`npm run harness:schema`). A running deployment must do this once per upgrade; it is idempotent.
3. After a cycle, `sources_health` should show `angel HEALTHY` in place of the Yahoo row, and price
   features should carry the `angel-live` provenance rather than `yahoo-delayed`.
4. `npm run harness:telegram-check` sends one clearly-labelled test message to the configured chat.
   It forces live mode for the test, so it works while `PUBLISH_MODE` is still `shadow`, and it
   validates the bot token first - a bad token fails without sending anything. Use
   `--no-send` to check the token alone. Do this before go-live day: an alert channel that has never
   carried a message is not a verified alert channel.

If the check fails on login, the usual causes are the wrong client code / PIN, a TOTP secret whose
clock has drifted, or an unregistered public IP - SmartAPI requires the calling IP to be the app's
registered primary IP. That is why the 24/7 host should call the API, not a home connection.

---

## Phase B - clear the development ledger

Signals raised while building the pipeline are still in the ledger, and a published signal counts as
an open position for a whole holding window (see [`risk-decision-trace.md`](./risk-decision-trace.md)).
Clear them once, before the first live signal, so exposure and the evaluator start honest.

```bash
npm run harness:reset-ledger            # counts only, changes nothing
npm run harness:reset-ledger -- --yes   # clears signals, candidates, stages, decisions, outcomes, queue
```

The `--` is not optional. npm treats a bare `--yes` as its own flag and swallows it, so
`npm run harness:reset-ledger --yes` prints the count and exits **without clearing anything** -
which looks exactly like a successful reset. The script also runs directly, with no npm in the
way: `node harness/scripts/reset-ledger.js --yes`.

It leaves `config_registry` (the approved limits), `sources_health` and every evidence table
(news, snapshots, OI spurts, features, bias) untouched.

---

## Phase C - harden access

1. `AUTH_DISABLED=false`. It is `true` in local development only, and the code refuses it under
   `NODE_ENV=production`, but confirm it is not set anywhere it should not be.
2. Run with `NODE_ENV=production`, behind TLS. The session cookie is `Secure` in production, so
   plain HTTP means the browser silently refuses to send it. See `oracle-deploy.md` section 8.
3. Rotate the bootstrap logins. The development accounts (`owner@tradingfactory.test`,
   `spouse@tradingfactory.test`) were seeded with passwords that are written down in plain text -
   change or recreate them before the dashboard is reachable from anywhere but the LAN.
4. `SESSION_SECRET` / `APP_PASSWORD` (the legacy app) should be long and unique to the host.

---

## Phase D - flip delivery, one horizon at a time

Start every horizon in shadow and watch one full session first. Then, per horizon:

```bash
PUBLISH_MODE_POSITIONAL=live   # slowest-moving, least time-critical
PUBLISH_MODE_SWING=live
PUBLISH_MODE_INTRADAY=live     # last
```

A per-horizon value wins over `PUBLISH_MODE`. Restart the worker after changing it.

What good looks like after the flip:

- `signal_events` gains a `DELIVERED` row (not `SHADOWED`) for each new signal, and the Telegram
  message arrives.
- `signals.snapshot.mode` reads `live` for that horizon and stays `shadow` for the others.
- The dashboard rail shows `live delivery` (or `mixed delivery` while some horizons are still shadow).

If a delivery fails, the event is `DELIVERY_FAILED`, the publisher records a `WARNING` in
`sources_health`, and the message is nacked for retry - it is not silently dropped.

---

## Phase E - what to watch

- `sources_health` - one row per feed. `angel` should be HEALTHY; a dead source is recorded, never
  fatal, and the pipeline falls back to Yahoo for prices.
- The supervisor's `feed` state. Out of hours it reads `CLOSED`, and that is correct: the market
  cannot produce a reading, so the quote, option-premium and OI-spurt polls all skip themselves
  (`skipped: market-closed` in the cycle log) and the last in-session reading stands as the last
  known price. `STALE` is the one that matters, and it only means something **while the NSE is
  trading**. A `STALE` on an NSE holiday is expected - public holidays are not modelled - so check
  the calendar before treating it as a broken feed.
- `risk_decisions` - why anything was approved, rejected or deferred, gate by gate. A `DEFERRED` after
  hours is correct, not a fault.
- The evaluator's `sources_health` row - `N closed of M open`. An option-premium position is scored
  against its own premium history (`option.quote.v1`); one whose premium history does not exist yet
  waits as `awaiting a price source` until its holding window runs out, then settles as
  `NO_PRICE_SOURCE` rather than staying open.
- Dashboard -> proposals - the evaluator's one-knob learning suggestions appear as `candidate` rows
  and are inert until you approve them with `npm run harness:config -- --approve=<version>`.

---

## Guardrail, not optional

**Execution is always manual. This system never places an order.** It is decision support: it can be
wrong, and a signal is an idea to review, not an instruction. No route in the app can send an order to
any broker, by design.

---

## Known limitations at go-live (honest list)

- **Option positions are scored from the first premium poll after publication.** Golden days of option
  quote history do not exist; there is nothing to backfill, because the readings were never taken. A
  position opened before Slice 8 has no premium path and settles as `NO_PRICE_SOURCE`, exactly as
  before. Spot/futures plans are scored normally.
- **A position with no price path is never settled.** The evaluator waits for evidence rather than
  inventing an exit.
- **Public holidays are not modelled.** A weekday holiday simply yields no fresh evidence, so no
  candidate is raised - but the session clock itself does not know about it.
- **Evidence-ageing windows are per component, not per horizon** (see `evidence-ageing.md`).
- **`bars_held` counts readings, not exchange bars**; `payload.heldMinutes` carries the real duration.
- **The mobile layout is verified by viewport width, not on a physical device.** Every route now has\n  zero page-level horizontal overflow at 360, 390, 414, 768, 1024 and 1280px, and the wide tables\n  scroll inside their own cards. A real-device pass (touch targets, iOS Safari chrome) is still worth\n  doing - see [`mobile-layout.md`](./mobile-layout.md).

## Hosting status

Oracle Cloud A1.Flex creation is currently blocked by capacity in the Hyderabad AD
("Out of capacity for shape VM.Standard.A1.Flex ... AD-1"). Options, in order of preference: retry
off-peak, request a smaller shape (1 OCPU / 6 GB is enough to start), or upgrade the tenancy to
Pay-As-You-Go so the Always Free allowance is guaranteed rather than wait-listed.
