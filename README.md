# Trading Facrory

Paper-first market intelligence dashboard for Indian index and options workflows.

## Run locally

Requires Node.js 20 or newer. The local JSON mode runs on Node built-ins alone.

```powershell
node server.js
```

Open <http://localhost:4173>. The local demo password is `paper`.

Copy `.env.example` to `.env` to configure the server; `.env` is loaded locally and ignored by Git. Replace the demo `APP_PASSWORD` and `SESSION_SECRET` before sharing the app.

## What works in this MVP

- Password-gated dashboard with HttpOnly, same-site session cookie and logout endpoint.
- Seeded mock NIFTY, BANK NIFTY, MIDCAP NIFTY, option-chain/OI and news data. Every screen marks simulated data as MOCK / PAPER.
- Institutional and OI strategy views with server-side scan and publication endpoints.
- Risk checks for kill switch, minimum score, daily loss, position count, lot budget and minimum reward/risk.
- Immutable publication snapshots; UI refresh only reads stored state. Repeated setup publication is blocked within its 30-minute key window.
- Paper lifecycle monitor, theta estimate, target/stop/time-pass transitions, MFE/MAE and journal.
- Signal filters, performance summary, risk settings, health view and responsive dark dashboard.
- UTC timestamps stored server-side and formatted for Asia/Kolkata in the dashboard.
- Optional PostgreSQL/Supabase persistence through a server-side Postgres.js client; without `DATABASE_URL`, the local JSON paper journal remains available.
- Database-backed state is saved as a single-workspace JSONB journal row with compare-and-swap revisions to prevent multiple server instances from silently overwriting each other's updates. Run one app instance for this MVP. A PostgreSQL trigger prevents changing or deleting any previously published signal snapshot, even when lifecycle state changes.
- First startup with an empty database imports `data/store.json` when present, preserving the local MVP's stored signals and trades. The JSON file is retained as a local copy.
- PostgreSQL/Supabase schema and least-privilege browser role setup in `schema.sql`; app state tables use RLS and are not granted to browser-facing roles.
- Process scheduler runs the paper monitor every 60 seconds and reevaluates the mock scanner every 5 minutes by default. Configure intervals in `.env`; set `SCHEDULER_ENABLED=false` to disable. Because the scheduler is in-process, it runs while this Node process is online and stops when the process stops.

## Current persistence and production gap

By default, the running MVP writes to `data/store.json`. For PostgreSQL/Supabase, install the pinned driver with `npm install`, run `schema.sql` once in the database SQL editor, and set `DATABASE_URL` in `.env` to the server-only connection string from the Supabase Connect panel. Use a direct connection or session pooler for this long-running Node process; the driver disables prepared statements and requires TLS. The app will verify the schema and database at startup, then fail clearly if configuration is invalid. Do not place `DATABASE_URL` in frontend code or expose the local server to the public internet.

The PostgreSQL adapter stores this single-user MVP as one JSONB aggregate row to keep updates atomic. The normalized tables in `schema.sql` are foundations for a later multi-user migration and are not yet populated by this MVP. Supabase Auth, user ownership/RLS policies, and multi-user isolation remain unimplemented.

Manual background operations are also exposed as authenticated server endpoints. For production, run the app as a supervised, always-on worker and add deployment-specific job monitoring.

### Browser deployment on Railway

This app needs a persistent Node service because it owns the Angel One WebSocket, scheduler, and market-history writes. `Dockerfile` and `railway.json` configure that runtime and an unauthenticated `/healthz` probe. Keep one replica for the single-workspace JSON journal. Attach a Railway volume at `/data` and set `DATA_DIR=/data`; otherwise local history is not durable across replacement deployments. Set `NODE_ENV=production`, a private `APP_PASSWORD`, and a unique `SESSION_SECRET` in Railway service Variables. Add the four `ANGEL_*` values there only if you want the cloud instance to connect to Angel One; never commit `.env` or broker credentials. Set `SCHEDULER_ENABLED=true`. Railway supplies `PORT` automatically. The user must deploy this new app separately from the legacy AlphaScope Railway project.

### Angel One read-only market feed

