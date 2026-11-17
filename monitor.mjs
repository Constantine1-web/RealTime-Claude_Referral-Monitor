import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// 0. Zero-Dependency .env Loader
// ---------------------------------------------------------------------------
function loadDotEnv(envPath = ".env") {
  const resolved = path.resolve(process.cwd(), envPath);
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

loadDotEnv();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();
const REDDIT_CLIENT_ID = (process.env.REDDIT_CLIENT_ID || "").trim();
const REDDIT_CLIENT_SECRET = (process.env.REDDIT_CLIENT_SECRET || "").trim();
const USER_AGENT = (
  process.env.REDDIT_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
).trim();

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_SECONDS || 15) * 1000;
const DB_PATH = (process.env.DB_PATH || "referrals.db").trim();

const DEFAULT_SOURCES = [
  "https://old.reddit.com/r/ClaudeAI/new/.rss?limit=25",
  "https://old.reddit.com/r/ClaudeAI/comments/.rss?limit=50",
  "https://old.reddit.com/r/referrals/new/.rss?limit=25",
  "https://old.reddit.com/r/referralcodes/new/.rss?limit=25",
  "https://hn.algolia.com/api/v1/search_by_date?query=claude.ai%2Freferral%20OR%20claude.ai%2Finvite",
];

const SOURCES = process.env.TARGET_SOURCES
  ? process.env.TARGET_SOURCES.split(/\s*,\s*(?=https?:\/\/)/).map((s) => s.trim()).filter(Boolean)
  : DEFAULT_SOURCES;

function log(level, msg, ...args) {
  const ts = new Date().toISOString();
  console.log(`${ts} | ${level.padEnd(7)} | referral-monitor | ${msg}`, ...args);
}

// ---------------------------------------------------------------------------
// 1. Regex Extraction & Normalization Layer
// ---------------------------------------------------------------------------
export const PATTERNS = [
  {
    provider: "Claude Referral / Trial",
    regex: /https?:\/\/(?:www\.)?claude\.ai\/(?:referral|invite|r|claim)\/([A-Za-z0-9_-]{5,64})/gi,
    template: (code) => `https://claude.ai/referral/${code}`,
  },
  {
    provider: "Anthropic Invite",
    regex: /https?:\/\/(?:www\.)?anthropic\.com\/(?:invite|referral)\/([A-Za-z0-9_-]{5,64})/gi,
    template: (code) => `https://www.anthropic.com/invite/${code}`,
  },
  {
    provider: "Perplexity Pro Referral",
    regex: /https?:\/\/(?:www\.)?perplexity\.ai\/(?:referrals|pro)\/([A-Za-z0-9_-]{5,64})/gi,
    template: (code) => `https://www.perplexity.ai/referrals/${code}`,
  },
  {
    provider: "ChatGPT / OpenAI Invite",
    regex: /https?:\/\/(?:chat\.openai\.com|chatgpt\.com)\/(?:invite|r)\/([A-Za-z0-9_-]{5,64})/gi,
    template: (code) => `https://chatgpt.com/invite/${code}`,
  },
];

