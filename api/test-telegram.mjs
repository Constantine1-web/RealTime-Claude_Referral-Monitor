import { TelegramNotifier } from "../lib/core.mjs";
import { RedisStore } from "../lib/redis-store.mjs";

export async function POST() {
  try {
    const notifier = new TelegramNotifier();
    if (!notifier.enabled) {
      return Response.json(
        {
          ok: false,
          error: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured on this deployment.",
        },
        { status: 400 }
      );
    }

    const store = new RedisStore();
    const lock = await store.acquireCooldown("test-telegram", 60);
    if (!lock.allowed) {
      return Response.json(
        {
          ok: false,
          cooldownRemaining: lock.retryAfter,
          error: `Please wait ${lock.retryAfter}s before sending another test ping.`,
        },
        { status: 429 }
      );
    }

    const result = await notifier.sendAlert(
      {
        provider: "Claude Referral / Trial (Web Ping)",
        code: "test:web-ping",
        url: "https://claude.ai/referral/TEST_WEB_DASHBOARD",
        sourceTitle: "Triggered from Vercel Live Dashboard",
        sourcePermalink: "https://github.com/Constantine1-web/RealTime-Claude_Referral-Monitor",
      },
      console
    );

    if (!result.ok) {
      return Response.json(
        { ok: false, error: result.error || "Telegram API rejected the request" },
        { status: 502 }
      );
    }

    return Response.json({ ok: true, sent: true }, { status: 200 });
  } catch (err) {
    console.error("POST /api/test-telegram failed:", err);
    return Response.json(
      { ok: false, error: err.message || "Failed to send test alert" },
      { status: 500 }
    );
  }
}
