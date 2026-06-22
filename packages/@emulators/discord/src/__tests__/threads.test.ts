import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json, seededIds } from "./helpers.js";
import { getDiscordStore } from "../store.js";
import { createMessage } from "../factories.js";

function channelId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return seededIds(store).general;
}

describe("discord threads", () => {
  it("creates a standalone thread, lists active threads, and archives it", async () => {
    const { app, store } = createDiscordTestApp();
    const parent = channelId(store);
    const created = await json<{ id: string; type: number; parent_id: string; thread_metadata: { archived: boolean } }>(
      await app.request(api(`/channels/${parent}/threads`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "help-thread", type: 11 }),
      })
    );
    expect(created.type).toBe(11);
    expect(created.parent_id).toBe(parent);
    expect(created.thread_metadata.archived).toBe(false);

    const gid = getDiscordStore(store).guilds.findOneBy("name", "Emulate Server")!.snowflake;
    const active = await json<{
      threads: Array<{ id: string }>;
    }>(await app.request(api(`/guilds/${gid}/threads/active`), { headers: botHeaders() }));
    expect(active.threads.some((t) => t.id === created.id)).toBe(true);

    // archive via PATCH -> THREAD_UPDATE, removed from active list
    const patched = await json<{ thread_metadata: { archived: boolean } }>(
      await app.request(api(`/channels/${created.id}`), {
        method: "PATCH",
        headers: botHeaders(),
        body: JSON.stringify({ archived: true }),
      })
    );
    expect(patched.thread_metadata.archived).toBe(true);
    const active2 = await json<{
      threads: Array<{ id: string }>;
    }>(await app.request(api(`/guilds/${gid}/threads/active`), { headers: botHeaders() }));
    expect(active2.threads.some((t) => t.id === created.id)).toBe(false);
  });

  it("creates a thread from a message and manages members", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const parent = channelId(store);
    const bot = ds.users.findOneBy("username", "emulate-bot")!;
    const developer = ds.users.findOneBy("username", "developer")!;
    const message = createMessage(ds, { channelSnowflake: parent, guildSnowflake: ds.channels.findOneBy("snowflake", parent)!.guild_snowflake, authorSnowflake: bot.snowflake, content: "root" });

    const thread = await json<{ id: string; member_count: number }>(
      await app.request(api(`/channels/${parent}/messages/${message.snowflake}/threads`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "from-message" }),
      })
    );
    expect(thread.member_count).toBe(1); // creator auto-joined

    const add = await app.request(api(`/channels/${thread.id}/thread-members/${developer.snowflake}`), { method: "PUT", headers: botHeaders() });
    expect(add.status).toBe(204);
    const members = await json<Array<{ user_id: string }>>(await app.request(api(`/channels/${thread.id}/thread-members`), { headers: botHeaders() }));
    expect(members.some((m) => m.user_id === developer.snowflake)).toBe(true);

    const remove = await app.request(api(`/channels/${thread.id}/thread-members/${developer.snowflake}`), { method: "DELETE", headers: botHeaders() });
    expect(remove.status).toBe(204);
    expect(ds.threadMembers.findBy("thread_snowflake", thread.id).some((m) => m.user_snowflake === developer.snowflake)).toBe(false);
  });
});
