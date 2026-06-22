/**
 * Spec suite for `developers/topics/rate-limits.mdx`.
 *
 * Encodes the documented contract that real clients (discord.js, Discordeno) depend on:
 * the response-header format, the 429 body shape, per-route vs global limits, and the
 * distinction between X-RateLimit-Scope values. Written from the doc first; the
 * implementation is built/fixed until this is green.
 *
 * Headers set in index.ts (read-only) are tested here through HTTP requests.
 * The `setRateLimitConfig` helper tightens limits so 429s are deterministic.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json } from "../helpers.js";
import { setRateLimitConfig, bucketFor } from "../../rateLimiter.js";

// ---------------------------------------------------------------------------
// Header format — normal (non-rate-limited) requests
// ---------------------------------------------------------------------------

describe("rate-limits.mdx — Header Format (normal requests)", () => {
  it("X-RateLimit-Limit is present and is a positive integer string", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me"), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const limit = res.headers.get("x-ratelimit-limit");
    expect(limit).not.toBeNull();
    expect(Number.isInteger(Number(limit))).toBe(true);
    expect(Number(limit)).toBeGreaterThan(0);
  });

  it("X-RateLimit-Remaining is present and is a non-negative integer string", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me"), { headers: botHeaders() });
    const remaining = res.headers.get("x-ratelimit-remaining");
    expect(remaining).not.toBeNull();
    expect(Number.isInteger(Number(remaining))).toBe(true);
    expect(Number(remaining)).toBeGreaterThanOrEqual(0);
  });

  it("X-RateLimit-Reset is present and is a unix epoch seconds value (> year 2020)", async () => {
    const { app } = createDiscordTestApp();
    const beforeMs = Date.now();
    const res = await app.request(api("/users/@me"), { headers: botHeaders() });
    const afterMs = Date.now();
    const resetHeader = res.headers.get("x-ratelimit-reset");
    expect(resetHeader).not.toBeNull();
    const resetSec = Number(resetHeader);
    expect(isNaN(resetSec)).toBe(false);
    // Must be a Unix epoch seconds value after January 1 2020.
    const jan2020Sec = new Date("2020-01-01T00:00:00Z").getTime() / 1000;
    expect(resetSec).toBeGreaterThan(jan2020Sec);
    // Must be at or after the current time (it is the future reset point).
    expect(resetSec * 1000).toBeGreaterThanOrEqual(beforeMs - 1);
    // Must not be absurdly far in the future (sanity: within 1 hour).
    expect(resetSec * 1000).toBeLessThan(afterMs + 3_600_000);
  });

  it("X-RateLimit-Reset-After is present and is a non-negative numeric string (may be decimal)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me"), { headers: botHeaders() });
    const resetAfter = res.headers.get("x-ratelimit-reset-after");
    expect(resetAfter).not.toBeNull();
    const value = Number(resetAfter);
    expect(isNaN(value)).toBe(false);
    expect(value).toBeGreaterThanOrEqual(0);
  });

  it("X-RateLimit-Bucket is present and is a non-empty hex-like string", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me"), { headers: botHeaders() });
    const bucket = res.headers.get("x-ratelimit-bucket");
    expect(bucket).not.toBeNull();
    expect(typeof bucket).toBe("string");
    expect(bucket!.length).toBeGreaterThan(0);
    // Documented as a unique string; our implementation produces lowercase hex.
    expect(/^[0-9a-f]+$/i.test(bucket!)).toBe(true);
  });

  it("X-RateLimit-Bucket is non-inclusive of the top-level resource (same across major ids)", async () => {
    // rate-limits.mdx: the bucket id is "non-inclusive of top-level resources in the path", so the
    // same route on different channels/guilds reports the SAME bucket hash (counters stay separate).
    const { app } = createDiscordTestApp();
    const a = await app.request(api("/channels/111111111111111/messages"), { headers: botHeaders() });
    const b = await app.request(api("/channels/999999999999999/messages"), { headers: botHeaders() });
    expect(a.headers.get("x-ratelimit-bucket")).toBe(b.headers.get("x-ratelimit-bucket"));
  });

  it("X-RateLimit-Global and X-RateLimit-Scope are ABSENT on normal (non-429) responses", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me"), { headers: botHeaders() });
    expect(res.status).toBe(200);
    // Doc: "Returned only on HTTP 429 responses"
    expect(res.headers.get("x-ratelimit-global")).toBeNull();
    expect(res.headers.get("x-ratelimit-scope")).toBeNull();
  });

  it("all five standard rate-limit headers are present together on a single response", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me"), { headers: botHeaders() });
    const names = [
      "x-ratelimit-limit",
      "x-ratelimit-remaining",
      "x-ratelimit-reset",
      "x-ratelimit-reset-after",
      "x-ratelimit-bucket",
    ];
    for (const name of names) {
      expect(res.headers.get(name), `expected header ${name}`).not.toBeNull();
    }
  });

  it("X-RateLimit-Remaining decrements by one on successive requests to the same route", async () => {
    const { app } = createDiscordTestApp();
    const r1 = await app.request(api("/users/@me"), { headers: botHeaders() });
    const r2 = await app.request(api("/users/@me"), { headers: botHeaders() });
    const rem1 = Number(r1.headers.get("x-ratelimit-remaining"));
    const rem2 = Number(r2.headers.get("x-ratelimit-remaining"));
    expect(rem2).toBe(rem1 - 1);
  });

  it("X-RateLimit-Limit matches the configured routeLimit", async () => {
    const { app, store } = createDiscordTestApp();
    setRateLimitConfig(store, { routeLimit: 7, globalLimit: 1000, windowMs: 10_000 });
    const res = await app.request(api("/users/@me"), { headers: botHeaders() });
    expect(Number(res.headers.get("x-ratelimit-limit"))).toBe(7);
  });

  it("different routes share per-bucket accounting — distinct buckets have independent remaining counters", async () => {
    const { app, store } = createDiscordTestApp();
    setRateLimitConfig(store, { routeLimit: 5, globalLimit: 1000, windowMs: 10_000 });
    // Hit route A twice.
    await app.request(api("/users/@me"), { headers: botHeaders() });
    const a2 = await app.request(api("/users/@me"), { headers: botHeaders() });
    // Hit route B once.
    const b1 = await app.request(api("/gateway/bot"), { headers: botHeaders() });
    // Route A remaining should be 3 (5 - 2), route B remaining should be 4 (5 - 1).
    expect(Number(a2.headers.get("x-ratelimit-remaining"))).toBe(3);
    expect(Number(b1.headers.get("x-ratelimit-remaining"))).toBe(4);
    // And the bucket identifiers must differ.
    expect(a2.headers.get("x-ratelimit-bucket")).not.toBe(b1.headers.get("x-ratelimit-bucket"));
  });
});

// ---------------------------------------------------------------------------
// Exceeding a per-route rate limit — 429 body and header contract
// ---------------------------------------------------------------------------

describe("rate-limits.mdx — Exceeding A Rate Limit (per-route / user scope)", () => {
  it("remaining reaches 0 on the last allowed request before the 429", async () => {
    const { app, store } = createDiscordTestApp();
    setRateLimitConfig(store, { routeLimit: 2, globalLimit: 1000, windowMs: 10_000 });
    const r1 = await app.request(api("/users/@me"), { headers: botHeaders() });
    const r2 = await app.request(api("/users/@me"), { headers: botHeaders() });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // The last allowed response must advertise remaining = 0.
    expect(Number(r2.headers.get("x-ratelimit-remaining"))).toBe(0);
    // The very next request must be refused.
    const r3 = await app.request(api("/users/@me"), { headers: botHeaders() });
    expect(r3.status).toBe(429);
  });

  it("429 response carries Retry-After header with a positive numeric value", async () => {
    const { app, store } = createDiscordTestApp();
    setRateLimitConfig(store, { routeLimit: 1, globalLimit: 1000, windowMs: 10_000 });
    await app.request(api("/users/@me"), { headers: botHeaders() });
    const res = await app.request(api("/users/@me"), { headers: botHeaders() });
    expect(res.status).toBe(429);
    const retryAfter = res.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it("429 body has documented shape: message (string), retry_after (number), global (boolean)", async () => {
    const { app, store } = createDiscordTestApp();
    setRateLimitConfig(store, { routeLimit: 1, globalLimit: 1000, windowMs: 10_000 });
    await app.request(api("/users/@me"), { headers: botHeaders() });
    const res = await app.request(api("/users/@me"), { headers: botHeaders() });
    expect(res.status).toBe(429);
    const body = await json(res);
    // message: string — a human-readable rate-limit message.
    expect(typeof body.message).toBe("string");
    expect((body.message as string).length).toBeGreaterThan(0);
    // retry_after: float — seconds until the bucket resets.
    expect(typeof body.retry_after).toBe("number");
    expect(body.retry_after).toBeGreaterThan(0);
    // global: boolean — false for a per-route limit.
    expect(typeof body.global).toBe("boolean");
    expect(body.global).toBe(false);
  });

  it("429 body retry_after matches the Retry-After header value", async () => {
    const { app, store } = createDiscordTestApp();
    setRateLimitConfig(store, { routeLimit: 1, globalLimit: 1000, windowMs: 10_000 });
    await app.request(api("/users/@me"), { headers: botHeaders() });
    const res = await app.request(api("/users/@me"), { headers: botHeaders() });
    expect(res.status).toBe(429);
    const body = await json<{ retry_after: number }>(res);
    const headerVal = Number(res.headers.get("retry-after"));
    // Both represent seconds; they should be equal (or very close).
    expect(Math.abs(body.retry_after - headerVal)).toBeLessThan(0.01);
  });

  it("429 response also carries the standard rate-limit headers (limit, remaining, reset, reset-after, bucket)", async () => {
    const { app, store } = createDiscordTestApp();
    setRateLimitConfig(store, { routeLimit: 1, globalLimit: 1000, windowMs: 10_000 });
    await app.request(api("/users/@me"), { headers: botHeaders() });
    const res = await app.request(api("/users/@me"), { headers: botHeaders() });
    expect(res.status).toBe(429);
    // Doc: "normal route rate-limiting headers will also be sent in this response"
    const names = [
      "x-ratelimit-limit",
      "x-ratelimit-remaining",
      "x-ratelimit-reset",
      "x-ratelimit-reset-after",
      "x-ratelimit-bucket",
    ];
    for (const name of names) {
      expect(res.headers.get(name), `expected header ${name} on 429`).not.toBeNull();
    }
    // Remaining must be 0 on the 429 itself.
    expect(Number(res.headers.get("x-ratelimit-remaining"))).toBe(0);
  });

  it("per-route 429 carries X-RateLimit-Scope: user and does NOT send X-RateLimit-Global", async () => {
    const { app, store } = createDiscordTestApp();
    setRateLimitConfig(store, { routeLimit: 1, globalLimit: 1000, windowMs: 10_000 });
    await app.request(api("/users/@me"), { headers: botHeaders() });
    const res = await app.request(api("/users/@me"), { headers: botHeaders() });
    expect(res.status).toBe(429);
    // Doc: X-RateLimit-Scope can be "user" for per bot/user limit.
    expect(res.headers.get("x-ratelimit-scope")).toBe("user");
    // Doc: X-RateLimit-Global is returned ONLY when the global limit is hit.
    expect(res.headers.get("x-ratelimit-global")).toBeNull();
  });

  it("Content-Type on a 429 response is application/json", async () => {
    const { app, store } = createDiscordTestApp();
    setRateLimitConfig(store, { routeLimit: 1, globalLimit: 1000, windowMs: 10_000 });
    await app.request(api("/users/@me"), { headers: botHeaders() });
    const res = await app.request(api("/users/@me"), { headers: botHeaders() });
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

// ---------------------------------------------------------------------------
// Global rate limit — X-RateLimit-Global: true, scope: global
// ---------------------------------------------------------------------------

describe("rate-limits.mdx — Global Rate Limit", () => {
  it("hitting the global budget returns 429 with X-RateLimit-Global: true", async () => {
    const { app, store } = createDiscordTestApp();
    setRateLimitConfig(store, { routeLimit: 1000, globalLimit: 2, windowMs: 10_000 });
    // Two different routes consume the global budget.
    await app.request(api("/users/@me"), { headers: botHeaders() });
    await app.request(api("/gateway/bot"), { headers: botHeaders() });
    // Third request trips the global limit.
    const res = await app.request(api("/voice/regions"), { headers: botHeaders() });
    expect(res.status).toBe(429);
    expect(res.headers.get("x-ratelimit-global")).toBe("true");
  });

  it("global 429 carries X-RateLimit-Scope: global", async () => {
    const { app, store } = createDiscordTestApp();
    setRateLimitConfig(store, { routeLimit: 1000, globalLimit: 2, windowMs: 10_000 });
    await app.request(api("/users/@me"), { headers: botHeaders() });
    await app.request(api("/gateway/bot"), { headers: botHeaders() });
    const res = await app.request(api("/voice/regions"), { headers: botHeaders() });
    expect(res.status).toBe(429);
    expect(res.headers.get("x-ratelimit-scope")).toBe("global");
  });

  it("global 429 body has global: true", async () => {
    const { app, store } = createDiscordTestApp();
    setRateLimitConfig(store, { routeLimit: 1000, globalLimit: 1, windowMs: 10_000 });
    await app.request(api("/users/@me"), { headers: botHeaders() });
    const res = await app.request(api("/gateway/bot"), { headers: botHeaders() });
    expect(res.status).toBe(429);
    const body = await json<{ global: boolean; retry_after: number; message: string }>(res);
    expect(body.global).toBe(true);
    expect(typeof body.retry_after).toBe("number");
    expect(body.retry_after).toBeGreaterThan(0);
    expect(typeof body.message).toBe("string");
  });

  it("global 429 still includes Retry-After header", async () => {
    const { app, store } = createDiscordTestApp();
    setRateLimitConfig(store, { routeLimit: 1000, globalLimit: 1, windowMs: 10_000 });
    await app.request(api("/users/@me"), { headers: botHeaders() });
    const res = await app.request(api("/gateway/bot"), { headers: botHeaders() });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("per-route limit does NOT set X-RateLimit-Global on normal 200 responses", async () => {
    const { app, store } = createDiscordTestApp();
    setRateLimitConfig(store, { routeLimit: 5, globalLimit: 1000, windowMs: 10_000 });
    const res = await app.request(api("/users/@me"), { headers: botHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-global")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bucket identity and reset behaviour
// ---------------------------------------------------------------------------

describe("rate-limits.mdx — Bucket identity and reset", () => {
  it("bucketFor() produces the same bucket hash for the same method + route", () => {
    // Two calls to the same route template produce the same bucket key.
    const b1 = bucketFor("GET", "/api/v10/users/@me");
    const b2 = bucketFor("GET", "/api/v10/users/@me");
    expect(b1).toBe(b2);
  });

  it("bucketFor() produces different bucket keys for different methods on the same path", () => {
    const get = bucketFor("GET", "/api/v10/channels/123456789012345");
    const patch = bucketFor("PATCH", "/api/v10/channels/123456789012345");
    expect(get).not.toBe(patch);
  });

  it("bucketFor() scopes channel routes by major resource id (channel_id)", () => {
    // Different channel ids produce different bucket keys, per the Discord doc.
    const ch1 = bucketFor("GET", "/api/v10/channels/111111111111111/messages");
    const ch2 = bucketFor("GET", "/api/v10/channels/999999999999999/messages");
    expect(ch1).not.toBe(ch2);
  });

  it("bucketFor() scopes guild routes by major resource id (guild_id)", () => {
    const g1 = bucketFor("GET", "/api/v10/guilds/111111111111111/channels");
    const g2 = bucketFor("GET", "/api/v10/guilds/999999999999999/channels");
    expect(g1).not.toBe(g2);
  });

  it("same route with the same major resource id gets the same bucket key", () => {
    const a = bucketFor("GET", "/api/v10/guilds/111111111111111/channels");
    const b = bucketFor("GET", "/api/v10/guilds/111111111111111/channels");
    expect(a).toBe(b);
  });

  it("X-RateLimit-Bucket values are consistent across requests to the same route", async () => {
    const { app } = createDiscordTestApp();
    const r1 = await app.request(api("/users/@me"), { headers: botHeaders() });
    const r2 = await app.request(api("/users/@me"), { headers: botHeaders() });
    expect(r1.headers.get("x-ratelimit-bucket")).toBe(r2.headers.get("x-ratelimit-bucket"));
  });

  it("after the window expires the bucket resets and requests are allowed again", async () => {
    const { app, store } = createDiscordTestApp();
    // Very short window so we can actually wait it out.
    setRateLimitConfig(store, { routeLimit: 1, globalLimit: 1000, windowMs: 50 });
    const r1 = await app.request(api("/users/@me"), { headers: botHeaders() });
    expect(r1.status).toBe(200);
    const r2 = await app.request(api("/users/@me"), { headers: botHeaders() });
    expect(r2.status).toBe(429);
    // Wait for the window to elapse.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    // Now the bucket has reset; the request should be allowed.
    const r3 = await app.request(api("/users/@me"), { headers: botHeaders() });
    expect(r3.status).toBe(200);
    expect(Number(r3.headers.get("x-ratelimit-remaining"))).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Rate-limit middleware bypasses non-API paths
// ---------------------------------------------------------------------------

describe("rate-limits.mdx — Middleware scope", () => {
  it("rate-limit headers are NOT attached to non-/api/ paths", async () => {
    const { app } = createDiscordTestApp();
    // The Gateway route does not go through /api/, so it should not carry rate-limit headers.
    // We just verify that the middleware is correctly scoped: hit a known /api/ path and
    // confirm headers appear, then hit a non-existent non-api path and confirm they don't.
    const apiRes = await app.request(api("/users/@me"), { headers: botHeaders() });
    expect(apiRes.headers.get("x-ratelimit-limit")).not.toBeNull();

    // Non-API path (root) should not carry rate-limit headers.
    const rootRes = await app.request("http://localhost:4099/");
    expect(rootRes.headers.get("x-ratelimit-limit")).toBeNull();
  });

  it("rate limiting can be disabled entirely via setRateLimitConfig", async () => {
    const { app, store } = createDiscordTestApp();
    setRateLimitConfig(store, { enabled: false, routeLimit: 1, globalLimit: 1, windowMs: 10_000 });
    // Even though routeLimit is 1, no 429 should fire with enforcement disabled.
    for (let i = 0; i < 5; i++) {
      const res = await app.request(api("/users/@me"), { headers: botHeaders() });
      expect(res.status).toBe(200);
    }
  });
});
