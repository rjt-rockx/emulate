import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json, seededIds } from "./helpers.js";
import { getDiscordStore } from "../store.js";

function ids(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const s = seededIds(store);
  return { guild: s.guild, general: s.general, app: s.app, bot: s.bot };
}

describe("webhook platform compatibility", () => {
  it("executes a GitHub-format webhook and creates a message", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const hook = await json<{ id: string; token: string }>(await app.request(api(`/channels/${general}/webhooks`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "ci" }),
    }));

    const res = await app.request(api(`/webhooks/${hook.id}/${hook.token}/github?wait=true`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ action: "opened", repository: { full_name: "octo/repo" } }),
    });
    expect(res.status).toBe(200);
    expect((await json<{ content: string }>(res)).content).toContain("octo/repo");
  });

  it("executes a Slack-format webhook (204 without wait)", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const hook = await json<{ id: string; token: string }>(await app.request(api(`/channels/${general}/webhooks`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "slk" }),
    }));
    const res = await app.request(api(`/webhooks/${hook.id}/${hook.token}/slack`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ text: "hello from slack" }),
    });
    expect(res.status).toBe(204);
    expect(getDiscordStore(store).messages.findBy("channel_snowflake", general).some((m) => m.content === "hello from slack")).toBe(true);
  });
});

describe("misc documented endpoints", () => {
  it("searches guild messages", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, general } = ids(store);
    await app.request(api(`/channels/${general}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "needle in haystack" }),
    });
    const res = await app.request(api(`/guilds/${guild}/messages/search?content=needle`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = await json<{ messages: unknown[][]; total_results: number }>(res);
    expect(body.total_results).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.messages[0])).toBe(true);
  });

  it("sets guild incident actions statefully", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const until = new Date(Date.now() + 3600_000).toISOString();
    const res = await app.request(api(`/guilds/${guild}/incident-actions`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ invites_disabled_until: until }),
    });
    expect(res.status).toBe(200);
    expect((await json<{ invites_disabled_until: string }>(res)).invites_disabled_until).toBe(until);
    // Verify persistence: the incidents_data is now stored on the guild entity (not the side-channel).
    const ds = getDiscordStore(store);
    const guildEntity = ds.guilds.findOneBy("snowflake", guild)!;
    expect((guildEntity.incidents_data as { invites_disabled_until: string } | undefined)?.invites_disabled_until).toBe(until);
  });

  it("returns a widget png with the right content type", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/widget.png`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
  });

  it("returns an empty scheduled-event roster", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const { guild } = ids(store);
    const event = ds.scheduledEvents.insert({
      snowflake: "900000000000000001",
      guild_snowflake: guild,
      channel_snowflake: null,
      creator_snowflake: null,
      name: "Launch",
      description: null,
      scheduled_start_time: new Date().toISOString(),
      scheduled_end_time: null,
      privacy_level: 2,
      status: 1,
      entity_type: 3,
      user_count: 0,
    });
    const res = await app.request(api(`/guilds/${guild}/scheduled-events/${event.snowflake}/users`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toEqual([]);
  });

  it("returns an activity instance and invite target users", async () => {
    const { app, store } = createDiscordTestApp();
    const { app: appId } = ids(store);
    const inst = await app.request(api(`/applications/${appId}/activity-instances/abc`), { headers: botHeaders() });
    expect((await json<{ instance_id: string }>(inst)).instance_id).toBe("abc");
    const targets = await app.request(api(`/invites/xyz/target-users`), { headers: botHeaders() });
    expect((await json<{ target_users: unknown[] }>(targets)).target_users).toEqual([]);
  });
});

describe("archived threads", () => {
  it("lists public archived threads under a channel", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const thread = await json<{ id: string }>(await app.request(api(`/channels/${general}/threads`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "old-thread", type: 11 }),
    }));

    // Archive it.
    await app.request(api(`/channels/${thread.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ archived: true }),
    });

    const res = await app.request(api(`/channels/${general}/threads/archived/public`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = await json<{ threads: Array<{ id: string }>; has_more: boolean }>(res);
    expect(body.threads.some((t) => t.id === thread.id)).toBe(true);
  });
});
