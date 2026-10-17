# Angel One onboarding

The harness prefers Angel One for live quotes because it is the only source that is authoritative,
real-time, and (unlike Yahoo) not delayed. Until it is configured, W0 falls back to Yahoo and every
price row is tagged `yahoo-delayed`. This is the switch-over checklist.

Nothing here can be validated without your account; `npm run harness:angel-check` is the script that
tells you whether it worked, and it never prints a secret.

## What you need

| Value | Where it comes from |
| --- | --- |
| `ANGEL_API_KEY` | the SmartAPI app you create at https://smartapi.angelone.in |
| `ANGEL_CLIENT_ID` | your Angel One login id (client code), e.g. `A123456` |
| `ANGEL_PASSWORD` | your Angel One login PIN / password |
| `ANGEL_TOTP_SECRET` | the **base32 secret** from TOTP setup - *not* the six-digit code |

## Steps

1. **Create a SmartAPI app.** Log in to https://smartapi.angelone.in, create an app, and copy the
   API key. The app is free.
2. **Enable TOTP (2FA).** In the Angel One account settings, enable TOTP, and capture the base32
   secret shown when you set up the authenticator. That string is `ANGEL_TOTP_SECRET`. Some
   authenticator apps show the secret only once - save it somewhere safe.
3. **Register the calling public IP.** SmartAPI requires the public IP that calls the API to be
   listed as the app's primary IP. **This is the step that most often fails.** A home broadband IP
   is usually dynamic and will change, so the correct answer for a 24/7 deployment is to run the
   harness on the host (the Oracle Always Free VM) and register *that host's* static public IP.
4. **Fill in `.env`** with the four values (never commit them; `.env` is git-ignored).
5. **Run the preflight:**
   ```
   npm run harness:angel-check
   ```
   It checks, in order: values present -> login + TOTP -> instrument master -> a FULL quote (and
   whether the exchange timestamp the bias meter ages on is present) -> an option premium for the
   at-the-money contract -> option greeks. Each step prints PASS/FAIL, so a failure names its cause.
   The option-quote and greeks steps are best effort: Angel often answers "No Data Available" outside
   market hours, which is reported as a note, not a failure.
6. **Flip the feed on.** With the check passing, run the pipeline normally. W0 will now prefer
   Angel One; `sources_health` shows `angel HEALTHY ... quotes` in place of the Yahoo row.

## What Angel One unlocks

- **Live quotes** tagged `angel-live` with the exchange's own `exchFeedTime`, so the bias meter's
  price component ages a real-time read exactly (see `evidence-ageing.md`).
- **The option chain and Greeks** (`optionGreek`), which Yahoo cannot provide at all.
- **Option-premium history** for held positions: W0 resolves each open option plan to its NFO
  contract and stores that premium under `option.quote.v1`, so the evaluator (W7) can score an
  option-premium position on the instrument it actually trades. See `docs/slice-8-option-quotes.md`.

## Rate limits to keep in mind

- Market quote: up to 50 tokens per request, ~10 requests/second.
- Historical candles: ~3/second.
- Order APIs: ~9/second, shared.

The harness caps itself at `ANGEL_MAX_PER_SECOND` (default 2) so it stays well inside the quote
limit while polling the index universe.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| login FAIL | wrong client code / PIN, or a TOTP secret whose clock has drifted (TOTP is time-based) |
| login FAIL mentioning IP | the calling public IP is not the primary IP registered on the app |
| instrument master FAIL | the scrip-master download was blocked or timed out |
| quote FAIL "Invalid Token" | the instrument master changed; re-run the check on a later build |
| quote rows but no timestamp | Angel omitted `exchFeedTime`; the meter falls back to capture time |
| greeks note "No Data Available" | usually just out of hours; Angel serves greeks around market hours |
| greeks FAIL "Invalid expiry date" | the expiry was sent as ISO; `optionGreek` wants `DDMMMYYYY` (the client converts) |
| option quote note "no at-the-money CE contract resolved" | the master had no matching contract for that expiry; re-run after the master refreshes |

Note that `optionGreek` is the one Angel route that does **not** take an ISO date: it wants
`25JAN2024`-style `DDMMMYYYY`. The instrument master hands the harness ISO, so `optionGreeks` is
called with ISO and `toAngelExpiry` converts it at the client boundary.

The login session is valid until midnight; the client re-authenticates on demand, so a run that
straddles midnight simply logs in again.

## Honest limitations

- **Option premiums are polled only for positions the harness actually holds.** W0 resolves each open
  option position to its NFO contract and stores that premium under `option.quote.v1`, keyed by the
  contract. There is no full-chain feed, by design: polling the whole chain would be an unbounded cost
  for data nothing reads. The consequence is that an option position is scored only from the first
  poll after it is published, and a contract that cannot be resolved against the daily master is
  reported as unresolved rather than priced against the wrong instrument.
- **The scrip master stores option strikes multiplied by 100** (`2030000` for the 20300 strike) and
  expiries as `DDMMMYYYY`. Both are undone in `harness/src/contract.js`, which is the single place the
  broker's conventions are translated - verified against a live master, not assumed.
- **The static IP is a real constraint.** A residential connection without a static IP will work
  intermittently and then break when the IP rotates. The 24/7 host is the fix.
