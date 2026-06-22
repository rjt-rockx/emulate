import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json, seededIds } from "./helpers.js";
import { getDiscordStore } from "../store.js";

function guildId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return seededIds(store).guild;
}

describe("discord soundboard", () => {
  it("lists default sounds", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/soundboard-default-sounds"), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const sounds = await json<Array<{ name: string }>>(res);
    expect(sounds.length).toBeGreaterThan(0);
  });

  it("creates, lists, updates, and deletes a guild soundboard sound", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);
    // [S-4] `sound` (data uri) is required on Create.
    const created = (await (
      await app.request(api(`/guilds/${gid}/soundboard-sounds`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "airhorn", sound: "data:audio/mpeg;base64,SUQzAAAAAAAB", volume: 0.8 }),
      })
    ).json()) as { sound_id: string; name: string };
    expect(created.name).toBe("airhorn");

    const list = (await (await app.request(api(`/guilds/${gid}/soundboard-sounds`), { headers: botHeaders() })).json()) as { items: Array<{ sound_id: string }> };
    expect(list.items.some((s) => s.sound_id === created.sound_id)).toBe(true);

    const patched = (await (
      await app.request(api(`/guilds/${gid}/soundboard-sounds/${created.sound_id}`), {
        method: "PATCH",
        headers: botHeaders(),
        body: JSON.stringify({ name: "airhorn2" }),
      })
    ).json()) as { name: string };
    expect(patched.name).toBe("airhorn2");

    const del = await app.request(api(`/guilds/${gid}/soundboard-sounds/${created.sound_id}`), { method: "DELETE", headers: botHeaders() });
    expect(del.status).toBe(204);
    expect(getDiscordStore(store).soundboardSounds.findOneBy("snowflake", created.sound_id)).toBeUndefined();
  });
});
