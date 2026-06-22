import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "./helpers.js";
import { getDiscordStore } from "../store.js";

function guildId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return getDiscordStore(store).guilds.findOneBy("name", "Emulate Server")!.snowflake;
}

describe("discord guild templates", () => {
  it("creates, lists, gets by code, and creates a new guild from a template", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);

    const created = (await (
      await app.request(api(`/guilds/${gid}/templates`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "Starter", description: "A starter template" }),
      })
    ).json()) as { code: string; name: string; source_guild_id: string };
    expect(created.name).toBe("Starter");
    expect(created.source_guild_id).toBe(gid);

    const list = (await (await app.request(api(`/guilds/${gid}/templates`), { headers: botHeaders() })).json()) as Array<{ code: string }>;
    expect(list.some((t) => t.code === created.code)).toBe(true);

    const got = await app.request(api(`/guilds/templates/${created.code}`), { headers: botHeaders() });
    expect(got.status).toBe(200);

    const guildsBefore = getDiscordStore(store).guilds.all().length;
    const newGuild = (await (
      await app.request(api(`/guilds/templates/${created.code}`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "My New Server" }),
      })
    ).json()) as { id: string; name: string; channels: unknown[] };
    expect(newGuild.name).toBe("My New Server");
    expect(getDiscordStore(store).guilds.all().length).toBe(guildsBefore + 1);
    expect((newGuild.channels as unknown[]).length).toBeGreaterThan(0);

    const del = await app.request(api(`/guilds/${gid}/templates/${created.code}`), { method: "DELETE", headers: botHeaders() });
    expect(del.status).toBe(200);
    expect(getDiscordStore(store).guildTemplates.findOneBy("code", created.code)).toBeUndefined();
  });
});
