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

```powershell
cd "C:\Users\Adari\OneDrive\Desktop\My Dashboard\TradingFactory"

# 1. install dashboard deps (once)
npm run web:install

# 2. apply the schema (creates households, profiles, sessions, time-series tables)
#    DATABASE_URL must be set in .env first
npm run harness:schema

# 3. create the first household login (prints a generated password if you omit one)
npm --prefix web run create-user -- --email you@example.com

# 4. start the dashboard
npm run web:dev          # http://localhost:3000
```

Then sign in, and add the rest of the family from **Settings**.

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
