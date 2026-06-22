import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "./helpers.js";

describe("discord rate-limit headers", () => {
  it("includes Discord-style rate-limit headers on REST responses", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me"), { headers: botHeaders() });
    expect(res.headers.get("x-ratelimit-limit")).toBeTruthy();
    expect(res.headers.get("x-ratelimit-remaining")).toBeTruthy();
    expect(res.headers.get("x-ratelimit-bucket")).toBe("emulate");
    expect(res.headers.get("content-type")).toBe("application/json");
  });
});
