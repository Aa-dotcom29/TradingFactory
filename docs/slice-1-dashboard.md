# Slice 1 - Multi-user dashboard (Next.js)

This slice adds the browser-and-device-independent dashboard: real logins, a household,
and the three horizon tabs, all reading live from the same Postgres the harness writes to.

## What shipped

| Area | Detail |
|---|---|
| Framework | Next.js 15 App Router (JavaScript), `web/` is its own npm project |
| Auth | Email + password against `profiles`; scrypt hashing (Node built-in, no native dep) |
| Sessions | Server-side `sessions` table; only a SHA-256 hash of the cookie token is stored |
| Routes | `/login`, `/dashboard` (overview), `/dashboard/intraday|swing|positional`, `/dashboard/settings` |
| Data | `news_items`, `oi_spurts`, `signals`, `sources_health` |
| Households | Owner can add members from Settings; everyone shares the dashboard |
| PWA | Web manifest + SVG icon; installable on phone and desktop |
| Encoding | All UI text and helpers are ASCII; formatters are covered by a mojibake test |

## Data flow

```
harness worker (W0)  ->  Postgres  ->  Next.js server components  ->  browser / PWA
                              ^
                              |
                        sessions / profiles  (auth)
```

The dashboard never talks to a broker. It only reads the tables the harness fills.

## Run it locally

Requirements: Node 20+ and a Postgres reachable via `DATABASE_URL`.

**Option A - a local Postgres with no admin rights and no Docker** (dev/verification only;
real Postgres 18 binaries managed by `embedded-postgres`, data kept in
`%LOCALAPPDATA%\tf-postgres` so OneDrive never syncs a live cluster):

```powershell
cd "C:\Users\Adari\OneDrive\Desktop\My Dashboard\TradingFactory"

copy .env.example .env            # then set DATABASE_URL (see below)
npm run web:install               # install dashboard deps (once)
npm run dev:db                    # leave running; prints the DATABASE_URL to use
```

In another terminal:

```powershell
# 2. apply the schema (creates households, profiles, sessions, time-series tables)
npm run harness:schema

# 3. create the first household login (prints a generated password if you omit one)
npm --prefix web run create-user -- --email you@example.com

# 4. start the dashboard
npm run web:dev          # http://localhost:3000
```

`npm run dev:db` prints the exact `DATABASE_URL` to paste into `.env`, for example
`postgres://tf:tf_local_password@localhost:5432/tradingfactory`. It initialises the
cluster as UTF-8 (Windows otherwise defaults to WIN1252, which cannot store a curly
quote or a rupee sign) and reuses the same data directory on later runs.

**Option B - Docker** (closest to production):

```powershell
docker compose up -d --build
docker compose run --rm web node scripts/create-user.js --email you@example.com
```

The dashboard reads `DATABASE_URL` from the repo-root `.env` (see `web/lib/env.js`), so a
single `.env` configures both the worker and the dashboard. Then sign in, and add the rest
of the family from **Settings**.

## How auth works

1. `POST /api/auth/login` looks up the profile, verifies the scrypt hash, and inserts a
   row into `sessions` with a hash of a random 32-byte token.
2. The raw token goes to the browser in an `HttpOnly`, `SameSite=Lax`, `Secure` (in
   production) cookie named `tf_session`.
3. `middleware.js` only checks that the cookie exists (edge runtime, no DB). The real
   verification happens in the dashboard layout, which joins `sessions -> profiles ->
   households` and redirects to `/login` when the session is missing or expired.
4. Signing out deletes the session row, so a stolen cookie is dead immediately.

Logout and revocation are a row delete. Expired sessions are simply not returned.

## Honest empty states

Slices 2-5 have not shipped, so:

- **Signals** render an explicit "no published signals" panel. Nothing is faked.
- **Flow** shows the real NSE OI-spurt snapshot the ingest worker stores.
- **News** shows real scored headlines once the news pipeline runs.

## Verification without a database

The server boots and every route behaves with `DATABASE_URL` unset:

| Request | Result |
|---|---|
| `GET /login` | `200`, renders the form and a "DATABASE_URL is not set" banner |
| `GET /` | `307` to `/dashboard` |
| `GET /dashboard` | `307` to `/login` (middleware) |
| `POST /api/auth/login` | `503 {"error":"Database is not configured."}` |
| `GET /manifest.webmanifest` | `200` |

## Verification against a real database

Run against a local Postgres 18 (UTF-8) with the harness ingest having populated the
tables in the same session:

| Check | Result |
|---|---|
| `npm run harness:schema` | applied, migrations `0001` + `0002` |
| `node harness/src/run.js --once` | 319 flow rows, 119 news items, 120 queue messages persisted |
| `POST /api/auth/login` (correct) | `200` + session cookie |
| `POST /api/auth/login` (wrong) | `401` |
| `GET /dashboard` unauthenticated | `307` to `/login` |
| `GET /dashboard` / `intraday` / `swing` / `positional` / `settings` | `200` |
| `GET /dashboard/nonsense` | `404` |
| Owner adds a member | `201`; duplicate `409`; short password `400`; no auth `401` |
| Member signs in independently | `200`, sees the same household dashboard |
| Logout, then `GET /dashboard` | `307` (session row deleted) |
| Rendered data | 92 news/24h, 319 flow rows, real headlines, NIFTY build-up quadrants, source health |

Unit tests (no DB required):

```powershell
npm run web:test     # password hashing, formatters, horizon metadata
npm run test:all     # harness tests + dashboard tests
```

## Files

```
web/
  app/
    layout.js, page.js, globals.css
    login/                    page + LoginForm (client)
    dashboard/
      layout.js               auth guard + shell
      page.js                 overview
      [horizon]/page.js       intraday | swing | positional
      settings/               members list + AddMemberForm (client)
    api/auth/login|logout/    route handlers
    api/members/              owner-only member creation
  components/                 NavTabs, LogoutButton, NewsList, FlowPanel, SignalList, HealthTable
  lib/                        db, auth, password, queries, format, horizons
  scripts/create-user.js      bootstrap the household owner
  middleware.js               cookie-presence gate
  Dockerfile                  multi-stage, standalone output, non-root
```

## Next

Slice 2 turns the raw rows into intelligence: the W1 news-scoring worker and the Flow
consumer that read the `news.raw` / `flow.snapshot` messages W0 already enqueues.
