import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "./helpers.js";
import { getDiscordStore } from "../store.js";

function guildId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return getDiscordStore(store).guilds.findOneBy("name", "Emulate Server")!.snowflake;
}

describe("discord stickers", () => {
  it("creates, lists, updates, and deletes a guild sticker", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);
    const stickerForm = new FormData();
    stickerForm.set("name", "blob");
    stickerForm.set("tags", "blobs");
    stickerForm.set("description", "a blob");
    stickerForm.set("file", new File(["png-bytes"], "sticker.png", { type: "image/png" }));
    const created = (await (
      await app.request(api(`/guilds/${gid}/stickers`), {
        method: "POST",
        headers: { Authorization: "Bot test_bot_token" },
        body: stickerForm,
      })
    ).json()) as { id: string; name: string };
    expect(created.name).toBe("blob");

    const list = (await (await app.request(api(`/guilds/${gid}/stickers`), { headers: botHeaders() })).json()) as Array<{ id: string }>;
    expect(list.some((s) => s.id === created.id)).toBe(true);

    const patched = (await (
      await app.request(api(`/guilds/${gid}/stickers/${created.id}`), {
        method: "PATCH",
        headers: botHeaders(),
        body: JSON.stringify({ name: "blob2" }),
      })
    ).json()) as { name: string };
    expect(patched.name).toBe("blob2");

    const del = await app.request(api(`/guilds/${gid}/stickers/${created.id}`), { method: "DELETE", headers: botHeaders() });
    expect(del.status).toBe(204);
    expect(getDiscordStore(store).stickers.findOneBy("snowflake", created.id)).toBeUndefined();
  });
});

describe("discord scheduled events", () => {
  it("creates, gets, updates, and deletes a scheduled event", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);
    const created = (await (
      await app.request(api(`/guilds/${gid}/scheduled-events`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({
          name: "Launch Party",
          scheduled_start_time: "2030-01-01T00:00:00.000Z",
          scheduled_end_time: "2030-01-01T02:00:00.000Z",
          entity_type: 3,
          entity_metadata: { location: "The Internet" },
        }),
      })
    ).json()) as { id: string; name: string; status: number };
    expect(created.name).toBe("Launch Party");
    expect(created.status).toBe(1);

    const got = await app.request(api(`/guilds/${gid}/scheduled-events/${created.id}`), { headers: botHeaders() });
    expect(got.status).toBe(200);

    const patched = (await (
      await app.request(api(`/guilds/${gid}/scheduled-events/${created.id}`), {
        method: "PATCH",
        headers: botHeaders(),
        body: JSON.stringify({ status: 2 }),
      })
    ).json()) as { status: number };
    expect(patched.status).toBe(2);

    const del = await app.request(api(`/guilds/${gid}/scheduled-events/${created.id}`), { method: "DELETE", headers: botHeaders() });
    expect(del.status).toBe(204);
    expect(getDiscordStore(store).scheduledEvents.findOneBy("snowflake", created.id)).toBeUndefined();
  });
});
