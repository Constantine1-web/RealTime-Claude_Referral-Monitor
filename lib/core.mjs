export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const DEFAULT_SOURCES = [
  "https://old.reddit.com/r/ClaudeAI/new/.rss?limit=25",
  "https://old.reddit.com/r/ClaudeAI/comments/.rss?limit=50",
  "https://old.reddit.com/r/referrals/new/.rss?limit=25",
  "https://old.reddit.com/r/referralcodes/new/.rss?limit=25",
  "https://old.reddit.com/search.rss?q=claude.ai%2Freferral&sort=new&t=week",
  "https://hn.algolia.com/api/v1/search_by_date?query=claude.ai/referral&hitsPerPage=25",
];

export const PATTERNS = [
  {
    provider: "Claude Referral / Trial",
    regex: /https?:\/\/(?:www\.)?claude\.ai\/(referral|guest-pass|invite|r|claim)\/([A-Za-z0-9_-]{5,64})/gi,
    template: (code, pathSeg = "referral") =>
      `https://claude.ai/${pathSeg.toLowerCase() === "guest-pass" ? "guest-pass" : "referral"}/${code}`,
  },
  {
    provider: "Anthropic Invite",
    regex: /https?:\/\/(?:www\.)?anthropic\.com\/(invite|referral)\/([A-Za-z0-9_-]{5,64})/gi,
    template: (code) => `https://www.anthropic.com/invite/${code}`,
  },
  {
    provider: "Perplexity Pro Referral",
    regex: /https?:\/\/(?:www\.)?perplexity\.ai\/(referrals|pro)\/([A-Za-z0-9_-]{5,64})/gi,
    template: (code) => `https://www.perplexity.ai/referrals/${code}`,
  },
  {
    provider: "ChatGPT / OpenAI Invite",
    regex: /https?:\/\/(?:chat\.openai\.com|chatgpt\.com)\/(invite|r)\/([A-Za-z0-9_-]{5,64})/gi,
    template: (code) => `https://chatgpt.com/invite/${code}`,
  },
];

export function getTargetSources(raw = process.env.TARGET_SOURCES) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return [...DEFAULT_SOURCES];
  return trimmed
    .split(/\s*,\s*(?=https?:\/\/)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getUserAgent() {
  return (process.env.REDDIT_USER_AGENT || DEFAULT_USER_AGENT).trim();
}

export function decodeHtmlEntities(text) {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/gi, "/");
}

export function getMaxPostAgeHours(raw = process.env.MAX_POST_AGE_HOURS) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 48;
}

function toIso(value) {
  if (value === undefined || value === null || value === "") return null;
  const d = typeof value === "number" ? new Date(value < 1e12 ? value * 1000 : value) : new Date(String(value).trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Age in hours of a post, or null when the post date is unknown. */
export function postAgeHours(postedAt, now = Date.now()) {
  if (!postedAt) return null;
  const t = new Date(postedAt).getTime();
  return Number.isNaN(t) ? null : Math.max(0, (now - t) / 3_600_000);
}

export function isFresh(item, maxHours = getMaxPostAgeHours(), now = Date.now()) {
  const age = postAgeHours(item.postedAt, now);
  return age === null || age <= maxHours; // unknown date => allow (live feeds are newest-first)
}

export function formatAge(postedAt, now = Date.now()) {
  const h = postAgeHours(postedAt, now);
  if (h === null) return "⚪ Post date unknown";
  const mins = Math.round(h * 60);
  const label = mins < 60 ? `${mins} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`;
  if (h <= 2) return `🟢 Posted ${label} ago (Fresh!)`;
  if (h <= 24) return `🟡 Posted ${label} ago`;
  return `⚠️ Posted ${label} ago (Likely expired)`;
}

export function extractReferrals(text, title = "New Post", permalink = "", postedAt = null) {
  if (!text) return [];
  const cleanText = decodeHtmlEntities(text);
  const matches = [];
  const seenInBatch = new Set();

  for (const { provider, regex, template } of PATTERNS) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(cleanText)) !== null) {
      const pathSeg = match[1];
      const rawCode = match[2];
      const dedupKey = `${provider}:${rawCode.toLowerCase()}`;
      if (seenInBatch.has(dedupKey)) continue;
      seenInBatch.add(dedupKey);

      const cleanUrl = template(rawCode, pathSeg);
      const cleanTitle = decodeHtmlEntities(title || "Direct Post")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
      const shortTitle =
        cleanTitle.length > 120 ? `${cleanTitle.slice(0, 120)}...` : cleanTitle || "Direct Post";

      matches.push({
        provider,
        code: dedupKey,
        url: cleanUrl,
        sourceTitle: shortTitle,
        sourcePermalink: permalink || cleanUrl,
        discoveredAt: new Date().toISOString(),
        postedAt: toIso(postedAt),
      });
    }
  }
  return matches;
}

