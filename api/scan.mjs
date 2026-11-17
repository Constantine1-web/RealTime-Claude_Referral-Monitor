import { RedisStore } from "../lib/redis-store.mjs";
import { runCloudScan } from "../lib/scanner.mjs";

export async function POST(request) {
  try {
    const store = new RedisStore();
    if (!store.available) {
      return Response.json(
        { ok: false, error: "Upstash Redis is not configured." },
        { status: 503 }
      );
    }

    const trigger =
      request.headers.get("x-scan-trigger") === "live-watch" ? "live-watch" : "manual";

    const lock = await store.acquireCooldown("manual-scan", 15);
    if (!lock.allowed) {
      const state = await store.getDashboardState(60);
      return Response.json(
        {
          ok: true,
          cached: true,
          cooldownRemaining: lock.retryAfter,
          summary: state.lastRun,
          totalFound: state.totalFound,
          recentReferrals: state.recentReferrals,
        },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    }

    const summary = await runCloudScan({ trigger });
    const state = await store.getDashboardState(60);

    return Response.json(
      {
        ok: true,
        cached: false,
        cooldownRemaining: 15,
        summary,
        totalFound: state.totalFound,
        recentReferrals: state.recentReferrals,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("POST /api/scan failed:", err);
    return Response.json(
      { ok: false, error: err.message || "Scan failed" },
      { status: 500 }
    );
  }
}
