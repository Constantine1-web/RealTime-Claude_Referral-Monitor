import {
  getMaxPostAgeHours,
  getTargetSources,
  getUserAgent,
  isFresh,
  parseFeedResponse,
  TelegramNotifier,
} from "./core.mjs";
import { RedisStore } from "./redis-store.mjs";

async function pollSingleSource(sourceUrl, store, notifier, userAgent) {
  const startedAt = Date.now();
  const cached = await store.getFeedCache(sourceUrl);
  const headers = {
    "User-Agent": userAgent,
    Accept:
      "application/atom+xml,application/rss+xml,application/xml,application/json,text/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };
  if (cached?.etag) headers["If-None-Match"] = cached.etag;
  if (cached?.lastModified) headers["If-Modified-Since"] = cached.lastModified;

  try {
    const resp = await fetch(sourceUrl, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
    });

    if (resp.status === 304) {
      return {
        url: sourceUrl,
        status: 304,
        state: "not_modified",
        scannedMatches: 0,
        newAlerts: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    if (resp.status !== 200) {
      return {
        url: sourceUrl,
        status: resp.status,
        state: resp.status === 429 ? "rate_limited" : "error",
        scannedMatches: 0,
        newAlerts: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    const etag = resp.headers.get("etag");
    const lastModified = resp.headers.get("last-modified");
    if (etag || lastModified) {
      await store.setFeedCache(sourceUrl, { etag, lastModified });
    }

    const allMatches = await parseFeedResponse(resp, sourceUrl);
    const maxHours = getMaxPostAgeHours();
    const matches = allMatches.filter((m) => isFresh(m, maxHours));
    const staleSkipped = allMatches.length - matches.length;
    let newAlerts = 0;

    for (const match of matches) {
      const isNew = await store.isNewAndMark(match);
      if (isNew) {
        newAlerts++;
        await notifier.sendAlert(match, console);
      }
    }

    return {
      url: sourceUrl,
      status: 200,
      state: "ok",
      scannedMatches: matches.length,
      staleSkipped,
      newAlerts,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    console.error(`Error scanning ${sourceUrl}:`, err);
    return {
      url: sourceUrl,
      status: 0,
      state: "network_error",
      error: err.message,
      scannedMatches: 0,
      newAlerts: 0,
      durationMs: Date.now() - startedAt,
    };
  }
}

export async function runCloudScan({ trigger = "manual", executionId = null } = {}) {
  const startedAt = Date.now();
  const store = new RedisStore();

  if (!store.available) {
    throw new Error("Upstash Redis is not configured (missing KV_REST_API_URL / KV_REST_API_TOKEN).");
  }

  if (executionId) {
    const claimed = await store.claimScheduleExecution(executionId);
    if (!claimed) {
      return {
        skipped: true,
        reason: "duplicate_execution",
        executionId,
      };
    }
  }

  const sources = getTargetSources();
  const userAgent = getUserAgent();
  const notifier = new TelegramNotifier();

  const sourceResults = await Promise.all(
    sources.map((url) => pollSingleSource(url, store, notifier, userAgent))
  );

  const summary = {
    trigger,
    executionId,
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    totalNewAlerts: sourceResults.reduce((acc, s) => acc + s.newAlerts, 0),
    totalScannedMatches: sourceResults.reduce((acc, s) => acc + s.scannedMatches, 0),
    sources: sourceResults,
  };

  await store.recordRunSummary(summary);
  return summary;
}
