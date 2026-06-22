import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "./helpers.js";
import { getDiscordStore } from "../store.js";
import { createMessage } from "../factories.js";
import { toAPIMessage } from "../helpers.js";

const THUMBS = encodeURIComponent("\u{1F44D}"); // 👍

describe("discord reactions routes", () => {
  it("adds, lists, and removes reactions statefully", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const channel = ds.channels.findOneBy("name", "general")!;
    const bot = ds.users.findOneBy("username", "emulate-bot")!;
    const message = createMessage(ds, {
      channelSnowflake: channel.snowflake,
      guildSnowflake: channel.guild_snowflake,
      authorSnowflake: bot.snowflake,
      content: "react to me",
    });

    const addRes = await app.request(
      api(`/channels/${channel.snowflake}/messages/${message.snowflake}/reactions/${THUMBS}/@me`),
      { method: "PUT", headers: botHeaders() },
    );
    expect(addRes.status).toBe(204);

    const listRes = await app.request(
      api(`/channels/${channel.snowflake}/messages/${message.snowflake}/reactions/${THUMBS}`),
      { headers: botHeaders() },
    );
    const users = (await listRes.json()) as Array<{ id: string }>;
    expect(users.some((u) => u.id === bot.snowflake)).toBe(true);

    const serialized = toAPIMessage(message, ds, bot.snowflake) as { reactions: Array<{ count: number; me: boolean }> };
    expect(serialized.reactions[0].count).toBe(1);
    expect(serialized.reactions[0].me).toBe(true);

    const removeRes = await app.request(
      api(`/channels/${channel.snowflake}/messages/${message.snowflake}/reactions/${THUMBS}/@me`),
      { method: "DELETE", headers: botHeaders() },
    );
    expect(removeRes.status).toBe(204);
    expect(ds.reactions.findBy("message_snowflake", message.snowflake)).toHaveLength(0);
  });

  it("removes all reactions on a message", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const channel = ds.channels.findOneBy("name", "general")!;
    const bot = ds.users.findOneBy("username", "emulate-bot")!;
    const message = createMessage(ds, {
      channelSnowflake: channel.snowflake,
      guildSnowflake: channel.guild_snowflake,
      authorSnowflake: bot.snowflake,
      content: "x",
    });
    await app.request(api(`/channels/${channel.snowflake}/messages/${message.snowflake}/reactions/${THUMBS}/@me`), {
      method: "PUT",
      headers: botHeaders(),
    });
    const res = await app.request(api(`/channels/${channel.snowflake}/messages/${message.snowflake}/reactions`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(204);
    expect(ds.reactions.findBy("message_snowflake", message.snowflake)).toHaveLength(0);
  });
});
