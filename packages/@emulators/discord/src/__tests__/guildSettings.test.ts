import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json, seededIds } from "./helpers.js";

function guildId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return seededIds(store).guild;
}

describe("discord guild settings", () => {
  it("updates and reads widget settings", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);
    const patched = await json<{ enabled: boolean }>(await app.request(api(`/guilds/${gid}/widget`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ enabled: true }),
    }));
    expect(patched.enabled).toBe(true);
    const got = await json<{ enabled: boolean }>(await app.request(api(`/guilds/${gid}/widget`), { headers: botHeaders() }));
    expect(got.enabled).toBe(true);
  });

  it("updates the welcome screen and onboarding", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);
    const welcome = await json<{ description: string }>(await app.request(api(`/guilds/${gid}/welcome-screen`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ description: "Welcome!" }),
    }));
    expect(welcome.description).toBe("Welcome!");

    const onboarding = await json<{ enabled: boolean; mode: number; guild_id: string }>(await app.request(api(`/guilds/${gid}/onboarding`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ enabled: true, mode: 1 }),
    }));
    expect(onboarding.enabled).toBe(true);
    expect(onboarding.mode).toBe(1);
    expect(onboarding.guild_id).toBe(gid);
  });

  it("serves the public widget json", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);
    const res = await app.request(api(`/guilds/${gid}/widget.json`));
    expect(res.status).toBe(200);
    const widget = await json<{ id: string; name: string }>(res);
    expect(widget.id).toBe(gid);
    expect(widget.name).toBe("Emulate Server");
  });
});
