import asyncio
import html
import logging
import os
import random
import re
import signal
import sqlite3
import sys
import time
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import httpx
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration & Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
)
logger = logging.getLogger("referral-monitor")

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "").strip()

REDDIT_CLIENT_ID = os.getenv("REDDIT_CLIENT_ID", "").strip()
REDDIT_CLIENT_SECRET = os.getenv("REDDIT_CLIENT_SECRET", "").strip()
USER_AGENT = os.getenv(
    "REDDIT_USER_AGENT",
    "python:constantine-referral-monitor:v2.0 (by /u/constantine_monitor)",
).strip()

POLL_INTERVAL = float(os.getenv("POLL_INTERVAL_SECONDS", "15"))
DB_PATH = os.getenv("DB_PATH", "referrals.db").strip()

DEFAULT_SOURCES = [
    "https://www.reddit.com/r/ClaudeAI/new.json?limit=25",
    "https://www.reddit.com/r/ClaudeAI/comments.json?limit=50",
    "https://www.reddit.com/r/referrals/new.json?limit=25",
]

raw_sources = os.getenv("TARGET_SOURCES", "").strip()
SOURCES = (
    [s.strip() for s in raw_sources.split(",") if s.strip()]
    if raw_sources
    else DEFAULT_SOURCES
)


# ---------------------------------------------------------------------------
# 1. Regex Extraction & Normalization Layer
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class ReferralMatch:
    provider: str
    code: str
    url: str
    source_title: str
    source_permalink: str


PATTERNS: List[Tuple[str, re.Pattern, str]] = [
    (
        "Claude Referral / Trial",
        re.compile(
            r"https?://(?:www\.)?claude\.ai/(?:referral|invite|r|claim)/([A-Za-z0-9_-]{5,64})",
            re.IGNORECASE,
        ),
        "https://claude.ai/referral/{code}",
    ),
    (
        "Anthropic Invite",
        re.compile(
            r"https?://(?:www\.)?anthropic\.com/(?:invite|referral)/([A-Za-z0-9_-]{5,64})",
            re.IGNORECASE,
        ),
        "https://www.anthropic.com/invite/{code}",
    ),
    (
        "Perplexity Pro Referral",
        re.compile(
            r"https?://(?:www\.)?perplexity\.ai/(?:referrals|pro)/([A-Za-z0-9_-]{5,64})",
            re.IGNORECASE,
        ),
        "https://www.perplexity.ai/referrals/{code}",
    ),
    (
        "ChatGPT / OpenAI Invite",
        re.compile(
            r"https?://(?:chat\.openai\.com|chatgpt\.com)/(?:invite|r)/([A-Za-z0-9_-]{5,64})",
            re.IGNORECASE,
        ),
        "https://chatgpt.com/invite/{code}",
    ),
]


def extract_referrals(text: str, title: str, permalink: str) -> List[ReferralMatch]:
    """Scans text for matching referral links, unescapes entities, and normalizes them."""
    matches: List[ReferralMatch] = []
    if not text:
        return matches

    clean_text = html.unescape(text)
    seen_in_batch = set()

    for provider, regex, url_template in PATTERNS:
        for match in regex.finditer(clean_text):
            raw_code = match.group(1)
            dedup_key = f"{provider}:{raw_code.lower()}"
            if dedup_key in seen_in_batch:
                continue
            seen_in_batch.add(dedup_key)

            clean_url = url_template.format(code=raw_code)
            matches.append(
                ReferralMatch(
                    provider=provider,
                    code=dedup_key,
                    url=clean_url,
                    source_title=(title[:120] + "...") if len(title) > 120 else (title or "Direct Post / Comment"),
                    source_permalink=permalink or clean_url,
                )
            )
    return matches


# ---------------------------------------------------------------------------
# 2. SQLite Atomic Deduplication Store
# ---------------------------------------------------------------------------
class DeduplicationStore:
    def __init__(self, db_path: str):
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL;")
        self.conn.execute("PRAGMA synchronous=NORMAL;")
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS seen_referrals (
                code TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                url TEXT NOT NULL,
                source_permalink TEXT,
                discovered_at INTEGER NOT NULL
            )
            """
        )
        self.conn.commit()

    def is_new_and_mark(self, item: ReferralMatch) -> bool:
        """
        Atomically inserts the referral code.
        Returns True if the code was newly inserted, False if already seen.
        """
        cursor = self.conn.cursor()
        cursor.execute(
            """
            INSERT OR IGNORE INTO seen_referrals
                (code, provider, url, source_permalink, discovered_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (item.code, item.provider, item.url, item.source_permalink, int(time.time())),
        )
        self.conn.commit()
        return cursor.rowcount == 1

    def count(self) -> int:
        cursor = self.conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM seen_referrals")
        row = cursor.fetchone()
        return row[0] if row else 0

    def close(self) -> None:
        self.conn.close()


