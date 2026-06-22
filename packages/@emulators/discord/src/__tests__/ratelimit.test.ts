import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "./helpers.js";
import { setRateLimitConfig } from "../rateLimiter.js";

describe("discord rate limiting", () => {
  it("includes Discord-style rate-limit headers on REST responses", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me"), { headers: botHeaders() });
    expect(res.headers.get("x-ratelimit-limit")).toBeTruthy();
    expect(res.headers.get("x-ratelimit-remaining")).toBeTruthy();
    expect(res.headers.get("x-ratelimit-bucket")).toBeTruthy();
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("decrements remaining across requests to the same bucket", async () => {
    const { app } = createDiscordTestApp();
    const first = await app.request(api("/users/@me"), { headers: botHeaders() });
    const second = await app.request(api("/users/@me"), { headers: botHeaders() });
    const r1 = Number(first.headers.get("x-ratelimit-remaining"));
    const r2 = Number(second.headers.get("x-ratelimit-remaining"));
    expect(r2).toBe(r1 - 1);
  });

  it("enforces a 429 with Retry-After once a bucket is exhausted", async () => {
    const { app, store } = createDiscordTestApp();
    setRateLimitConfig(store, { routeLimit: 3, globalLimit: 1000, windowMs: 10_000 });

    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await app.request(api("/users/@me"), { headers: botHeaders() });
      statuses.push(res.status);
      if (res.status === 429) {
        expect(res.headers.get("retry-after")).toBeTruthy();
        const body = (await res.json()) as { message: string; retry_after: number; global: boolean };
        expect(body.message).toContain("rate limited");
        expect(body.global).toBe(false);
        expect(body.retry_after).toBeGreaterThan(0);
      }
    }
    // First 3 allowed, then 429s.
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
  });

  it("applies a separate global budget across buckets", async () => {
    const { app, store } = createDiscordTestApp();
    setRateLimitConfig(store, { routeLimit: 1000, globalLimit: 2, windowMs: 10_000 });

    // Two different buckets consume the global budget; the third request is globally limited.
    const a = await app.request(api("/users/@me"), { headers: botHeaders() });
    const b = await app.request(api("/gateway/bot"), { headers: botHeaders() });
    const c = await app.request(api("/voice/regions"), { headers: botHeaders() });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c.status).toBe(429);
    expect(c.headers.get("x-ratelimit-global")).toBe("true");
    expect(c.headers.get("x-ratelimit-scope")).toBe("global");
  });

  it("can be disabled", async () => {
    const { app, store } = createDiscordTestApp();
    setRateLimitConfig(store, { enabled: false });
    for (let i = 0; i < 100; i++) {
      const res = await app.request(api("/users/@me"), { headers: botHeaders() });
      expect(res.status).toBe(200);
    }
  });
});
