import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "./helpers.js";
import { getDiscordStore } from "../store.js";
import { createMessage } from "../factories.js";

function ids(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const ds = getDiscordStore(store);
  return {
    guild: ds.guilds.findOneBy("name", "Emulate Server")!.snowflake,
    channel: ds.channels.findOneBy("name", "general")!.snowflake,
    developer: ds.users.findOneBy("username", "developer")!.snowflake,
    bot: ds.users.findOneBy("username", "emulate-bot")!.snowflake,
  };
}

describe("discord pins", () => {
  it("pins and unpins a message", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel, bot } = ids(store);
    const ds = getDiscordStore(store);
    const message = createMessage(ds, { channelSnowflake: channel, guildSnowflake: ds.channels.findOneBy("snowflake", channel)!.guild_snowflake, authorSnowflake: bot, content: "pin me" });

    const pinRes = await app.request(api(`/channels/${channel}/pins/${message.snowflake}`), { method: "PUT", headers: botHeaders() });
    expect(pinRes.status).toBe(204);
    expect(ds.messages.findOneBy("snowflake", message.snowflake)!.pinned).toBe(true);

    const list = (await (await app.request(api(`/channels/${channel}/pins`), { headers: botHeaders() })).json()) as Array<{ id: string }>;
    expect(list.some((m) => m.id === message.snowflake)).toBe(true);

    const unpin = await app.request(api(`/channels/${channel}/pins/${message.snowflake}`), { method: "DELETE", headers: botHeaders() });
    expect(unpin.status).toBe(204);
    expect(ds.messages.findOneBy("snowflake", message.snowflake)!.pinned).toBe(false);
  });
});

describe("discord bans", () => {
  it("bans a member, lists the ban, and unbans", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, developer } = ids(store);
    const ds = getDiscordStore(store);

    const banRes = await app.request(api(`/guilds/${guild}/bans/${developer}`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ reason: "spam" }),
    });
    expect(banRes.status).toBe(204);
    // member removed from the guild
    expect(ds.members.findBy("guild_snowflake", guild).some((m) => m.user_snowflake === developer)).toBe(false);

    const list = (await (await app.request(api(`/guilds/${guild}/bans`), { headers: botHeaders() })).json()) as Array<{ user: { id: string }; reason: string }>;
    expect(list.some((b) => b.user.id === developer && b.reason === "spam")).toBe(true);

    const unban = await app.request(api(`/guilds/${guild}/bans/${developer}`), { method: "DELETE", headers: botHeaders() });
    expect(unban.status).toBe(204);
    expect(ds.bans.findBy("guild_snowflake", guild).length).toBe(0);
  });
});

describe("discord invites", () => {
  it("creates, fetches, and deletes an invite", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);

    const created = (await (
      await app.request(api(`/channels/${channel}/invites`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ max_uses: 5, temporary: true }),
      })
    ).json()) as { code: string; max_uses: number };
    expect(created.code).toBeTruthy();
    expect(created.max_uses).toBe(5);

    const fetched = await app.request(api(`/invites/${created.code}`), { headers: botHeaders() });
    expect(fetched.status).toBe(200);
    expect(((await fetched.json()) as { code: string }).code).toBe(created.code);

    const del = await app.request(api(`/invites/${created.code}`), { method: "DELETE", headers: botHeaders() });
    expect(del.status).toBe(200);
    expect(getDiscordStore(store).invites.findOneBy("code", created.code)).toBeUndefined();
  });
});