export async function parseFeedResponse(resp, sourceUrl) {
  const contentType = resp.headers.get("content-type") || "";
  const matches = [];

  if (
    (contentType.includes("application/json") || sourceUrl.includes(".json") || sourceUrl.includes("algolia.com")) &&
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
        matches.push(...extractReferrals(combined, title, permalink, post.created_utc));
      }
    } else if (Array.isArray(data?.hits)) {
      for (const hit of data.hits) {
        const title = hit.title || hit.story_title || "HN Post/Comment";
        const text = [title, hit.url || "", hit.story_url || "", hit.comment_text || ""].join("\n");
        const permalink = `https://news.ycombinator.com/item?id=${hit.objectID}`;
        matches.push(...extractReferrals(text, title, permalink, hit.created_at_i ?? hit.created_at));
      }
    } else if (data) {
      matches.push(...extractReferrals(JSON.stringify(data), "JSON Feed", sourceUrl));
    }
    return matches;
  }

  // Atom (<entry>) or RSS (<item>) XML or plain web feed
  const xml = await resp.text();
  const entryRegex = /<(?:entry|item)\b[^>]*>([\s\S]*?)<\/(?:entry|item)>/gi;
  let entryMatch;
  let parsedEntries = 0;

  while ((entryMatch = entryRegex.exec(xml)) !== null) {
    parsedEntries++;
    const block = entryMatch[1];
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const linkHrefMatch = block.match(/<link[^>]*href=["']([^"']+)["']/i);
    const linkTagMatch = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    const title = titleMatch
      ? titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim()
      : "Feed Item";
    const permalink = (linkHrefMatch?.[1] || linkTagMatch?.[1] || sourceUrl).trim();
    const dateMatch = block.match(/<(published|updated|pubDate|dc:date)[^>]*>([\s\S]*?)<\/\1>/i);
    matches.push(...extractReferrals(block, title, permalink, dateMatch?.[2]));
  }

  if (parsedEntries === 0) {
    matches.push(...extractReferrals(xml, "Web Feed", sourceUrl));
  }

  return matches;
}

export class TelegramNotifier {
  constructor(
    botToken = (process.env.TELEGRAM_BOT_TOKEN || "").trim(),
    chatId = (process.env.TELEGRAM_CHAT_ID || "").trim()
  ) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.hasToken = Boolean(botToken && botToken !== "your_telegram_bot_token_here");
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
    this.apiUrl = `${this.baseUrl}/sendMessage`;
  }

  get enabled() {
    return Boolean(this.hasToken && this.chatId);
  }

  static escapeMd(text) {
    return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
  }

  async sendAlert(item, logger = console) {
    if (!this.enabled) {
      logger.info?.(`[DRY-RUN Alert] ${item.provider} -> ${item.url} (${item.sourcePermalink})`);
      return { ok: true, dryRun: true };
    }

    const text =
      `⚡ *Fresh ${TelegramNotifier.escapeMd(item.provider)} Found\\!*\n\n` +
      `📌 *Context:* ${TelegramNotifier.escapeMd(item.sourceTitle)}\n` +
      `⏱ ${TelegramNotifier.escapeMd(formatAge(item.postedAt))}\n` +
      `💡 _Open in an incognito window with a new account_\n` +
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
          return { ok: true };
        }
        if (resp.status === 429) {
          const body = await resp.json().catch(() => ({}));
          const retryAfter = Number(body?.parameters?.retry_after || 5);
          logger.warn?.(`Telegram rate limit hit. Sleeping ${retryAfter}s`);
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
        } else {
          const errText = await resp.text();
          logger.error?.(`Telegram API error (${resp.status}): ${errText}`);
          return { ok: false, status: resp.status, error: errText };
        }
      } catch (err) {
        logger.warn?.(`Telegram network error (attempt ${attempt + 1}): ${err.message}`);
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    return { ok: false, error: "Retries exhausted" };
  }
}
