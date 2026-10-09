# Trading Facrory Intelligence

Trading Facrory is being repurposed as a zero-trading market-intelligence workspace. It monitors selected public X accounts, ingests company filings and earnings documents, stores searchable source memory, creates research briefs, and can deliver those briefs to a Telegram channel.

There are no broker integrations, trading plugins, order routes, position screens, or simulated market quotes in this application. Briefs are research leads with source references, not buy/sell instructions.

## Run locally

Requires Node.js 20 or newer.

```powershell
npm install
Copy-Item .env.example .env
# Add a private APP_PASSWORD and SESSION_SECRET, then configure integrations as desired.
npm start
```

Open <http://localhost:4175>. The JSON store is written to `DATA_DIR/intelligence-store.json`; on Railway set `DATA_DIR=/data` to use the persistent volume.

## X / Twitter

Create an X developer app with OAuth 2.0 Authorization Code + PKCE enabled and request `users.read`, `tweet.read`, and `offline.access`. Set `X_CLIENT_ID`, `X_CLIENT_SECRET` when the app is confidential, and `X_CALLBACK_URL` to the exact deployed callback URL (`https://YOUR-APP.up.railway.app/auth/x/callback`). The user links their X account once in the Fintwit page. Add public usernames to the watchlist and scan their recent posts.

X API access and usage are subject to X's current access tier, rate limits, and billing. The app does not scrape browser sessions or store an X password.

## Documents and memory

PDF, TXT, Markdown, HTML, CSV, and XML documents up to 12 MB can be uploaded. Text is split into overlapping sections and saved with source metadata for keyword retrieval. The uploaded file itself is processed in memory and is not retained as a raw binary. The persistent memory index is in the JSON store on the Railway volume.

## AI research summaries

Set `AI_API_BASE`, `AI_API_KEY`, and `AI_MODEL` to an OpenAI-compatible chat-completions service to generate synthesized briefs with source markers, reported claims, research themes, risks, counter-evidence, and follow-up questions. With no model configured, the app creates a clearly labeled source excerpt digest instead. External posts and documents are treated as untrusted source text, not instructions to the agent.

## Telegram

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, then add the bot to the target channel with permission to post. The workspace can send a test message and generated research briefs. Messages are limited to research summaries; there is no trading or order tool available.

## Railway settings

Keep the existing persistent volume mounted at `/data` and set `DATA_DIR=/data`. Keep `APP_PASSWORD` and `SESSION_SECRET` as protected variables. Configure the X OAuth callback URL to the Railway domain, and add model and Telegram credentials only if those integrations are wanted. Remove the old `ANGEL_*` variables after the intelligence-only build has been deployed; this application does not read them.

## Routes

Authenticated routes cover X OAuth, watchlist management, post ingestion, document upload/removal, keyword memory search, briefing, and Telegram delivery. The only unauthenticated routes are the login/status endpoints, OAuth callback, static assets, and `/healthz`. There are no trade, broker, order, signal, paper-position, scanner, or market-data routes.