# ---------------------------------------------------------------------------
# 3. Telegram Bot Notifier (with Inline Action Buttons)
# ---------------------------------------------------------------------------
class TelegramNotifier:
    def __init__(self, client: httpx.AsyncClient, bot_token: str, chat_id: str):
        self.client = client
        self.enabled = bool(bot_token and chat_id and bot_token != "your_telegram_bot_token_here")
        self.api_url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        self.chat_id = chat_id

    async def send_alert(self, item: ReferralMatch) -> bool:
        if not self.enabled:
            logger.info("[DRY-RUN Alert] %s -> %s (Source: %s)", item.provider, item.url, item.source_permalink)
            return True

        text = (
            f"⚡ *Fresh {self._escape_md(item.provider)} Found\\!*\n\n"
            f"📌 *Context:* {self._escape_md(item.source_title)}\n"
            f"🔗 `{self._escape_md(item.url)}`"
        )

        payload = {
            "chat_id": self.chat_id,
            "text": text,
            "parse_mode": "MarkdownV2",
            "disable_web_page_preview": True,
            "reply_markup": {
                "inline_keyboard": [
                    [
                        {"text": "🚀 Claim Referral", "url": item.url},
                        {"text": "💬 View Source", "url": item.source_permalink},
                    ]
                ]
            },
        }

        for attempt in range(3):
            try:
                resp = await self.client.post(self.api_url, json=payload, timeout=10.0)
                if resp.status_code == 200:
                    logger.info("Sent Telegram alert for %s", item.url)
                    return True
                elif resp.status_code == 429:
                    retry_after = int(resp.json().get("parameters", {}).get("retry_after", 5))
                    logger.warning("Telegram rate limit hit. Sleeping %ds", retry_after)
                    await asyncio.sleep(retry_after)
                else:
                    logger.error("Telegram API error (%d): %s", resp.status_code, resp.text)
                    return False
            except httpx.RequestError as exc:
                logger.warning("Telegram network error (attempt %d): %s", attempt + 1, exc)
                await asyncio.sleep(2 ** attempt)
        return False

    @staticmethod
    def _escape_md(text: str) -> str:
        escape_chars = r"_*[]()~`>#+-=|{}.!"
        return re.sub(f"([{re.escape(escape_chars)}])", r"\\\1", text)


# ---------------------------------------------------------------------------
# 4. Optional Reddit OAuth2 Token Manager
# ---------------------------------------------------------------------------
class RedditOAuthManager:
    def __init__(self, client: httpx.AsyncClient, client_id: str, client_secret: str):
        self.client = client
        self.client_id = client_id
        self.client_secret = client_secret
        self.access_token: Optional[str] = None
        self.expires_at: float = 0.0
        self._lock = asyncio.Lock()

    @property
    def is_configured(self) -> bool:
        return bool(self.client_id and self.client_secret)

    async def get_headers(self) -> Dict[str, str]:
        headers = {"User-Agent": USER_AGENT}
        if not self.is_configured:
            return headers

        async with self._lock:
            if not self.access_token or time.time() >= self.expires_at - 60:
                await self._refresh_token()
            if self.access_token:
                headers["Authorization"] = f"Bearer {self.access_token}"
        return headers

    async def _refresh_token(self) -> None:
        try:
            resp = await self.client.post(
                "https://www.reddit.com/api/v1/access_token",
                auth=(self.client_id, self.client_secret),
                data={"grant_type": "client_credentials"},
                headers={"User-Agent": USER_AGENT},
                timeout=10.0,
            )
            if resp.status_code == 200:
                data = resp.json()
                self.access_token = data.get("access_token")
                self.expires_at = time.time() + float(data.get("expires_in", 3600))
                logger.info("Refreshed Reddit OAuth2 token successfully.")
            else:
                logger.warning("Failed to get Reddit OAuth token (%d): %s", resp.status_code, resp.text)
        except httpx.RequestError as exc:
            logger.warning("Error refreshing Reddit OAuth token: %s", exc)


