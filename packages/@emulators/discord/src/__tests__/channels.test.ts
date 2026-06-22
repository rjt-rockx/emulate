import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "./helpers.js";
import { getDiscordStore } from "../store.js";

function guildId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return getDiscordStore(store).guilds.findOneBy("name", "Emulate Server")!.snowflake;
}

describe("discord channels routes", () => {
  it("lists guild channels including #general", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await app.request(api(`/guilds/${guildId(store)}/channels`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const channels = (await res.json()) as Array<{ name: string; type: number }>;
    expect(channels.some((ch) => ch.name === "general" && ch.type === 0)).toBe(true);
  });

  it("creates, reads, updates, and deletes a channel statefully", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);
    const createRes = await app.request(api(`/guilds/${gid}/channels`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "new-topic", type: 0, topic: "hi" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; name: string };
    expect(created.name).toBe("new-topic");

    const getRes = await app.request(api(`/channels/${created.id}`), { headers: botHeaders() });
    expect(getRes.status).toBe(200);

    const patchRes = await app.request(api(`/channels/${created.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ topic: "updated" }),
    });
    expect(((await patchRes.json()) as { topic: string }).topic).toBe("updated");

    const delRes = await app.request(api(`/channels/${created.id}`), { method: "DELETE", headers: botHeaders() });
    expect(delRes.status).toBe(200);
    const after = await app.request(api(`/channels/${created.id}`), { headers: botHeaders() });
    expect(after.status).toBe(404);
    expect(getDiscordStore(store).channels.findOneBy("snowflake", created.id)).toBeUndefined();
  });

  it("POST typing returns 204", async () => {
    const { app, store } = createDiscordTestApp();
    const general = getDiscordStore(store).channels.findOneBy("name", "general")!;
    const res = await app.request(api(`/channels/${general.snowflake}/typing`), {
      method: "POST",
      headers: botHeaders(),
    });
    expect(res.status).toBe(204);
  });
});
