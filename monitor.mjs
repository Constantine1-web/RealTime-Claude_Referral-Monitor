import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  extractReferrals,
  getTargetSources,
  getUserAgent,
  parseFeedResponse,
  TelegramNotifier as BaseTelegramNotifier,
} from "./lib/core.mjs";
import { isRedisConfigured, RedisStore } from "./lib/redis-store.mjs";

// ---------------------------------------------------------------------------
// 0. Zero-Dependency .env / .env.local Loader
// ---------------------------------------------------------------------------
function loadEnvFile(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) return;
  const content = fs.readFileSync(resolved, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

loadEnvFile(".env");
loadEnvFile(".env.local");

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_SECONDS || 15) * 1000;
const DB_PATH = (process.env.DB_PATH || "referrals.db").trim();

function log(level, msg, ...args) {
  const ts = new Date().toISOString();
  console.log(`${ts} | ${level.padEnd(7)} | referral-monitor | ${msg}`, ...args);
}

export { extractReferrals };

// ---------------------------------------------------------------------------
// 1. Local SQLite Atomic Deduplication Store
// ---------------------------------------------------------------------------
export class DeduplicationStore {
  constructor(dbPath = DB_PATH) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seen_referrals (
        code TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        url TEXT NOT NULL,
        source_permalink TEXT,
        discovered_at INTEGER NOT NULL
      )
    `);
    this.insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO seen_referrals (code, provider, url, source_permalink, discovered_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.countStmt = this.db.prepare("SELECT COUNT(*) AS total FROM seen_referrals");
  }

  isNewAndMark(item) {
    const result = this.insertStmt.run(
      item.code,
      item.provider,
      item.url,
      item.sourcePermalink,
      Math.floor(Date.now() / 1000)
    );
    return result.changes === 1;
  }

  count() {
    const row = this.countStmt.get();
    return row ? Number(row.total) : 0;
  }

  close() {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// 2. Telegram Notifier with Interactive CLI Auto-Chat Detection
// ---------------------------------------------------------------------------
export class TelegramNotifier extends BaseTelegramNotifier {
  async resolveChatIdIfNeeded(envFilePath = ".env") {
    if (!this.hasToken || this.chatId) return this.chatId;

    log(
      "INFO",
      "TELEGRAM_CHAT_ID is empty. Checking Telegram getUpdates for your latest message to the bot..."
    );
    try {
      const resp = await fetch(`${this.baseUrl}/getUpdates?limit=10`);
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data?.ok === false) {
        log(
          "ERROR",
          `Telegram API rejected the Bot Token (${resp.status}): ${data?.description || "Unauthorized"}.`
        );
        return "";
      }
      const results = Array.isArray(data?.result) ? data.result : [];
      for (let i = results.length - 1; i >= 0; i--) {
        const update = results[i];
        const chat =
          update?.message?.chat ||
          update?.channel_post?.chat ||
          update?.my_chat_member?.chat;
        if (chat?.id) {
          this.chatId = String(chat.id);
          log(
            "INFO",
            `Auto-detected TELEGRAM_CHAT_ID: ${this.chatId} (${chat.username || chat.title || chat.first_name || "Chat"})`
          );
          try {
            const resolved = path.resolve(process.cwd(), envFilePath);
            if (fs.existsSync(resolved)) {
              const envContent = fs.readFileSync(resolved, "utf8");
              const updated = envContent.replace(
                /^TELEGRAM_CHAT_ID=.*$/m,
                `TELEGRAM_CHAT_ID=${this.chatId}`
              );
              fs.writeFileSync(resolved, updated, "utf8");
              log("INFO", "Saved TELEGRAM_CHAT_ID to .env automatically.");
            }
          } catch {
            // Ignore file write errors
          }
          return this.chatId;
        }
      }
      log(
        "WARN",
        "No messages found yet! Open your bot in Telegram, press 'Start' (or send '/start'), and run again."
      );
    } catch (err) {
      log("WARN", `Failed to auto-detect TELEGRAM_CHAT_ID: ${err.message}`);
    }
    return "";
  }
}

// ---------------------------------------------------------------------------
// 3. Resilient Source Poller
// ---------------------------------------------------------------------------
class SourcePoller {
  constructor(url, store, notifier, baseIntervalMs = POLL_INTERVAL_MS) {
    this.url = url;
    this.activeUrl = url;
    this.store = store;
    this.notifier = notifier;
    this.baseIntervalMs = baseIntervalMs;
    this.etag = null;
    this.lastModified = null;
    this.consecutiveErrors = 0;
    this.userAgent = getUserAgent();
  }

  async pollOnce() {
    let sleepMs = this.baseIntervalMs;
    const headers = {
      "User-Agent": this.userAgent,
      Accept:
        "application/atom+xml,application/rss+xml,application/xml,application/json,text/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    };
    if (this.etag) headers["If-None-Match"] = this.etag;
    if (this.lastModified) headers["If-Modified-Since"] = this.lastModified;

    try {
      const resp = await fetch(this.activeUrl, { headers, redirect: "follow" });

      if (resp.status === 304) {
        this.consecutiveErrors = 0;
        log("INFO", `[304 Not Modified] ${this.activeUrl}`);
        return sleepMs;
      }

      if (resp.status === 200) {
        this.consecutiveErrors = 0;
        this.etag = resp.headers.get("etag");
        this.lastModified = resp.headers.get("last-modified");
        const matches = await parseFeedResponse(resp, this.activeUrl);
        log("INFO", `[200 OK] Polled ${this.activeUrl} (${matches.length} referral links scanned)`);

        for (const match of matches) {
          const isNew = await this.store.isNewAndMark(match);
          if (isNew) {
            log("INFO", `New referral discovered: [${match.provider}] ${match.url}`);
            await this.notifier.sendAlert(match, {
              info: (m) => log("INFO", m),
              warn: (m) => log("WARN", m),
              error: (m) => log("ERROR", m),
            });
          }
        }
        return sleepMs;
      }

      if (resp.status === 429) {
        const retryAfter = Number(resp.headers.get("retry-after") || 60);
        log("WARN", `429 Rate Limited on ${this.activeUrl}. Backing off ${retryAfter}s`);
        return retryAfter * 1000;
      }

      this.consecutiveErrors++;
      sleepMs = Math.min(300_000, this.baseIntervalMs * 2 ** this.consecutiveErrors);
      log("WARN", `Unexpected status ${resp.status} from ${this.activeUrl}. Backoff ${sleepMs / 1000}s`);
    } catch (err) {
      this.consecutiveErrors++;
      sleepMs = Math.min(300_000, this.baseIntervalMs * 2 ** this.consecutiveErrors);
      log("WARN", `Network error polling ${this.activeUrl}: ${err.message}`);
    }

    return sleepMs;
  }
}

// ---------------------------------------------------------------------------
// 4. Main CLI Runner
// ---------------------------------------------------------------------------
async function main() {
  const once = process.argv.includes("--once");
  const testTelegram = process.argv.includes("--test-telegram");

  const useRedis = isRedisConfigured() && !process.argv.includes("--sqlite-only");
  const store = useRedis ? new RedisStore() : new DeduplicationStore(DB_PATH);
  const notifier = new TelegramNotifier(
    (process.env.TELEGRAM_BOT_TOKEN || "").trim(),
    (process.env.TELEGRAM_CHAT_ID || "").trim()
  );

  await notifier.resolveChatIdIfNeeded();

  if (testTelegram) {
    if (!notifier.enabled) {
      log("ERROR", "Send '/start' to your bot on Telegram first, then re-run.");
      store.close?.();
      return;
    }
    log("INFO", `Sending test Telegram alert to chat_id=${notifier.chatId}...`);
    await notifier.sendAlert({
      provider: "Claude Referral / Trial (Test)",
      code: "test:sample",
      url: "https://claude.ai/referral/TEST_LINK_WORKING",
      sourceTitle: "Constantine 2.0 Bot Verification",
      sourcePermalink: "https://www.reddit.com/r/ClaudeAI/new",
    });
    store.close?.();
    return;
  }

  const sources = getTargetSources();
  const pollers = sources.map((url) => new SourcePoller(url, store, notifier));

  if (once) {
    log("INFO", `Running single-pass check across ${pollers.length} sources...`);
    await Promise.all(pollers.map((p) => p.pollOnce()));
    store.close?.();
    log("INFO", "Single-pass check complete.");
    return;
  }

  let running = true;
  const shutdown = () => {
    running = false;
    store.close?.();
    log("INFO", "Shutdown complete.");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log(
    "INFO",
    `Referral monitor started (${pollers.length} sources, store=${useRedis ? "Upstash Redis" : "SQLite"}).`
  );

  await Promise.all(
    pollers.map(async (poller) => {
      while (running) {
        const sleepMs = await poller.pollOnce();
        const jittered = sleepMs * (0.85 + Math.random() * 0.3);
        await new Promise((r) => setTimeout(r, jittered));
      }
    })
  );
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")).toLowerCase();

if (isMainModule) {
  main();
}
