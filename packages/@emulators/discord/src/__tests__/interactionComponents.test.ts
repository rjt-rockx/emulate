import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, TEST_BASE_URL } from "./helpers.js";
import { getDiscordStore } from "../store.js";

function ctx(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const ds = getDiscordStore(store);
  return {
    ds,
    channel: ds.channels.findOneBy("name", "general")!.snowflake,
    bot: ds.users.findOneBy("username", "emulate-bot")!.snowflake,
  };
}

async function trigger(app: ReturnType<typeof createDiscordTestApp>["app"], input: Record<string, unknown>) {
  const res = await app.request(`${TEST_BASE_URL}/__emulate/interactions`, {
    method: "POST",
    headers: botHeaders(),
    body: JSON.stringify(input),
  });
  return (await res.json()) as { id: string; token: string; interaction: Record<string, unknown> };
}

async function callback(app: ReturnType<typeof createDiscordTestApp>["app"], id: string, token: string, body: unknown) {
  return app.request(api(`/interactions/${id}/${token}/callback`), {
    method: "POST",
    headers: botHeaders(),
    body: JSON.stringify(body),
  });
}

describe("interaction component flows", () => {
  it("button click delivers message context and UpdateMessage edits it", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, channel, bot } = ctx(store);
    const message = ds.messages.insert({
      snowflake: "200000000000000001",
      channel_snowflake: channel,
      guild_snowflake: ds.channels.findOneBy("snowflake", channel)!.guild_snowflake,
      author_snowflake: bot,
      content: "before",
      timestamp: new Date().toISOString(),
      edited_timestamp: null,
      tts: false,
      mention_everyone: false,
      mention_snowflakes: [],
      mention_role_snowflakes: [],
      attachments: [],
      embeds: [],
      components: [{ type: 1, components: [{ type: 2, style: 1, label: "Go", custom_id: "go" }] }],
      pinned: false,
      webhook_snowflake: null,
      type: 0,
      flags: 0,
      nonce: null,
      message_reference: null,
      referenced_message_snowflake: null,
    });

    const t = await trigger(app, { type: 3, customId: "go", componentType: 2, channelSnowflake: channel, messageSnowflake: message.snowflake });
    expect((t.interaction.data as { custom_id: string }).custom_id).toBe("go");
    expect((t.interaction.message as { id: string }).id).toBe(message.snowflake);

    const cb = await callback(app, t.id, t.token, { type: 7, data: { content: "after" } });
    expect(cb.status).toBe(204);
    expect(ds.messages.findOneBy("snowflake", message.snowflake)!.content).toBe("after");
  });

  it("string select carries resolved values", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ctx(store);
    const t = await trigger(app, { type: 3, customId: "pick", componentType: 3, values: ["red", "blue"], channelSnowflake: channel });
    expect((t.interaction.data as { values: string[] }).values).toEqual(["red", "blue"]);

    const cb = await callback(app, t.id, t.token, { type: 4, data: { content: "you picked red and blue" } });
    expect(cb.status).toBe(204);
    expect(getDiscordStore(store).messages.findBy("channel_snowflake", channel).some((m) => m.content.includes("red and blue"))).toBe(true);
  });

  it("modal submit carries its components", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ctx(store);
    const modalComponents = [{ type: 1, components: [{ type: 4, custom_id: "field", value: "hello world" }] }];
    const t = await trigger(app, { type: 5, customId: "feedback", modalComponents, channelSnowflake: channel });
    expect((t.interaction.data as { custom_id: string }).custom_id).toBe("feedback");
    expect((t.interaction.data as { components: unknown[] }).components).toEqual(modalComponents);

    const cb = await callback(app, t.id, t.token, { type: 4, data: { content: "thanks for the feedback" } });
    expect(cb.status).toBe(204);
  });

  it("autocomplete carries focused options and accepts a choices response", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const { channel } = ctx(store);
    const appId = ds.applications.all()[0].snowflake;
    await app.request(api(`/applications/${appId}/commands`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "search", description: "x" }),
    });

    const t = await trigger(app, {
      type: 4,
      commandName: "search",
      commandOptions: [{ name: "q", type: 3, value: "ap", focused: true }],
      channelSnowflake: channel,
    });
    expect((t.interaction.data as { name: string }).name).toBe("search");
    expect((t.interaction.data as { options: Array<{ focused: boolean }> }).options[0].focused).toBe(true);

    const cb = await callback(app, t.id, t.token, { type: 8, data: { choices: [{ name: "apple", value: "apple" }] } });
    expect(cb.status).toBe(204);
  });

  it("rejects a second callback with 40060 (already acknowledged)", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ctx(store);
    const t = await trigger(app, { type: 3, customId: "x", componentType: 2, channelSnowflake: channel });
    const first = await callback(app, t.id, t.token, { type: 4, data: { content: "hi" } });
    expect(first.status).toBe(204);
    const second = await callback(app, t.id, t.token, { type: 4, data: { content: "again" } });
    expect(second.status).toBe(400);
    expect(((await second.json()) as { code: number }).code).toBe(40060);
  });

  it("rejects an unknown interaction id with 10062", async () => {
    const { app } = createDiscordTestApp();
    const res = await callback(app, "999999999999999999", "bogus_token", { type: 4, data: { content: "hi" } });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: number }).code).toBe(10062);
  });

  it("context-menu command resolves target_id and resolved data", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const { channel } = ctx(store);
    const dev = ds.users.findOneBy("username", "developer")!.snowflake;
    const appId = ds.applications.all()[0].snowflake;
    // A USER context-menu command (type 2).
    await app.request(api(`/applications/${appId}/commands`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Report User", type: 2 }),
    });
    const t = await trigger(app, { type: 2, commandName: "Report User", channelSnowflake: channel, targetSnowflake: dev });
    const data = t.interaction.data as { target_id: string; resolved: { users: Record<string, { id: string }> } };
    expect(data.target_id).toBe(dev);
    expect(data.resolved.users[dev].id).toBe(dev);
  });

  it("resolves USER option entities into resolved", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const { channel } = ctx(store);
    const dev = ds.users.findOneBy("username", "developer")!.snowflake;
    const t = await trigger(app, {
      type: 2,
      commandName: "ban",
      channelSnowflake: channel,
      commandOptions: [{ name: "user", type: 6, value: dev }],
    });
    const data = t.interaction.data as { resolved: { users: Record<string, { id: string }> } };
    expect(data.resolved.users[dev].id).toBe(dev);
  });

  it("interaction payload carries context and app_permissions", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ctx(store);
    const t = await trigger(app, { type: 2, commandName: "ping", channelSnowflake: channel });
    const payload = t.interaction as { context: number; app_permissions: string; authorizing_integration_owners: Record<string, string> };
    expect(payload.context).toBe(0);
    expect(typeof payload.app_permissions).toBe("string");
    expect(payload.app_permissions).not.toBe("0");
    expect(payload.authorizing_integration_owners["0"]).toBeTruthy();
  });

  it("modal can be opened as a response to a command (type 9)", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const { channel } = ctx(store);
    const appId = ds.applications.all()[0].snowflake;
    await app.request(api(`/applications/${appId}/commands`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "open", description: "x" }),
    });
    const t = await trigger(app, { type: 2, commandName: "open", channelSnowflake: channel });
    const cb = await callback(app, t.id, t.token, {
      type: 9,
      data: { custom_id: "my_modal", title: "Hi", components: [{ type: 1, components: [{ type: 4, custom_id: "name", label: "Name", style: 1 }] }] },
    });
    expect(cb.status).toBe(204);
    // A modal response must not create a channel message.
    expect(ds.messages.findBy("channel_snowflake", channel).length).toBe(0);
  });
});
