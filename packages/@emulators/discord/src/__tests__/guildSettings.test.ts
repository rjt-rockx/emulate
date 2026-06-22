import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "./helpers.js";
import { getDiscordStore } from "../store.js";

function guildId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return getDiscordStore(store).guilds.findOneBy("name", "Emulate Server")!.snowflake;
}

describe("discord guild settings", () => {
  it("updates and reads widget settings", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);
    const patched = (await (
      await app.request(api(`/guilds/${gid}/widget`), {
        method: "PATCH",
        headers: botHeaders(),
        body: JSON.stringify({ enabled: true }),
      })
    ).json()) as { enabled: boolean };
    expect(patched.enabled).toBe(true);
    const got = (await (await app.request(api(`/guilds/${gid}/widget`), { headers: botHeaders() })).json()) as { enabled: boolean };
    expect(got.enabled).toBe(true);
  });

  it("updates the welcome screen and onboarding", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);
    const welcome = (await (
      await app.request(api(`/guilds/${gid}/welcome-screen`), {
        method: "PATCH",
        headers: botHeaders(),
        body: JSON.stringify({ description: "Welcome!" }),
      })
    ).json()) as { description: string };
    expect(welcome.description).toBe("Welcome!");

    const onboarding = (await (
      await app.request(api(`/guilds/${gid}/onboarding`), {
        method: "PUT",
        headers: botHeaders(),
        body: JSON.stringify({ enabled: true, mode: 1 }),
      })
    ).json()) as { enabled: boolean; mode: number; guild_id: string };
    expect(onboarding.enabled).toBe(true);
    expect(onboarding.mode).toBe(1);
    expect(onboarding.guild_id).toBe(gid);
  });

  it("serves the public widget json", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);
    const res = await app.request(api(`/guilds/${gid}/widget.json`));
    expect(res.status).toBe(200);
    const widget = (await res.json()) as { id: string; name: string };
    expect(widget.id).toBe(gid);
    expect(widget.name).toBe("Emulate Server");
  });
});
