# RealTime-Claude_Referral-Monitor

A resilient background referral monitor that polls public sources (Reddit Atom RSS/JSON feeds and Hacker News real-time search API) for fresh referral links (Claude Pro trials, Anthropic invites, Perplexity, ChatGPT), deduplicates them atomically in SQLite WAL, and pushes instant alerts with inline action buttons via a Telegram Bot.

Includes both a **zero-dependency Node.js (>= 22.5 / 24 LTS) implementation** (`monitor.mjs`) and an **async Python implementation** (`monitor.py`).

## Features

- **Rate-Limit Resilient Polling (`SourcePoller`):**
  - Uses `ETag` (`If-None-Match`) and `Last-Modified` (`If-Modified-Since`) headers so unchanged feeds return `304 Not Modified`.
  - Respects `x-ratelimit-remaining`, `x-ratelimit-reset`, and `Retry-After` headers with jittered exponential backoff.
  - Supports automatic fallback from `.json` to `old.reddit.com/.rss` Atom feeds + Hacker News Algolia real-time search.
- **Regex Extraction & Normalization (`extractReferrals`):**
  - Unescapes HTML entities and normalizes varied invite URLs (`claude.ai/referral/...`, `claude.ai/invite/...`) into canonical keys so the same referral is never sent twice.
- **Atomic SQLite Deduplication (`DeduplicationStore`):**
  - Uses SQLite in `WAL` mode (`node:sqlite` in Node.js / `sqlite3` in Python) with `INSERT OR IGNORE` to guarantee atomic deduplication.
- **Instant Telegram Alerts (`TelegramNotifier`):**
  - Sends `MarkdownV2`-formatted alerts with **Inline Keyboard Buttons** (`🚀 Claim Referral` and `💬 View Source`) and automatic `chat_id` detection (`--test-telegram`).

## Quick Start (Node.js — Zero Dependencies)

Requires **Node.js 22.5+** (built & tested on Node.js 24 LTS).

```powershell
# 1. Run unit tests
node --test test_monitor.mjs

# 2. Configure environment variables
Copy-Item .env.example .env
# Edit .env with your TELEGRAM_BOT_TOKEN

# 3. Auto-detect TELEGRAM_CHAT_ID & verify Telegram delivery
node monitor.mjs --test-telegram

# 4. Run continuous monitoring
node monitor.mjs
```

## Quick Start (Python)

```powershell
pip install -r requirements.txt
Copy-Item .env.example .env
python -m unittest test_monitor.py -v
python monitor.py
```
