# RealTime-Claude_Referral-Monitor

A real-time referral monitor & live web dashboard that scans Reddit RSS feeds, global Reddit search, and Hacker News for fresh referral links (Claude Pro trials, Anthropic invites, Perplexity, ChatGPT), deduplicates them atomically in **Upstash Redis** (on Vercel) or **SQLite WAL** (locally), and fires instant Telegram alerts with inline action buttons.

## Architecture

- **Web Dashboard ([public/index.html](public/index.html))**: Live status bar, KPI telemetry, provider filtering, **Scan Now** button, **Live Watch (30s)** auto-scanner, and **Test Telegram** button.
- **Vercel Functions ([api/](api/))**:
  - `GET /api/status` — Returns recent referrals, total count, and latest source telemetry from Upstash Redis.
  - `POST /api/scan` — Runs an on-demand scan across all sources (protected by a 15s Redis cooldown lock).
  - `POST /api/test-telegram` — Sends a test ping to Telegram (protected by a 60s Redis cooldown lock).
  - `POST /api/scheduled-scan` — Private **Vercel Schedules** target (`schedule/v1beta`, every 15 minutes on Hobby, idempotent via `executionId`).
- **Shared Core ([lib/core.mjs](lib/core.mjs), [lib/redis-store.mjs](lib/redis-store.mjs), [lib/scanner.mjs](lib/scanner.mjs))**: Regex extraction, entity decoding, Atom/RSS & JSON parsing, ETag/`Last-Modified` HTTP caching, and Telegram `MarkdownV2` inline buttons.
- **Local CLI Worker ([monitor.mjs](monitor.mjs))**: Continuous 15-second background polling locally (automatically syncs with Upstash Redis if `.env.local` is pulled, or falls back to local SQLite).

## Local Setup & Tests

```powershell
npm.cmd install
node --test test_monitor.mjs
```

Run locally with your `.env` / `.env.local`:

```powershell
# Verify Telegram delivery
node monitor.mjs --test-telegram

# Continuous local 15-second polling
node monitor.mjs
```

## Vercel Deployment

1. Link the project (`vercel link`) and provision Upstash Redis (`vercel install upstash/upstash-kv`).
2. Pull environment variables (`vercel env pull .env.local --yes`).
3. Deploy via Git push to `main` or `vercel --prod`.
