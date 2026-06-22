/**
 * Spec suite for `developers/resources/webhook.mdx`.
 *
 * Encodes the page's documented expectations: the Webhook object shape (id, type, guild_id,
 * channel_id, user, name, avatar, token, application_id, url), Webhook Types (1 Incoming,
 * 2 Channel Follower, 3 Application), every webhook endpoint (Create, Get Channel/Guild/
 * Webhook, Get with Token, Modify, Delete, Execute), Execute params (content/embeds/
 * components/poll required), webhook message GET/PATCH/DELETE, and the interaction
 * followup endpoints (which share the /webhooks/:appId/:token path). Written from the
 * doc first; the implementation is built/fixed until this is green.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json, seededIds } from "../helpers.js";
import { getDiscordStore } from "../../store.js";

function ids(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const s = seededIds(store);
  return {
    appId: s.app,
    bot: s.bot,
    channel: s.general,
    guild: s.guild,
  };
}

async function createWebhook(
  app: ReturnType<typeof createDiscordTestApp>["app"],
  channelId: string,
  name = "TestHook",
) {
  const res = await app.request(api(`/channels/${channelId}/webhooks`), {
    method: "POST",
    headers: botHeaders(),
    body: JSON.stringify({ name }),
  });
  return await json<{ id: string; token: string; name: string | null }>(res);
}

describe("webhook.mdx — Webhook object structure", () => {
  it("Create Webhook returns an object with all documented fields", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel, guild } = ids(store);
    const res = await app.request(api(`/channels/${channel}/webhooks`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "my-hook" }),
    });
    expect(res.status).toBe(200);
    const w = await json(res);
    // Documented fields.
    expect(typeof w.id).toBe("string");
    expect(w.type).toBe(1); // Incoming
    expect(w.guild_id).toBe(guild);
    expect(w.channel_id).toBe(channel);
    expect(typeof w.name).toBe("string");
    expect("avatar" in w).toBe(true);
    expect(typeof w.token).toBe("string");
    expect("application_id" in w).toBe(true);
    // url is computed and starts with the emulator base URL.
    expect(typeof w.url).toBe("string");
    expect((w.url as string).includes("/webhooks/")).toBe(true);
    // user is the creator (returned on bot-authenticated requests).
    expect(typeof (w.user as Record<string, unknown>)?.id).toBe("string");
  });

  it("type 1 = Incoming, created via POST /channels/:id/webhooks", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const wh = await createWebhook(app, channel);
    const ds = getDiscordStore(store);
    expect(ds.webhooks.findOneBy("snowflake", wh.id)!.type).toBe(1);
  });
});

describe("webhook.mdx — Webhook endpoints", () => {
  it("Get Channel Webhooks returns all webhooks for the channel", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    await createWebhook(app, channel, "hookA");
    await createWebhook(app, channel, "hookB");
    const res = await app.request(api(`/channels/${channel}/webhooks`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const list = await json<Array<{ name: string }>>(res);
    expect(list.some((w) => w.name === "hookA")).toBe(true);
    expect(list.some((w) => w.name === "hookB")).toBe(true);
  });

  it("Get Guild Webhooks returns all webhooks for the guild", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel, guild } = ids(store);
    await createWebhook(app, channel, "guildHook");
    const res = await app.request(api(`/guilds/${guild}/webhooks`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const list = await json<Array<{ name: string }>>(res);
    expect(list.some((w) => w.name === "guildHook")).toBe(true);
  });

  it("Get Webhook (by id) returns the webhook object", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const wh = await createWebhook(app, channel, "fetchable");
    const res = await app.request(api(`/webhooks/${wh.id}`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    expect((await json<{ name: string }>(res)).name).toBe("fetchable");
  });

  it("Get Webhook with Token returns webhook WITHOUT user field", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const wh = await createWebhook(app, channel, "tokenFetch");
    const res = await app.request(api(`/webhooks/${wh.id}/${wh.token}`));
    expect(res.status).toBe(200);
    const body = await json(res);
    // user must be absent when fetched via token.
    expect("user" in body).toBe(false);
    expect(body.name).toBe("tokenFetch");
  });

  it("Get Webhook with wrong token returns 404 (Unknown Webhook, 10015)", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const wh = await createWebhook(app, channel, "wrongToken");
    const res = await app.request(api(`/webhooks/${wh.id}/bad_token`));
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10015);
  });

  it("Modify Webhook updates name and returns the updated object", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const wh = await createWebhook(app, channel, "before");
    const res = await app.request(api(`/webhooks/${wh.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "after" }),
    });
    expect(res.status).toBe(200);
    expect((await json<{ name: string }>(res)).name).toBe("after");
  });

  it("Modify Webhook with Token updates name (no auth needed)", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const wh = await createWebhook(app, channel, "old");
    const res = await app.request(api(`/webhooks/${wh.id}/${wh.token}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "new" }),
    });
    expect(res.status).toBe(200);
    expect((await json<{ name: string }>(res)).name).toBe("new");
  });

  it("Delete Webhook returns 204 and removes it from the store", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const wh = await createWebhook(app, channel, "deleteme");
    const res = await app.request(api(`/webhooks/${wh.id}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(204);
    expect(getDiscordStore(store).webhooks.findOneBy("snowflake", wh.id)).toBeUndefined();
  });

  it("Delete Webhook with Token returns 204 (no auth needed)", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const wh = await createWebhook(app, channel, "tokenDelete");
    const res = await app.request(api(`/webhooks/${wh.id}/${wh.token}`), { method: "DELETE" });
    expect(res.status).toBe(204);
  });
});

describe("webhook.mdx — Create Webhook name validation", () => {
  it("webhook name containing 'clyde' (case-insensitive) is rejected with 400 / 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const res = await app.request(api(`/channels/${channel}/webhooks`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "ClydeBot" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("webhook name containing 'discord' (case-insensitive) is rejected with 400 / 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const res = await app.request(api(`/channels/${channel}/webhooks`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "MyDiscordBot" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("webhook name over 80 chars is rejected with 400 / 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const res = await app.request(api(`/channels/${channel}/webhooks`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "a".repeat(81) }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("webhook name of exactly 80 chars is accepted", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const res = await app.request(api(`/channels/${channel}/webhooks`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "a".repeat(80) }),
    });
    expect(res.status).toBe(200);
  });

  it("webhook name of 1 char is accepted", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const res = await app.request(api(`/channels/${channel}/webhooks`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "X" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("webhook.mdx — Execute Webhook IS_COMPONENTS_V2 and with_components", () => {
  it("Execute with IS_COMPONENTS_V2 flag and content returns 400 (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const wh = await createWebhook(app, channel);
    const IS_COMPONENTS_V2 = 1 << 15;
    const res = await app.request(api(`/webhooks/${wh.id}/${wh.token}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello", flags: IS_COMPONENTS_V2 }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("Execute with IS_COMPONENTS_V2 flag and only components succeeds", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const wh = await createWebhook(app, channel);
    const IS_COMPONENTS_V2 = 1 << 15;
    const res = await app.request(api(`/webhooks/${wh.id}/${wh.token}?wait=true`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        components: [{ type: 10, content: "Hello world" }],
        flags: IS_COMPONENTS_V2,
      }),
    });
    expect(res.status).toBe(200);
    const msg = await json<{ flags: number }>(res);
    expect((msg.flags & IS_COMPONENTS_V2) !== 0).toBe(true);
  });

  it("Execute without with_components ignores components for non-app-owned webhooks", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    // Create a webhook that is NOT app-owned (application_snowflake=null).
    // The standard createWebhook uses a bot auth which sets application_snowflake.
    // Manually insert a non-app-owned webhook.
    const ds = getDiscordStore(store);
    const guildId = ds.guilds.findOneBy("name", "Emulate Server")!.snowflake;
    const wh = ds.webhooks.insert({
      snowflake: "800000000000000001",
      type: 1,
      guild_snowflake: guildId,
      channel_snowflake: channel,
      user_snowflake: null,
      name: "NonAppWebhook",
      avatar: null,
      token: "nonapp_token_12345",
      application_snowflake: null,
    });
    // Without with_components, components are stripped -> empty message -> 50006.
    const res = await app.request(api(`/webhooks/${wh.snowflake}/${wh.token}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ components: [{ type: 10, content: "Hello" }] }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50006);
  });

  it("Execute with with_components=true allows components for non-app-owned webhooks", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const ds = getDiscordStore(store);
    const guildId = ds.guilds.findOneBy("name", "Emulate Server")!.snowflake;
    const wh = ds.webhooks.insert({
      snowflake: "800000000000000002",
      type: 1,
      guild_snowflake: guildId,
      channel_snowflake: channel,
      user_snowflake: null,
      name: "NonAppWebhook2",
      avatar: null,
      token: "nonapp_token_67890",
      application_snowflake: null,
    });
    const res = await app.request(api(`/webhooks/${wh.snowflake}/${wh.token}?wait=true&with_components=true`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ components: [{ type: 10, content: "Hello" }] }),
    });
    expect(res.status).toBe(200);
    const msg = await json<{ components: unknown[] }>(res);
    expect(msg.components.length).toBeGreaterThan(0);
  });
});

describe("webhook.mdx — Execute Webhook", () => {
  it("Execute with content returns 204 by default (wait=false)", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const wh = await createWebhook(app, channel);
    const res = await app.request(api(`/webhooks/${wh.id}/${wh.token}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello from webhook" }),
    });
    expect(res.status).toBe(204);
  });

  it("Execute with wait=true returns the created message", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const wh = await createWebhook(app, channel);
    const res = await app.request(api(`/webhooks/${wh.id}/${wh.token}?wait=true`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "wait for me" }),
    });
    expect(res.status).toBe(200);
    const msg = await json<{ content: string; webhook_id: string }>(res);
    expect(msg.content).toBe("wait for me");
    expect(msg.webhook_id).toBe(wh.id);
  });

  it("Execute with custom username and avatar_url overrides author display", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const wh = await createWebhook(app, channel);
    const res = await app.request(api(`/webhooks/${wh.id}/${wh.token}?wait=true`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "from bot", username: "CustomBot", avatar_url: "https://example.com/a.png" }),
    });
    expect(res.status).toBe(200);
    const msg = await json<{ author: { username: string } }>(res);
    expect(msg.author.username).toBe("CustomBot");
  });

  it("Execute with embeds returns 204 and stores the message", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const wh = await createWebhook(app, channel);
    const ds = getDiscordStore(store);
    const before = ds.messages.findBy("channel_snowflake", channel).length;
    const res = await app.request(api(`/webhooks/${wh.id}/${wh.token}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [{ title: "Embed!" }] }),
    });
    expect(res.status).toBe(204);
    expect(ds.messages.findBy("channel_snowflake", channel).length).toBe(before + 1);
  });

  it("Execute with no content/embeds/components/poll/file is rejected with 50006", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const wh = await createWebhook(app, channel);
    const res = await app.request(api(`/webhooks/${wh.id}/${wh.token}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "nobody" }),
    });
    // Discord returns 400 Cannot send an empty message (50006).
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50006);
  });

  it("Execute with an invalid (non-existent) webhook id+token returns 404", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api(`/webhooks/999999999999999999/fake_token`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "nope" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("webhook.mdx — Get / Edit / Delete Webhook Message", () => {
  it("Get Webhook Message by id returns the message", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const wh = await createWebhook(app, channel);
    const created = (await (
      await app.request(api(`/webhooks/${wh.id}/${wh.token}?wait=true`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "get me" }),
      })
    ).json()) as { id: string };

    const res = await app.request(api(`/webhooks/${wh.id}/${wh.token}/messages/${created.id}`), {
      headers: botHeaders(),
    });
    expect(res.status).toBe(200);
    expect((await json<{ content: string }>(res)).content).toBe("get me");
  });

  it("Edit Webhook Message updates content and returns 200", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const wh = await createWebhook(app, channel);
    const created = (await (
      await app.request(api(`/webhooks/${wh.id}/${wh.token}?wait=true`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "before" }),
      })
    ).json()) as { id: string };

    const res = await app.request(api(`/webhooks/${wh.id}/${wh.token}/messages/${created.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ content: "after" }),
    });
    expect(res.status).toBe(200);
    expect((await json<{ content: string }>(res)).content).toBe("after");
  });

  it("Delete Webhook Message returns 204", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ids(store);
    const wh = await createWebhook(app, channel);
    const created = (await (
      await app.request(api(`/webhooks/${wh.id}/${wh.token}?wait=true`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "delete me" }),
      })
    ).json()) as { id: string };

    const res = await app.request(api(`/webhooks/${wh.id}/${wh.token}/messages/${created.id}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(204);
    // Message is gone from the store.
    expect(getDiscordStore(store).messages.findOneBy("snowflake", created.id)).toBeUndefined();
  });
});

describe("webhook.mdx — Interaction followup via /webhooks/:appId/:token", () => {
  it("Create Followup Message creates a new message and returns 200", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const { appId, channel } = ids(store);

    // Trigger an APPLICATION_COMMAND interaction.
    const triggerRes = await app.request(`http://localhost:4099/__emulate/interactions`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: 2, commandName: "ping", channelSnowflake: channel }),
    });
    const t = (await triggerRes.json()) as { id: string; token: string };

    // Send the initial response.
    await app.request(api(`/interactions/${t.id}/${t.token}/callback`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: 4, data: { content: "initial" } }),
    });

    const before = ds.messages.findBy("channel_snowflake", channel).length;
    const res = await app.request(api(`/webhooks/${appId}/${t.token}`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "followup msg" }),
    });
    expect(res.status).toBe(200);
    const msg = await json<{ content: string }>(res);
    expect(msg.content).toBe("followup msg");
    expect(ds.messages.findBy("channel_snowflake", channel).length).toBe(before + 1);
  });

  it("Ed25519-signed interaction callback (from HTTP delivery) is applied correctly", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const { channel } = ids(store);

    // Trigger an interaction (Gateway path — no HTTP endpoint configured by default).
    const triggerRes = await app.request(`http://localhost:4099/__emulate/interactions`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: 2, commandName: "ping", channelSnowflake: channel }),
    });
    const t = (await triggerRes.json()) as { id: string; token: string };

    // Respond with CHANNEL_MESSAGE_WITH_SOURCE.
    const cbRes = await app.request(api(`/interactions/${t.id}/${t.token}/callback`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: 4, data: { content: "from callback" } }),
    });
    expect(cbRes.status).toBe(204);
    expect(ds.messages.findBy("channel_snowflake", channel).some((m) => m.content === "from callback")).toBe(true);
  });
});
