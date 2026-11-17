import { Redis } from "@upstash/redis";

const KEYS = {
  seenPrefix: "ref:seen:",
  recentList: "ref:recent",
  totalCount: "ref:total",
  feedCache: "ref:feed_cache",
  lastRun: "ref:last_run",
  lockPrefix: "ref:lock:",
  schedPrefix: "ref:sched:",
};

let _redis = null;

export function isRedisConfigured() {
  return Boolean(
    (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) &&
      (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN)
  );
}

export function getRedis() {
  if (!_redis && isRedisConfigured()) {
    _redis = Redis.fromEnv();
  }
  return _redis;
}

export class RedisStore {
  constructor(redis = getRedis()) {
    this.redis = redis;
  }

  get available() {
    return Boolean(this.redis);
  }

  async isNewAndMark(item) {
    if (!this.redis) return false;
    const result = await this.redis.set(`${KEYS.seenPrefix}${item.code}`, item.discoveredAt || Date.now(), {
      nx: true,
    });
    if (result !== "OK") {
      return false;
    }

    const record = JSON.stringify({
      provider: item.provider,
      code: item.code,
      url: item.url,
      sourceTitle: item.sourceTitle,
      sourcePermalink: item.sourcePermalink,
      discoveredAt: item.discoveredAt || new Date().toISOString(),
    });

    await Promise.all([
      this.redis.lpush(KEYS.recentList, record),
      this.redis.ltrim(KEYS.recentList, 0, 99),
      this.redis.incr(KEYS.totalCount),
    ]);
    return true;
  }

  async getFeedCache(sourceUrl) {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.hget(KEYS.feedCache, sourceUrl);
      if (!raw) return null;
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (err) {
      console.error("Failed reading feed cache:", err);
      return null;
    }
  }

  async setFeedCache(sourceUrl, cacheObj) {
    if (!this.redis) return;
    try {
      await this.redis.hset(KEYS.feedCache, { [sourceUrl]: JSON.stringify(cacheObj) });
    } catch (err) {
      console.error("Failed writing feed cache:", err);
    }
  }

  async acquireCooldown(name, seconds) {
    if (!this.redis) return { allowed: true, retryAfter: 0 };
    const key = `${KEYS.lockPrefix}${name}`;
    const res = await this.redis.set(key, String(Date.now()), {
      nx: true,
      ex: seconds,
    });
    if (res === "OK") {
      return { allowed: true, retryAfter: 0 };
    }
    const ttl = await this.redis.ttl(key);
    return { allowed: false, retryAfter: ttl > 0 ? ttl : seconds };
  }

  async claimScheduleExecution(executionId) {
    if (!this.redis || !executionId) return true;
    const res = await this.redis.set(`${KEYS.schedPrefix}${executionId}`, "1", {
      nx: true,
      ex: 86400,
    });
    return res === "OK";
  }

  async recordRunSummary(summary) {
    if (!this.redis) return;
    try {
      await this.redis.set(KEYS.lastRun, JSON.stringify(summary));
    } catch (err) {
      console.error("Failed storing run summary:", err);
    }
  }

  async getDashboardState(limit = 50) {
    if (!this.redis) {
      return {
        redisConfigured: false,
        totalFound: 0,
        recentReferrals: [],
        lastRun: null,
      };
    }

    const [totalRaw, recentRaw, lastRunRaw] = await Promise.all([
      this.redis.get(KEYS.totalCount),
      this.redis.lrange(KEYS.recentList, 0, limit - 1),
      this.redis.get(KEYS.lastRun),
    ]);

    const recentReferrals = (recentRaw || [])
      .map((entry) => {
        if (typeof entry === "object" && entry !== null) return entry;
        try {
          return JSON.parse(entry);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    let lastRun = null;
    if (lastRunRaw) {
      lastRun = typeof lastRunRaw === "string" ? JSON.parse(lastRunRaw) : lastRunRaw;
    }

    return {
      redisConfigured: true,
      totalFound: Number(totalRaw || 0),
      recentReferrals,
      lastRun,
    };
  }
}
