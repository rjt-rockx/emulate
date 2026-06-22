import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "./helpers.js";
import { getDiscordStore } from "../store.js";

function generalId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return getDiscordStore(store).channels.findOneBy("name", "general")!.snowflake;
}

describe("discord messages routes", () => {
  it("creates a message authored by the bot and persists it", async () => {
    const { app, store } = createDiscordTestApp();
    const channelId = generalId(store);
    const res = await app.request(api(`/channels/${channelId}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "hello world" }),
    });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as { id: string; content: string; author: { bot: boolean }; channel_id: string };
    expect(typeof msg.id).toBe("string");
    expect(msg.content).toBe("hello world");
    expect(msg.author.bot).toBe(true);
    expect(msg.channel_id).toBe(channelId);
    expect(getDiscordStore(store).messages.findOneBy("snowflake", msg.id)).toBeTruthy();
  });

  it("lists, gets, edits, and deletes messages statefully", async () => {
    const { app, store } = createDiscordTestApp();
    const channelId = generalId(store);
    const created = (await (
      await app.request(api(`/channels/${channelId}/messages`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ content: "first" }),
      })
    ).json()) as { id: string };

    const list = (await (
      await app.request(api(`/channels/${channelId}/messages`), { headers: botHeaders() })
    ).json()) as Array<{ id: string }>;
    expect(list.some((m) => m.id === created.id)).toBe(true);

    const getRes = await app.request(api(`/channels/${channelId}/messages/${created.id}`), { headers: botHeaders() });
    expect(getRes.status).toBe(200);

    const editRes = await app.request(api(`/channels/${channelId}/messages/${created.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ content: "edited" }),
    });
    const edited = (await editRes.json()) as { content: string; edited_timestamp: string | null };
    expect(edited.content).toBe("edited");
    expect(edited.edited_timestamp).toBeTruthy();

    const delRes = await app.request(api(`/channels/${channelId}/messages/${created.id}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(delRes.status).toBe(204);
    const after = await app.request(api(`/channels/${channelId}/messages/${created.id}`), { headers: botHeaders() });
    expect(after.status).toBe(404);
  });

  it("parses user mentions and @everyone", async () => {
    const { app, store } = createDiscordTestApp();
    const channelId = generalId(store);
    const dev = getDiscordStore(store).users.findOneBy("username", "developer")!;
    const res = await app.request(api(`/channels/${channelId}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: `hi <@${dev.snowflake}> and @everyone` }),
    });
    const msg = (await res.json()) as { mentions: Array<{ id: string }>; mention_everyone: boolean };
    expect(msg.mention_everyone).toBe(true);
    expect(msg.mentions.some((u) => u.id === dev.snowflake)).toBe(true);
  });
});
