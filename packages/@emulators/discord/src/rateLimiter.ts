import type { Store } from "@emulators/core";

/**
 * Discord-style rate limiting. The emulator enforces real per-route buckets plus a global
 * limit: every REST response carries the X-RateLimit-* headers, and once a bucket (or the
 * global budget) is exhausted within its window, the request gets a 429 with a Retry-After
 * and a Discord-shaped body. Limits are generous by default so ordinary usage never trips;
 * a client testing its own 429 handling can tighten them via `store.setData` (see
 * `setRateLimitConfig`) or by disabling enforcement entirely.
 */
export interface RateLimitConfig {
  enabled: boolean;
  globalLimit: number;
  routeLimit: number;
  windowMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  enabled: true,
  globalLimit: 500,
  routeLimit: 200,
  windowMs: 1000,
};

const CONFIG_KEY = "discord.rate_limit.config";
const LIMITER_KEY = "discord.rate_limit.limiter";

interface CounterWindow {
  count: number;
  resetAt: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  global: boolean;
  bucket: string;
  limit: number;
  remaining: number;
  resetAfterMs: number;
}

/** Derive a bucket key from method + path, scoped by the major resource id (Discord buckets). */
export function bucketFor(method: string, path: string): string {
  const segments = path.replace(/^\/api\/v\d+/, "").split("/").filter(Boolean);
  let major = "";
  const template = segments
    .map((seg, i) => {
      const prev = segments[i - 1];
      const idLike = /^\d{5,}$/.test(seg);
      if (idLike) {
        if (prev === "channels" || prev === "guilds" || prev === "webhooks") {
          major = `${prev}:${seg}`;
          return "{major}";
        }
        return "{}";
      }
      return seg;
    })
    .join("/");
  return `${method} /${template} ${major}`;
}

function hashBucket(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export class RateLimiter {
  private readonly global: CounterWindow = { count: 0, resetAt: 0 };
  private readonly buckets = new Map<string, CounterWindow>();

  constructor(public readonly config: RateLimitConfig) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  private roll(window: CounterWindow, now: number): void {
    if (now >= window.resetAt) {
      window.count = 0;
      window.resetAt = now + this.config.windowMs;
    }
  }

  check(method: string, path: string): RateLimitDecision {
    const now = Date.now();
    this.roll(this.global, now);

    const bucketKey = bucketFor(method, path);
    let bucket = this.buckets.get(bucketKey);
    if (!bucket) {
      bucket = { count: 0, resetAt: now + this.config.windowMs };
      this.buckets.set(bucketKey, bucket);
    }
    this.roll(bucket, now);

    const bucketHash = hashBucket(bucketKey);

    if (this.global.count >= this.config.globalLimit) {
      return { allowed: false, global: true, bucket: bucketHash, limit: this.config.globalLimit, remaining: 0, resetAfterMs: Math.max(0, this.global.resetAt - now) };
    }
    if (bucket.count >= this.config.routeLimit) {
      return { allowed: false, global: false, bucket: bucketHash, limit: this.config.routeLimit, remaining: 0, resetAfterMs: Math.max(0, bucket.resetAt - now) };
    }

    this.global.count += 1;
    bucket.count += 1;
    return {
      allowed: true,
      global: false,
      bucket: bucketHash,
      limit: this.config.routeLimit,
      remaining: Math.max(0, this.config.routeLimit - bucket.count),
      resetAfterMs: Math.max(0, bucket.resetAt - now),
    };
  }
}

/** Override the rate-limit config for a store (e.g. to test 429 handling, or disable it). */
export function setRateLimitConfig(store: Store, config: Partial<RateLimitConfig>): void {
  const merged = { ...DEFAULT_RATE_LIMIT, ...config };
  store.setData(CONFIG_KEY, merged);
  store.setData(LIMITER_KEY, new RateLimiter(merged));
}

/** Get (lazily creating) the rate limiter bound to a store. */
export function getRateLimiter(store: Store): RateLimiter {
  let limiter = store.getData<RateLimiter>(LIMITER_KEY);
  if (!limiter) {
    const config = store.getData<RateLimitConfig>(CONFIG_KEY) ?? DEFAULT_RATE_LIMIT;
    limiter = new RateLimiter(config);
    store.setData(LIMITER_KEY, limiter);
  }
  return limiter;
}
