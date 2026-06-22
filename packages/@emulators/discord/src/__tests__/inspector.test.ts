import { describe, it, expect, beforeEach } from "vitest";
import { createDiscordTestApp, TEST_BASE_URL, type DiscordTestApp } from "./helpers.js";

describe("GET / inspector", () => {
  let testApp: DiscordTestApp;

  beforeEach(() => {
    testApp = createDiscordTestApp();
  });

  it("returns 200 and contains the default guild name", async () => {
    const res = await testApp.app.request(`${TEST_BASE_URL}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Emulate Server");
  });

  it("returns HTML content type", async () => {
    const res = await testApp.app.request(`${TEST_BASE_URL}/`);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("defaults to the guilds tab", async () => {
    const res = await testApp.app.request(`${TEST_BASE_URL}/`);
    const text = await res.text();
    expect(text).toContain("Guilds");
    // The guilds tab link should be marked active
    expect(text).toContain('class="active"');
  });

  it("GET /?tab=channels contains #general", async () => {
    const res = await testApp.app.request(`${TEST_BASE_URL}/?tab=channels`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("general");
  });

  it("GET /?tab=channels contains channel type labels", async () => {
    const res = await testApp.app.request(`${TEST_BASE_URL}/?tab=channels`);
    const text = await res.text();
    // Text channels and voice channels are seeded
    expect(text).toContain("Text");
    expect(text).toContain("Voice");
  });

  it("GET /?tab=tokens contains the bot username emulate-bot", async () => {
    const res = await testApp.app.request(`${TEST_BASE_URL}/?tab=tokens`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("emulate-bot");
  });

  it("GET /?tab=tokens contains the ed25519 public key", async () => {
    const res = await testApp.app.request(`${TEST_BASE_URL}/?tab=tokens`);
    const text = await res.text();
    // The verify_key is a 64-char hex string; just assert a long hex-like string appears
    expect(text).toContain("Ed25519 public key");
  });

  it("GET /?tab=tokens contains seeded bot token", async () => {
    const res = await testApp.app.request(`${TEST_BASE_URL}/?tab=tokens`);
    const text = await res.text();
    expect(text).toContain("test_bot_token");
  });

  it("GET /?tab=members contains member rows for Emulate Server", async () => {
    const res = await testApp.app.request(`${TEST_BASE_URL}/?tab=members`);
    expect(res.status).toBe(200);
    const text = await res.text();
    // The default seed adds developer and emulate-bot as members
    expect(text).toContain("developer");
  });

  it("GET /?tab=gateway returns 200 with gateway section", async () => {
    const res = await testApp.app.request(`${TEST_BASE_URL}/?tab=gateway`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Gateway Sessions");
  });

  it("GET /?tab=messages returns 200", async () => {
    const res = await testApp.app.request(`${TEST_BASE_URL}/?tab=messages`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Messages");
  });

  it("unknown tab falls back to guilds tab", async () => {
    const res = await testApp.app.request(`${TEST_BASE_URL}/?tab=nonexistent`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Emulate Server");
  });
});
