import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json, seededIds } from "./helpers.js";

describe("resource-specific error codes", () => {
  it("unknown channel -> 10003", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/channels/999999999999999999"), { headers: botHeaders() });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10003);
  });

  it("unknown guild -> 10004", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/guilds/999999999999999999/channels"), { headers: botHeaders() });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10004);
  });

  it("unknown ban -> 10026", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = seededIds(store);
    const res = await app.request(api(`/guilds/${guild}/bans/999999999999999999`), { headers: botHeaders() });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10026);
  });

  it("unknown message on pin -> 10008", async () => {
    const { app, store } = createDiscordTestApp();
    const { general: channel } = seededIds(store);
    const res = await app.request(api(`/channels/${channel}/pins/999999999999999999`), { method: "PUT", headers: botHeaders() });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10008);
  });
});