The app includes an opt-in, server-side SmartAPI login and WebSocket feed for NIFTY 50, BANK NIFTY, and MIDCAP NIFTY index quotes. It also polls Angel One's FULL quote endpoint every 10 seconds for the nearest NIFTY index-option expiry and 11 strikes around ATM, showing call/put premiums, volume, and open interest. OI change is calculated only between this app's consecutive snapshots; it is not the exchange's day change. The option snapshot is not a streaming feed. Max pain, IV/Greeks, and validated signal rules are not provided by this integration. To configure it, copy `.env.example` to `.env`, fill `ANGEL_CLIENT_ID`, `ANGEL_API_KEY`, `ANGEL_PASSWORD` (your SmartAPI login PIN/password), and `ANGEL_TOTP_SECRET` (base32 secret, not a one-time code), restart the server, sign in, and use **Connect Angel One read-only feed**. The secret values remain server-side; never paste them into the UI or chat.

The option endpoint is polled every 10 seconds during the scheduled NSE index-derivatives session (weekdays, 09:15–15:40 IST); polling and history writes are skipped outside that window. The UI distinguishes a fresh in-session response from a stale, pre-market, post-market, weekend, or mock snapshot. The schedule check does not load exchange holidays, so a weekday holiday is detected through missing/stale provider ticks rather than a holiday calendar. Each in-session batch is written as a timestamped historical observation: to `data/market-snapshots.ndjson` in local mode, or to the existing `market_snapshots` table when PostgreSQL is configured. The OI page shows saved records, supports paging to older samples, and reports the last 90 days; local records are append-only. Signal publication remains paused even after complete quote snapshots because strategy calculations and risk rules have not been calibrated and validated against historical broker data. News and theta/position monitoring remain mock or unavailable. Synthetic position marks are paused after an Angel One feed starts. No broker orders are placed. Live-feed behavior requires an Angel One account/API key and can only be fully verified against that account's credentials during an open market session.

The official Node SDK is intentionally not used; the app connects with a small WebSocket adapter. Keep `ws` updated and run the dependency audit when deploying.

## Useful endpoints

- `GET /api/status` — reports whether the current browser session is authenticated.
- `POST /api/login` — `{ "password": "..." }`.
- `POST /api/logout` — clears the session cookie.
- `GET /api/state` — dashboard state; requires login.
- `POST /api/scan` — reevaluates the mock strategy scores; requires login.
- `POST /api/publish` — `{ "strategy": "OI Options" }` or `Institutional Scanner`; requires login.
- `POST /api/monitor` — advances paper trades; requires login.
- `GET /api/health` — basic runtime/storage configuration check.

## Supabase setup

1. In the Supabase project, open **SQL Editor** and run [`schema.sql`](./schema.sql).
2. Copy the project connection string from **Connect** using a direct database connection or Session pooler.
3. Set it as `DATABASE_URL` in `.env`; keep it server-only.
4. Start the server. Health reports PostgreSQL mode after the schema and connection checks pass.

Supabase currently defaults new public tables to not being exposed through its Data API, with that behavior scheduled to be enforced on existing projects on 2026-10-30. The migration also enables RLS and removes browser-role grants for Trading Facrory tables, so this app uses only its trusted server connection. See [Supabase connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres) and the [Data API exposure change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically).

## Verification performed

- `node --check server.js` and `node --check public/app.js`.
- HTTP smoke check: login, dashboard load, seeded signals and scans, monitor endpoint, duplicate publication prevention, and immutable-snapshot comparison.
- Restart smoke check: the server reloaded the same journal state after a process restart.
- Scheduler check: monitor timestamp advanced between API reads with no intervening browser request; default monitor/scan intervals display as 60s / 300s.
- Visual browser check: overview and OI pages rendered with seeded values and no blank screen.
- PostgreSQL driver and lockfile verified; live database connection test requires a configured project `DATABASE_URL`.

This is a runnable MVP, not the complete production trading platform described in the referenced specification. Real data quality, calibrated strategy math, multi-user authorization, production-grade scheduler supervision, historical retention policy, chart/PDF export, and broker/news/Telegram adapters still need implementation before production or trading use.
