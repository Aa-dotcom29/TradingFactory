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

This app needs a persistent Node service because it owns the Angel One WebSocket, scheduler, and market-history writes. `Dockerfile` and `railway.json` configure that runtime and an unauthenticated `/healthz` probe. Keep one replica for the single-workspace JSON journal. Attach a Railway volume at `/data` and set `DATA_DIR=/data`; otherwise local history is not durable across replacement deployments. Set `NODE_ENV=production`, a private `APP_PASSWORD`, and a unique `SESSION_SECRET` in Railway service Variables. For real data, set `ANGEL_CLIENT_ID`, `ANGEL_API_KEY`, `ANGEL_PASSWORD`, and `ANGEL_TOTP_SECRET` there as protected variables. Production disables mock market quotes, mock options, seeded news, and simulated signal/trade data. The server automatically logs in at startup and retries the read-only feed with backoff; users do not click a daily Connect button. Keep one replica and never commit `.env` or broker credentials. Set `SCHEDULER_ENABLED=true`. Railway supplies `PORT` automatically.

### Angel One read-only market feed

The app includes a server-side SmartAPI login and WebSocket feed for NIFTY 50, BANK NIFTY, and MIDCAP NIFTY index quotes. It also polls Angel One's FULL quote endpoint every 10 seconds for the nearest NIFTY index-option expiry and 11 strikes around ATM, showing call/put premiums, volume, and open interest. OI change is calculated only between this app's consecutive snapshots; it is not the exchange's day change. The option snapshot is not a streaming feed. Max pain, IV/Greeks, and validated signal rules are not provided by this integration. Configure the four `ANGEL_*` values once as protected Railway service variables: client ID, API key, SmartAPI login PIN/password, and the base32 TOTP secret (not a six-digit one-time code). The server then generates a fresh TOTP and reconnects automatically at startup or when the session/feed expires. Never paste credentials into the UI or chat. Credentials must be renewed if you rotate them or Angel One invalidates them.

The option endpoint is polled every 10 seconds during the scheduled NSE index-derivatives session (weekdays, 09:15â€“15:40 IST); polling and history writes are skipped outside that window. The UI distinguishes a fresh in-session response from a stale, pre-market, post-market, weekend, or mock snapshot. The schedule check does not load exchange holidays, so a weekday holiday is detected through missing/stale provider ticks rather than a holiday calendar. Each in-session batch is written as a timestamped historical observation: to `data/market-snapshots.ndjson` in local mode, or to the existing `market_snapshots` table when PostgreSQL is configured. The OI page shows saved records, supports paging to older samples, and reports the last 90 days; local records are append-only. Signal publication remains paused even after complete quote snapshots because strategy calculations and risk rules have not been calibrated and validated against historical broker data. News and theta/position monitoring remain mock or unavailable. Synthetic position marks are paused after an Angel One feed starts. No broker orders are placed. Live-feed behavior requires an Angel One account/API key and can only be fully verified against that account's credentials during an open market session.

The official Node SDK is intentionally not used; the app connects with a small WebSocket adapter. Keep `ws` updated and run the dependency audit when deploying.

## Useful endpoints

- `GET /api/status` â€” reports whether the current browser session is authenticated.
- `POST /api/login` â€” `{ "password": "..." }`.
- `POST /api/logout` â€” clears the session cookie.
- `GET /api/state` â€” dashboard state; requires login.
- `POST /api/scan` â€” reevaluates the mock strategy scores; requires login.
- `POST /api/publish` â€” `{ "strategy": "OI Options" }` or `Institutional Scanner`; requires login.
- `POST /api/monitor` â€” advances paper trades; requires login.
- `GET /api/health` â€” basic runtime/storage configuration check.

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

## Market intelligence harness (Slice 0)

A separate, staged autonomous pipeline is being built alongside this MVP under [`harness/`](./harness) (see [`docs/harness-architecture.md`](./docs/harness-architecture.md)). Slice 0 provides the backbone: a portable Postgres schema with monthly partitions, a 90-day retention floor and immutable/versioned signals; a dependency-free SQL queue; the W0 ingestion worker (Angel One batched quotes + option greeks, NSE OI-spurts volume flow, RSS news with rule-based entity/sentiment/severity scoring); and the W8 supervisor.

It is free/self-hosted first: run `docker compose up -d --build` on any always-on host (for example an Oracle Cloud Always Free VM) or use the `render.yaml` blueprint. Useful commands: `npm run harness:selfcheck`, `npm run harness:test`, `npm run harness:schema`, `npm run harness`. Credentials stay server-side; the rule engine is authoritative and any LLM enrichment is optional.

### Dashboard (Slice 1)

A separate multi-user dashboard lives in [`web/`](./web) as a Next.js 15 app (see [`docs/slice-1-dashboard.md`](./docs/slice-1-dashboard.md)). It provides real email/password logins against the harness `profiles`/`sessions` tables, a household where the owner can add family members, and three horizon tabs - Intraday, Swing and Positional - reading live from the same Postgres the harness writes to. It is installable as a PWA and works on any device.

```powershell
npm run web:install
npm run harness:schema                                   # DATABASE_URL required
npm --prefix web run create-user -- --email you@example.com
npm run web:dev                                          # http://localhost:3000
```

In production `docker compose up -d --build` also starts the dashboard on port 3000. See [`docs/oracle-deploy.md`](./docs/oracle-deploy.md) for the Always Free deployment - `scripts/oracle-deploy.sh` provisions the VM, reserves its public IP, opens the ports and bootstraps Docker, TLS and the stack in one command from Cloud Shell.

