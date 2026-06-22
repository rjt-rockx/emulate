/**
 * Spec suite for the "extra" endpoints owned by src/routes/extras.ts and src/routes/misc.ts that
 * are not covered by a single primary doc page: channel pins (channel.mdx Pinned Messages), the
 * GitHub/Slack webhook-compatibility execute endpoints (webhook.mdx), guild message search,
 * guild incident-actions, the guild widget image (guild.mdx), embedded activity instances, and
 * the application role-connection delete. Each expectation is encoded from the relevant doc;
 * the implementation is built/fixed until this is green.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json } from "../helpers.js";
import { getDiscordStore } from "../../store.js";
import { getDiscordRuntime } from "../../runtime.js";
import { createMessage } from "../../factories.js";
import { snowflake } from "../../helpers.js";

function ids(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const ds = getDiscordStore(store);
  const app = ds.applications.all()[0]!;
  return {
    ds,
    appId: app.snowflake,
    botSnowflake: app.bot_user_snowflake,
    developer: ds.users.findOneBy("username", "developer")!.snowflake,
    guild: ds.guilds.findOneBy("name", "Emulate Server")!.snowflake,
    textChannel: ds.channels.findOneBy("name", "general")!.snowflake,
  };
}

// ---------------------------------------------------------------------------
// Channel pins
// ---------------------------------------------------------------------------

describe("channel.mdx — pinned messages", () => {
  it("Pin Message returns 204 and the message shows up in Get Pinned Messages", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, guild, textChannel, developer } = ids(store);
    const msg = createMessage(ds, {
      channelSnowflake: textChannel,
      guildSnowflake: guild,
      authorSnowflake: developer,
      content: "pin me",
    });
    const pin = await app.request(api(`/channels/${textChannel}/pins/${msg.snowflake}`), {
      method: "PUT",
      headers: botHeaders(),
    });
    expect(pin.status).toBe(204);

    const list = await app.request(api(`/channels/${textChannel}/pins`), { headers: botHeaders() });
    expect(list.status).toBe(200);
    const pinned = (await list.json()) as Array<Record<string, unknown>>;
    expect(pinned.some((m) => m.id === msg.snowflake)).toBe(true);
  });

  it("Unpin Message returns 204 and removes it from the pinned list", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, guild, textChannel, developer } = ids(store);
    const msg = createMessage(ds, {
      channelSnowflake: textChannel,
      guildSnowflake: guild,
      authorSnowflake: developer,
      content: "pin then unpin",
    });
    await app.request(api(`/channels/${textChannel}/pins/${msg.snowflake}`), { method: "PUT", headers: botHeaders() });
    const unpin = await app.request(api(`/channels/${textChannel}/pins/${msg.snowflake}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(unpin.status).toBe(204);
    const pinned = (await (await app.request(api(`/channels/${textChannel}/pins`), { headers: botHeaders() })).json()) as Array<
      Record<string, unknown>
    >;
    expect(pinned.some((m) => m.id === msg.snowflake)).toBe(false);
  });

  it("Pin Message for an unknown message returns 404 Unknown Message (10008)", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel } = ids(store);
    const res = await app.request(api(`/channels/${textChannel}/pins/999999999999999999`), {
      method: "PUT",
      headers: botHeaders(),
    });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10008);
  });

  it("Get Pinned Messages requires authorization (401)", async () => {
    const { app, store } = createDiscordTestApp();
    const { textChannel } = ids(store);
    const res = await app.request(api(`/channels/${textChannel}/pins`));
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GitHub / Slack webhook compatibility execute endpoints
// ---------------------------------------------------------------------------

describe("webhook.mdx — GitHub / Slack compatible execute", () => {
  function seedWebhook(store: ReturnType<typeof createDiscordTestApp>["store"]) {
    const ds = getDiscordStore(store);
    const channel = ds.channels.findOneBy("name", "general")!;
    return ds.webhooks.insert({
      snowflake: snowflake(),
      type: 1,
      guild_snowflake: channel.guild_snowflake,
      channel_snowflake: channel.snowflake,
      user_snowflake: ds.applications.all()[0]!.bot_user_snowflake,
      name: "CI Hook",
      avatar: null,
      token: "whk_secret",
      application_snowflake: ds.applications.all()[0]!.snowflake,
    });
  }

  it("POST .../github returns 204 without wait", async () => {
    const { app, store } = createDiscordTestApp();
    const wh = seedWebhook(store);
    const res = await app.request(api(`/webhooks/${wh.snowflake}/${wh.token}/github`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "opened", repository: { full_name: "octo/repo" } }),
    });
    expect(res.status).toBe(204);
  });

  it("POST .../github?wait=true returns the created message object", async () => {
    const { app, store } = createDiscordTestApp();
    const wh = seedWebhook(store);
    const res = await app.request(api(`/webhooks/${wh.snowflake}/${wh.token}/github?wait=true`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "opened", repository: { full_name: "octo/repo" } }),
    });
    expect(res.status).toBe(200);
    const msg = await json(res);
    expect(typeof msg.id).toBe("string");
    expect(String(msg.content)).toContain("octo/repo");
  });

  it("POST .../slack delivers the text content and returns the message with wait=true", async () => {
    const { app, store } = createDiscordTestApp();
    const wh = seedWebhook(store);
    const res = await app.request(api(`/webhooks/${wh.snowflake}/${wh.token}/slack?wait=true`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello from slack" }),
    });
    expect(res.status).toBe(200);
    const msg = await json(res);
    expect(msg.content).toBe("hello from slack");
  });

  it("a bad token with wait=true returns 404", async () => {
    const { app, store } = createDiscordTestApp();
    const wh = seedWebhook(store);
    const res = await app.request(api(`/webhooks/${wh.snowflake}/wrong-token/github?wait=true`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Guild message search
// ---------------------------------------------------------------------------

describe("guild message search", () => {
  it("returns grouped matches and a total_results count, filtered by content", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, guild, textChannel, developer } = ids(store);
    createMessage(ds, { channelSnowflake: textChannel, guildSnowflake: guild, authorSnowflake: developer, content: "needle here" });
    createMessage(ds, { channelSnowflake: textChannel, guildSnowflake: guild, authorSnowflake: developer, content: "unrelated" });
    const res = await app.request(api(`/guilds/${guild}/messages/search?content=needle`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = await json<{ messages: Array<Array<Record<string, unknown>>>; total_results: number }>(res);
    expect(body.total_results).toBe(1);
    // Each match is a one-element array (the matched message), per Discord's grouped search shape.
    expect(Array.isArray(body.messages[0])).toBe(true);
    expect(body.messages[0][0].content).toBe("needle here");
  });

  it("search on an unknown guild returns 404", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/guilds/999999999999999999/messages/search"), { headers: botHeaders() });
    expect(res.status).toBe(404);
  });

  it("search requires authorization (401)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/messages/search`));
    expect(res.status).toBe(401);
  });

  it("[M2] response always includes doing_deep_historical_index: false and no reactions key", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, guild, textChannel, developer } = ids(store);
    createMessage(ds, { channelSnowflake: textChannel, guildSnowflake: guild, authorSnowflake: developer, content: "check-m2" });
    const res = await app.request(api(`/guilds/${guild}/messages/search?content=check-m2`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = await json<{ messages: Array<Array<Record<string, unknown>>>; doing_deep_historical_index: boolean }>(res);
    expect(body.doing_deep_historical_index).toBe(false);
    // reactions key must be stripped from each message.
    expect("reactions" in body.messages[0][0]).toBe(false);
  });

  it("[M3] respects limit (default 25, max 25) and offset", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, guild, textChannel, developer } = ids(store);
    for (let i = 0; i < 30; i++) {
      createMessage(ds, { channelSnowflake: textChannel, guildSnowflake: guild, authorSnowflake: developer, content: `paged-msg-${i}` });
    }
    // Default limit is 25.
    const res1 = await app.request(api(`/guilds/${guild}/messages/search?content=paged-msg`), { headers: botHeaders() });
    const body1 = await json<{ messages: unknown[]; total_results: number }>(res1);
    expect(body1.messages.length).toBe(25);
    expect(body1.total_results).toBe(30);
    // Explicit limit capped at 25.
    const res2 = await app.request(api(`/guilds/${guild}/messages/search?content=paged-msg&limit=10`), { headers: botHeaders() });
    const body2 = await json<{ messages: unknown[] }>(res2);
    expect(body2.messages.length).toBe(10);
    // Offset skips results.
    const res3 = await app.request(api(`/guilds/${guild}/messages/search?content=paged-msg&offset=25`), { headers: botHeaders() });
    const body3 = await json<{ messages: unknown[] }>(res3);
    expect(body3.messages.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Guild incident actions
// ---------------------------------------------------------------------------

describe("guild.mdx — incident actions", () => {
  it("PUT incident-actions echoes invites_disabled_until / dms_disabled_until and includes detection fields", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const until = "2099-01-01T00:00:00.000Z";
    const res = await app.request(api(`/guilds/${guild}/incident-actions`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ invites_disabled_until: until, dms_disabled_until: until }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.invites_disabled_until).toBe(until);
    expect(body.dms_disabled_until).toBe(until);
    expect("dm_spam_detected_at" in body).toBe(true);
    expect("raid_detected_at" in body).toBe(true);
  });

  it("incident-actions on an unknown guild returns 404", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/guilds/999999999999999999/incident-actions"), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("incidents_data written by PUT round-trips on GET /guilds/:id (guild.mdx: incidents_data field)", async () => {
    // The PUT must persist onto the guild entity so subsequent GET /guilds/:id reflects it.
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const until = "2099-06-01T12:00:00.000Z";
    await app.request(api(`/guilds/${guild}/incident-actions`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ invites_disabled_until: until }),
    });
    const getRes = await app.request(api(`/guilds/${guild}`), { headers: botHeaders() });
    expect(getRes.status).toBe(200);
    const g = (await getRes.json()) as { incidents_data?: Record<string, unknown> | null };
    expect(g.incidents_data).toBeTruthy();
    expect((g.incidents_data as Record<string, unknown>).invites_disabled_until).toBe(until);
  });
});

// ---------------------------------------------------------------------------
// Guild widget image
// ---------------------------------------------------------------------------

describe("guild.mdx — widget image", () => {
  it("GET widget.png returns image/png bytes for a known guild", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/widget.png`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // PNG magic number.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("widget.png on an unknown guild returns 404", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/guilds/999999999999999999/widget.png"));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Embedded activity instance
// ---------------------------------------------------------------------------

describe("application — get activity instance", () => {
  it("returns an activity instance with application_id, instance_id, location and users", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId } = ids(store);
    const res = await app.request(api(`/applications/${appId}/activity-instances/abc123`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.application_id).toBe(appId);
    expect(body.instance_id).toBe("abc123");
    expect(body.location).toBeDefined();
    expect(Array.isArray(body.users)).toBe(true);
  });

  it("requires authorization (401)", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId } = ids(store);
    const res = await app.request(api(`/applications/${appId}/activity-instances/abc123`));
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Delete application role connection
// ---------------------------------------------------------------------------

describe("user.mdx — delete application role connection (misc.ts)", () => {
  it("DELETE /users/@me/applications/{app}/role-connection returns 204", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId } = ids(store);
    const res = await app.request(api(`/users/@me/applications/${appId}/role-connection`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(204);
  });

  it("requires authorization (401)", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId } = ids(store);
    const res = await app.request(api(`/users/@me/applications/${appId}/role-connection`), { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Scheduled event subscribers (misc.ts variant returns an empty roster)
// ---------------------------------------------------------------------------

describe("scheduled event subscribers", () => {
  it("unknown event returns 404", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/scheduled-events/999999999999999999/users`), {
      headers: botHeaders(),
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// B1: GET /guilds/:id/bans?limit=0 must return an empty array (not 1000 bans)
// ---------------------------------------------------------------------------

describe("guild.mdx — Get Guild Bans limit=0 (B1 conformance)", () => {
  it("B1: limit=0 returns an empty array of bans, not the full ban list", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, guild, developer } = ids(store);
    // Ban the developer so there is at least one ban to potentially leak.
    await app.request(api(`/guilds/${guild}/bans/${developer}`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({}),
    });
    const bans = ds.guilds.findOneBy("snowflake", guild)!;
    expect(bans).toBeDefined();

    const res = await app.request(api(`/guilds/${guild}/bans?limit=0`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const list = await json<unknown[]>(res);
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// B6: CHANNEL_PINS_UPDATE last_pin_timestamp is null after the last pin is removed
// ---------------------------------------------------------------------------

describe("channel.mdx — CHANNEL_PINS_UPDATE last_pin_timestamp (B6 conformance)", () => {
  it("B6: unpinning the last message sends CHANNEL_PINS_UPDATE with null last_pin_timestamp", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, textChannel } = ids(store);
    // Create and pin a message.
    const msg = createMessage(ds, {
      channelSnowflake: textChannel,
      guildSnowflake: ds.guilds.all()[0]!.snowflake,
      authorSnowflake: ds.users.findOneBy("username", "developer")!.snowflake,
      content: "pin me",
    });
    await app.request(api(`/channels/${textChannel}/pins/${msg.snowflake}`), {
      method: "PUT",
      headers: botHeaders(),
    });

    // Now capture events for the unpin (DELETE).
    const events: Array<{ t: string; d: unknown }> = [];
    const unsub = getDiscordRuntime(store).bus.subscribe((e) => events.push(e));
    await app.request(api(`/channels/${textChannel}/pins/${msg.snowflake}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    unsub();

    const pinsUpdate = events.find((e) => e.t === "CHANNEL_PINS_UPDATE");
    expect(pinsUpdate).toBeDefined();
    const d = pinsUpdate!.d as Record<string, unknown>;
    // B6: After removing the last pin, last_pin_timestamp should be null.
    expect(d.last_pin_timestamp).toBeNull();
  });

  it("B6: unpinning one of two pins sends CHANNEL_PINS_UPDATE with the remaining pin's timestamp", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, textChannel } = ids(store);
    const guild = ds.guilds.all()[0]!.snowflake;
    const author = ds.users.findOneBy("username", "developer")!.snowflake;
    // Pin two messages.
    const msg1 = createMessage(ds, { channelSnowflake: textChannel, guildSnowflake: guild, authorSnowflake: author, content: "first" });
    const msg2 = createMessage(ds, { channelSnowflake: textChannel, guildSnowflake: guild, authorSnowflake: author, content: "second" });
    await app.request(api(`/channels/${textChannel}/pins/${msg1.snowflake}`), { method: "PUT", headers: botHeaders() });
    await app.request(api(`/channels/${textChannel}/pins/${msg2.snowflake}`), { method: "PUT", headers: botHeaders() });

    // Unpin only msg1; msg2 remains pinned.
    const events: Array<{ t: string; d: unknown }> = [];
    const unsub = getDiscordRuntime(store).bus.subscribe((e) => events.push(e));
    await app.request(api(`/channels/${textChannel}/pins/${msg1.snowflake}`), { method: "DELETE", headers: botHeaders() });
    unsub();

    const pinsUpdate = events.find((e) => e.t === "CHANNEL_PINS_UPDATE");
    expect(pinsUpdate).toBeDefined();
    const d = pinsUpdate!.d as Record<string, unknown>;
    // B6: last_pin_timestamp must be non-null when a pin remains.
    expect(d.last_pin_timestamp).not.toBeNull();
    expect(typeof d.last_pin_timestamp).toBe("string");
  });
});
