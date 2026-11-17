import { getTargetSources, TelegramNotifier } from "../lib/core.mjs";
import { RedisStore } from "../lib/redis-store.mjs";

export async function GET() {
  try {
    const store = new RedisStore();
    const notifier = new TelegramNotifier();
    const state = await store.getDashboardState(60);

    return Response.json(
      {
        ok: true,
        ...state,
        telegramConfigured: notifier.enabled,
        configuredSources: getTargetSources(),
        scheduleCadence: "Every 15 minutes (Vercel Schedules)",
        serverTime: new Date().toISOString(),
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (err) {
    console.error("GET /api/status failed:", err);
    return Response.json(
      { ok: false, error: err.message || "Failed to load status" },
      { status: 500 }
    );
  }
}