export function extractReferrals(text, title = "New Post", permalink = "") {
  if (!text) return [];
  const cleanText = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');

  const matches = [];
  const seenInBatch = new Set();

  for (const { provider, regex, template } of PATTERNS) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(cleanText)) !== null) {
      const rawCode = match[1];
      const dedupKey = `${provider}:${rawCode.toLowerCase()}`;
      if (seenInBatch.has(dedupKey)) continue;
      seenInBatch.add(dedupKey);

      const cleanUrl = template(rawCode);
      const shortTitle =
        title && title.length > 120 ? `${title.slice(0, 120)}...` : title || "Direct Post";

      matches.push({
        provider,
        code: dedupKey,
        url: cleanUrl,
        sourceTitle: shortTitle,
        sourcePermalink: permalink || cleanUrl,
      });
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// 2. SQLite Atomic Deduplication Store (Built-in node:sqlite)
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
// 3. Telegram Bot Notifier (with Inline Action Buttons)
// ---------------------------------------------------------------------------
export class TelegramNotifier {
  constructor(botToken, chatId) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.hasToken = Boolean(
      botToken && botToken !== "your_telegram_bot_token_here"
    );
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
    this.apiUrl = `${this.baseUrl}/sendMessage`;
  }

  get enabled() {
    return Boolean(this.hasToken && this.chatId);
  }

  async resolveChatIdIfNeeded(envFilePath = ".env") {
    if (!this.hasToken || this.chatId) return this.chatId;

    log("INFO", "TELEGRAM_CHAT_ID is empty. Checking Telegram getUpdates for your latest message to the bot...");
    try {
      const resp = await fetch(`${this.baseUrl}/getUpdates?limit=10`);
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data?.ok === false) {
        log(
          "ERROR",
          `Telegram API rejected the Bot Token (${resp.status}): ${data?.description || "Unauthorized"}. Double-check TELEGRAM_BOT_TOKEN in .env!`
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
          log("INFO", `Auto-detected TELEGRAM_CHAT_ID: ${this.chatId} (${chat.username || chat.title || chat.first_name || "Chat"})`);
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
      log("WARN", "No messages found yet! Open your bot in Telegram, press 'Start' (or send '/start'), and run again.");
    } catch (err) {
      log("WARN", `Failed to auto-detect TELEGRAM_CHAT_ID: ${err.message}`);
    }
    return "";
  }

  static escapeMd(text) {
    return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
  }

  async sendAlert(item) {
    if (!this.enabled) {
      log("INFO", `[DRY-RUN Alert] ${item.provider} -> ${item.url} (Source: ${item.sourcePermalink})`);
      return true;
    }

    const text =
      `⚡ *Fresh ${TelegramNotifier.escapeMd(item.provider)} Found\\!*\n\n` +
      `📌 *Context:* ${TelegramNotifier.escapeMd(item.sourceTitle)}\n` +
      `🔗 \`${TelegramNotifier.escapeMd(item.url)}\``;

    const payload = {
      chat_id: this.chatId,
      text,
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🚀 Claim Referral", url: item.url },
            { text: "💬 View Source", url: item.sourcePermalink },
          ],
        ],
      },
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await fetch(this.apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (resp.ok) {
          log("INFO", `Sent Telegram alert for ${item.url}`);
          return true;
        }
        if (resp.status === 429) {
          const body = await resp.json().catch(() => ({}));
          const retryAfter = Number(body?.parameters?.retry_after || 5);
          log("WARN", `Telegram rate limit hit. Sleeping ${retryAfter}s`);
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
        } else {
          const errText = await resp.text();
          log("ERROR", `Telegram API error (${resp.status}): ${errText}`);
          return false;
        }
      } catch (err) {
        log("WARN", `Telegram network error (attempt ${attempt + 1}): ${err.message}`);
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// 4. Resilient Source Poller
// ---------------------------------------------------------------------------
class SourcePoller {
  constructor(url, store, notifier, baseIntervalMs = POLL_INTERVAL_MS) {
    this.url = url;
    this.store = store;
    this.notifier = notifier;
    this.baseIntervalMs = baseIntervalMs;
    this.etag = null;
    this.lastModified = null;
    this.consecutiveErrors = 0;
  }

  static buildFallbackUrls(url) {
    const candidates = [url];
    if (url.includes("reddit.com")) {
      // If .json gets 403'd by Reddit WAF, automatically try old.reddit.com/.rss and old.reddit.com/.json
      const rssUrl = url
        .replace("https://www.reddit.com", "https://old.reddit.com")
        .replace(/\.json(\?|$)/, "/.rss$1");
      if (!candidates.includes(rssUrl)) candidates.push(rssUrl);

      const wwwRssUrl = url.replace(/\.json(\?|$)/, ".rss$1");
      if (!candidates.includes(wwwRssUrl)) candidates.push(wwwRssUrl);
    }
    return candidates;
  }

  async pollOnce() {
    let sleepMs = this.baseIntervalMs;
    const candidates = SourcePoller.buildFallbackUrls(this.activeUrl || this.url);

    for (const candidateUrl of candidates) {
      const headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/atom+xml,application/rss+xml,application/xml,application/json,text/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      };
      if (this.etag && candidateUrl === this.activeUrl) headers["If-None-Match"] = this.etag;
      if (this.lastModified && candidateUrl === this.activeUrl) {
        headers["If-Modified-Since"] = this.lastModified;
      }

      try {
        const resp = await fetch(candidateUrl, { headers, redirect: "follow" });

        if (resp.status === 304) {
          this.consecutiveErrors = 0;
          this.activeUrl = candidateUrl;
          log("INFO", `[304 Not Modified] ${candidateUrl} (no new posts yet)`);
          return sleepMs;
        }

        if (resp.status === 200) {
          this.consecutiveErrors = 0;
          this.activeUrl = candidateUrl;
          this.etag = resp.headers.get("etag");
          this.lastModified = resp.headers.get("last-modified");
          const foundCount = await this.parseResponse(resp, candidateUrl);
          log("INFO", `[200 OK] Polled ${candidateUrl} (${foundCount} referral links scanned)`);
          return sleepMs;
        }

        if (resp.status === 403 && candidates.indexOf(candidateUrl) < candidates.length - 1) {
          log("INFO", `403 on ${candidateUrl}, switching to fallback ${candidates[candidates.indexOf(candidateUrl) + 1]}...`);
          continue;
        }

        if (resp.status === 429) {
          const retryAfter = Number(resp.headers.get("retry-after") || 60);
          log("WARN", `429 Rate Limited on ${candidateUrl}. Backing off ${retryAfter}s`);
          return retryAfter * 1000;
        }

        this.consecutiveErrors++;
        sleepMs = Math.min(300_000, this.baseIntervalMs * 2 ** this.consecutiveErrors);
        log("WARN", `Unexpected status ${resp.status} from ${candidateUrl}. Backoff ${sleepMs / 1000}s`);
      } catch (err) {
        this.consecutiveErrors++;
        sleepMs = Math.min(300_000, this.baseIntervalMs * 2 ** this.consecutiveErrors);
        log("WARN", `Network error polling ${candidateUrl}: ${err.message}`);
      }
    }

    return sleepMs;
  }

  async parseResponse(resp, sourceUrl = this.url) {
    const contentType = resp.headers.get("content-type") || "";
    let matches = [];

    if (
      (contentType.includes("application/json") || sourceUrl.includes(".json")) &&
      !sourceUrl.includes(".rss")
    ) {
      const data = await resp.json().catch(() => null);
      if (data?.data?.children) {
        for (const child of data.data.children) {
          const post = child?.data || {};
          const title = post.title || post.link_title || "Reddit Post/Comment";
          const combined = [
            title,
            post.selftext || "",
            post.body || "",
            post.url_overridden_by_dest || post.url || "",
          ].join("\n");
          const permalink = post.permalink
            ? `https://www.reddit.com${post.permalink}`
            : sourceUrl;
          matches.push(...extractReferrals(combined, title, permalink));
        }
      } else if (Array.isArray(data?.hits)) {
        // Hacker News Algolia real-time search API
        for (const hit of data.hits) {
          const title = hit.title || hit.story_title || "HN Post/Comment";
          const text = [title, hit.url || "", hit.story_url || "", hit.comment_text || ""].join("\n");
          const permalink = `https://news.ycombinator.com/item?id=${hit.objectID}`;
          matches.push(...extractReferrals(text, title, permalink));
        }
      } else if (data) {
        matches.push(...extractReferrals(JSON.stringify(data), "JSON Feed", sourceUrl));
      }
    } else {
      // Atom / RSS XML or Web Feed
      const xml = await resp.text();
      const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
      let entryMatch;
      let parsedEntries = 0;
      while ((entryMatch = entryRegex.exec(xml)) !== null) {
        parsedEntries++;
        const block = entryMatch[1];
        const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const linkMatch = block.match(/<link[^>]*href=["']([^"']+)["']/i);
        const title = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "Reddit Feed Item";
        const permalink = linkMatch ? linkMatch[1] : sourceUrl;
        matches.push(...extractReferrals(block, title, permalink));
      }
      if (parsedEntries === 0) {
        matches.push(...extractReferrals(xml, "Web Feed", sourceUrl));
      }
    }

    for (const match of matches) {
      if (this.store.isNewAndMark(match)) {
        log("INFO", `New referral discovered: [${match.provider}] ${match.url}`);
        await this.notifier.sendAlert(match);
      }
    }
    return matches.length;
  }
}

// ---------------------------------------------------------------------------
// 5. Main Runner
// ---------------------------------------------------------------------------
async function main() {
  const once = process.argv.includes("--once");
  const testTelegram = process.argv.includes("--test-telegram");
  const store = new DeduplicationStore(DB_PATH);
  const notifier = new TelegramNotifier(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID);

  await notifier.resolveChatIdIfNeeded();

  if (testTelegram) {
    if (!notifier.enabled) {
      log("ERROR", "Cannot send test alert until TELEGRAM_CHAT_ID is detected. Send '/start' to your bot on Telegram first, then re-run!");
      store.close();
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
    store.close();
    return;
  }

  if (!notifier.enabled) {
    log("WARN", "TELEGRAM_CHAT_ID not yet detected. Send '/start' to your bot in Telegram so it can message you!");
  }

  const pollers = SOURCES.map((url) => new SourcePoller(url, store, notifier));

  if (once) {
    log("INFO", `Running single-pass check across ${pollers.length} sources...`);
    await Promise.all(pollers.map((p) => p.pollOnce()));
    store.close();
    log("INFO", "Single-pass check complete.");
    return;
  }

  let running = true;
  const shutdown = () => {
    running = false;
    store.close();
    log("INFO", "Shutdown complete.");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log("INFO", `Referral monitor started (${pollers.length} sources, ${store.count()} existing in DB).`);

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