# ---------------------------------------------------------------------------
# 5. Resilient Source Poller
# ---------------------------------------------------------------------------
class SourcePoller:
    def __init__(
        self,
        url: str,
        client: httpx.AsyncClient,
        store: DeduplicationStore,
        notifier: TelegramNotifier,
        oauth: RedditOAuthManager,
        base_interval: float = 15.0,
    ):
        self.url = url
        self.client = client
        self.store = store
        self.notifier = notifier
        self.oauth = oauth
        self.base_interval = base_interval
        self.etag: Optional[str] = None
        self.last_modified: Optional[str] = None
        self.consecutive_errors = 0

    def _effective_url(self) -> str:
        if self.oauth.is_configured and "www.reddit.com" in self.url:
            return self.url.replace("https://www.reddit.com", "https://oauth.reddit.com")
        return self.url

    async def poll_once(self) -> float:
        """Executes a single poll cycle and returns the recommended sleep duration."""
        sleep_time = self.base_interval
        target_url = self._effective_url()

        try:
            headers = await self.oauth.get_headers()
            if self.etag:
                headers["If-None-Match"] = self.etag
            if self.last_modified:
                headers["If-Modified-Since"] = self.last_modified

            resp = await self.client.get(target_url, headers=headers, timeout=15.0)

            if resp.status_code == 304:
                self.consecutive_errors = 0
                logger.debug("304 Not Modified: %s", target_url)
            elif resp.status_code == 200:
                self.consecutive_errors = 0
                self.etag = resp.headers.get("ETag")
                self.last_modified = resp.headers.get("Last-Modified")
                await self._parse_response(resp)
            elif resp.status_code == 429:
                retry_after = float(resp.headers.get("Retry-After", 60.0))
                logger.warning("429 Rate Limited on %s. Backing off %.1fs", target_url, retry_after)
                sleep_time = retry_after
            else:
                self.consecutive_errors += 1
                sleep_time = min(300.0, self.base_interval * (2 ** self.consecutive_errors))
                logger.warning(
                    "Unexpected status %d from %s. Backing off %.1fs",
                    resp.status_code,
                    target_url,
                    sleep_time,
                )

            # Respect upstream rate-limit headers if present
            rl_remaining = resp.headers.get("x-ratelimit-remaining")
            rl_reset = resp.headers.get("x-ratelimit-reset")
            if rl_remaining is not None and rl_reset is not None:
                try:
                    if float(rl_remaining) < 5.0:
                        sleep_time = max(sleep_time, float(rl_reset) + 2.0)
                        logger.info("Low rate-limit quota (%s left). Pacing %.1fs", rl_remaining, sleep_time)
                except ValueError:
                    pass

        except httpx.RequestError as exc:
            self.consecutive_errors += 1
            sleep_time = min(300.0, self.base_interval * (2 ** self.consecutive_errors))
            logger.warning("Network error polling %s: %s (retry in %.1fs)", target_url, exc, sleep_time)

        return sleep_time

    async def poll_forever(self, stop_event: asyncio.Event) -> None:
        logger.info("Poller active for: %s", self.url)
        while not stop_event.is_set():
            sleep_time = await self.poll_once()
            jittered_sleep = sleep_time * random.uniform(0.85, 1.15)
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=jittered_sleep)
            except asyncio.TimeoutError:
                pass

    async def _parse_response(self, resp: httpx.Response) -> None:
        content_type = resp.headers.get("content-type", "")
        matches: List[ReferralMatch] = []

        if "application/json" in content_type or self.url.endswith(".json") or ".json?" in self.url:
            try:
                data = resp.json()
                matches.extend(self._extract_from_json(data))
            except ValueError:
                matches.extend(extract_referrals(resp.text, "Raw Feed", self.url))
        else:
            matches.extend(extract_referrals(resp.text, "Web / RSS Source", self.url))

        for match in matches:
            if self.store.is_new_and_mark(match):
                logger.info("New referral discovered: [%s] %s", match.provider, match.url)
                await self.notifier.send_alert(match)

    def _extract_from_json(self, data: object) -> List[ReferralMatch]:
        results: List[ReferralMatch] = []
        if isinstance(data, dict) and "data" in data and isinstance(data["data"], dict):
            children = data["data"].get("children", [])
            for child in children:
                post = child.get("data", {}) if isinstance(child, dict) else {}
                title = post.get("title") or post.get("link_title") or "Reddit Comment/Post"
                selftext = post.get("selftext", "")
                body = post.get("body", "")
                url_dest = post.get("url_overridden_by_dest") or post.get("url") or ""
                permalink_path = post.get("permalink", "")
                permalink = (
                    f"https://www.reddit.com{permalink_path}"
                    if permalink_path.startswith("/")
                    else (permalink_path or self.url)
                )

                combined = f"{title}\n{selftext}\n{body}\n{url_dest}"
                results.extend(extract_referrals(combined, title, permalink))
        else:
            # Generic JSON payload fallback
            results.extend(extract_referrals(str(data), "JSON Endpoint", self.url))
        return results


# ---------------------------------------------------------------------------
# 6. Main Entrypoint
# ---------------------------------------------------------------------------
async def run_monitor(once: bool = False) -> None:
    store = DeduplicationStore(DB_PATH)
    stop_event = asyncio.Event()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:
            signal.signal(sig, lambda *_: stop_event.set())

    if not TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN == "your_telegram_bot_token_here":
        logger.warning(
            "TELEGRAM_BOT_TOKEN is not configured. Running in DRY-RUN mode (alerts logged to console)."
        )

    async with httpx.AsyncClient(http2=True, follow_redirects=True) as client:
        notifier = TelegramNotifier(client, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
        oauth = RedditOAuthManager(client, REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET)

        pollers = [
            SourcePoller(url, client, store, notifier, oauth, base_interval=POLL_INTERVAL)
            for url in SOURCES
        ]

        if once:
            logger.info("Running single-pass check across %d sources...", len(pollers))
            await asyncio.gather(*(p.poll_once() for p in pollers))
        else:
            tasks = [asyncio.create_task(p.poll_forever(stop_event)) for p in pollers]
            logger.info(
                "Referral monitor started (%d sources, %d existing referrals in DB).",
                len(tasks),
                store.count(),
            )
            await asyncio.gather(*tasks)

    store.close()
    logger.info("Shutdown complete.")


if __name__ == "__main__":
    run_once_flag = "--once" in sys.argv
    asyncio.run(run_monitor(once=run_once_flag))
