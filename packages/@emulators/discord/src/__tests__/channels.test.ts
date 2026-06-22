import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json, seededIds } from "./helpers.js";
import { getDiscordStore } from "../store.js";

function guildId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return seededIds(store).guild;
}

describe("discord channels routes", () => {
  it("lists guild channels including #general", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await app.request(api(`/guilds/${guildId(store)}/channels`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const channels = await json<Array<{ name: string; type: number }>>(res);
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
    const created = await json<{ id: string; name: string }>(createRes);
    expect(created.name).toBe("new-topic");

    const getRes = await app.request(api(`/channels/${created.id}`), { headers: botHeaders() });
    expect(getRes.status).toBe(200);

    const patchRes = await app.request(api(`/channels/${created.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ topic: "updated" }),
    });
    expect((await json<{ topic: string }>(patchRes)).topic).toBe("updated");

    const delRes = await app.request(api(`/channels/${created.id}`), { method: "DELETE", headers: botHeaders() });
    expect(delRes.status).toBe(200);
    const after = await app.request(api(`/channels/${created.id}`), { headers: botHeaders() });
    expect(after.status).toBe(404);
    expect(getDiscordStore(store).channels.findOneBy("snowflake", created.id)).toBeUndefined();
  });

  it("POST typing returns 204", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = seededIds(store);
    const res = await app.request(api(`/channels/${general}/typing`), {
      method: "POST",
      headers: botHeaders(),
    });
    expect(res.status).toBe(204);
  });
});
