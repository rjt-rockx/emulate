import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json, seededIds } from "./helpers.js";
import { getDiscordStore } from "../store.js";

function ids(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const s = seededIds(store);
  return { guild: s.guild, voice: s.voice };
}

describe("discord stage instances", () => {
  it("creates, gets, updates, and deletes a stage instance", async () => {
    const { app, store } = createDiscordTestApp();
    const { voice } = ids(store);
    const created = await json<{ id: string; topic: string; channel_id: string }>(
      await app.request(api("/stage-instances"), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ channel_id: voice, topic: "Town Hall" }),
      })
    );
    expect(created.topic).toBe("Town Hall");
    expect(created.channel_id).toBe(voice);

    const got = await app.request(api(`/stage-instances/${voice}`), { headers: botHeaders() });
    expect((await json<{ topic: string }>(got)).topic).toBe("Town Hall");

    const patched = await app.request(api(`/stage-instances/${voice}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ topic: "Updated" }),
    });
    expect((await json<{ topic: string }>(patched)).topic).toBe("Updated");

    const del = await app.request(api(`/stage-instances/${voice}`), { method: "DELETE", headers: botHeaders() });
    expect(del.status).toBe(204);
  });
});

describe("discord auto-moderation", () => {
  it("creates, lists, updates, and deletes an automod rule", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const created = await json<{ id: string; name: string; enabled: boolean }>(
      await app.request(api(`/guilds/${guild}/auto-moderation/rules`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: "no spam", event_type: 1, trigger_type: 1, actions: [{ type: 1 }], enabled: true }),
      })
    );
    expect(created.name).toBe("no spam");
    expect(created.enabled).toBe(true);

    const list = await json<Array<{ id: string }>>(await app.request(api(`/guilds/${guild}/auto-moderation/rules`), { headers: botHeaders() }));
    expect(list.some((r) => r.id === created.id)).toBe(true);

    const patched = await json<{ enabled: boolean }>(
      await app.request(api(`/guilds/${guild}/auto-moderation/rules/${created.id}`), {
        method: "PATCH",
        headers: botHeaders(),
        body: JSON.stringify({ enabled: false }),
      })
    );
    expect(patched.enabled).toBe(false);

    const del = await app.request(api(`/guilds/${guild}/auto-moderation/rules/${created.id}`), { method: "DELETE", headers: botHeaders() });
    expect(del.status).toBe(204);
    expect(getDiscordStore(store).autoModRules.findOneBy("snowflake", created.id)).toBeUndefined();
  });
});
