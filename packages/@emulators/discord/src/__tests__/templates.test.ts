import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json, seededIds } from "./helpers.js";
import { getDiscordStore } from "../store.js";

function guildId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return seededIds(store).guild;
}

describe("discord guild templates", () => {
  it("creates, lists, gets by code, and creates a new guild from a template", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);

    const created = await json<{ code: string; name: string; source_guild_id: string }>(
      await app.request(api(`/guilds/${gid}/templates`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "Starter", description: "A starter template" }),
      })
    );
    expect(created.name).toBe("Starter");
    expect(created.source_guild_id).toBe(gid);

    const list = await json<Array<{ code: string }>>(await app.request(api(`/guilds/${gid}/templates`), { headers: botHeaders() }));
    expect(list.some((t) => t.code === created.code)).toBe(true);

    const got = await app.request(api(`/guilds/templates/${created.code}`), { headers: botHeaders() });
    expect(got.status).toBe(200);

    const guildsBefore = getDiscordStore(store).guilds.all().length;
    const newGuild = await json<{ id: string; name: string; channels: unknown[] }>(
      await app.request(api(`/guilds/templates/${created.code}`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "My New Server" }),
      })
    );
    expect(newGuild.name).toBe("My New Server");
    expect(getDiscordStore(store).guilds.all().length).toBe(guildsBefore + 1);
    expect((newGuild.channels as unknown[]).length).toBeGreaterThan(0);

    const del = await app.request(api(`/guilds/${gid}/templates/${created.code}`), { method: "DELETE", headers: botHeaders() });
    expect(del.status).toBe(200);
    expect(getDiscordStore(store).guildTemplates.findOneBy("code", created.code)).toBeUndefined();
  });
});
