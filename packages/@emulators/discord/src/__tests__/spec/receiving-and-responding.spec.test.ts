/**
 * Spec suite for `developers/interactions/receiving-and-responding.mdx`.
 *
 * Encodes the page's documented expectations: the Interaction object shape and Interaction
 * Types (1-5), every Interaction Callback Type (PONG 1, CHANNEL_MESSAGE_WITH_SOURCE 4,
 * DEFERRED 5/6, UPDATE_MESSAGE 7, AUTOCOMPLETE_RESULT 8, MODAL 9, PREMIUM_REQUIRED 10,
 * LAUNCH_ACTIVITY 12), the Interaction Callback Response (with_response shape incl.
 * resource.message), deferred loading placeholders registered as @original, followup
 * messages, and the @original get/edit/delete endpoints. Written from the doc first;
 * the implementation is built/fixed until this is green.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, TEST_BASE_URL } from "../helpers.js";
import { getDiscordStore } from "../../store.js";

function ctx(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const ds = getDiscordStore(store);
  return {
    ds,
    appId: ds.applications.all()[0]!.snowflake,
    channel: ds.channels.findOneBy("name", "general")!.snowflake,
    bot: ds.applications.all()[0]!.bot_user_snowflake,
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

function callback(
  app: ReturnType<typeof createDiscordTestApp>["app"],
  id: string,
  token: string,
  body: unknown,
  query = "",
) {
  return app.request(api(`/interactions/${id}/${token}/callback${query}`), {
    method: "POST",
    headers: botHeaders(),
    body: JSON.stringify(body),
  });
}

describe("receiving-and-responding.mdx — Interaction object & types", () => {
  it("APPLICATION_COMMAND (type 2) interaction carries id/application_id/type/token/version=1/data/locale", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ctx(store);
    const t = await trigger(app, { type: 2, commandName: "ping", channelSnowflake: channel });
    const p = t.interaction as Record<string, unknown>;
    expect(typeof p.id).toBe("string");
    expect(typeof p.application_id).toBe("string");
    expect(p.type).toBe(2);
    expect(typeof p.token).toBe("string");
    expect(p.version).toBe(1);
    expect(p.locale).toBe("en-US");
    expect(typeof p.data).toBe("object");
    // app_permissions is a serialized bitfield string.
    expect(typeof p.app_permissions).toBe("string");
    // entitlements present as an array.
    expect(Array.isArray(p.entitlements)).toBe(true);
    // attachment_size_limit present as a number.
    expect(typeof p.attachment_size_limit).toBe("number");
  });

  it("a guild interaction carries member (with user), guild_id and context GUILD (0)", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ctx(store);
    const t = await trigger(app, { type: 2, commandName: "ping", channelSnowflake: channel });
    const p = t.interaction as { member?: { user?: { id: string } }; guild_id?: string; context: number; guild_locale?: string };
    expect(p.guild_id).toBeTruthy();
    expect(p.member?.user?.id).toBeTruthy();
    expect(p.context).toBe(0);
    expect(p.guild_locale).toBe("en-US");
  });

  it("the APPLICATION_COMMAND data carries id/name/type", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, appId, channel } = ctx(store);
    await app.request(api(`/applications/${appId}/commands`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "cardsearch", description: "x" }),
    });
    const t = await trigger(app, {
      type: 2,
      commandName: "cardsearch",
      channelSnowflake: channel,
      commandOptions: [{ type: 3, name: "cardname", value: "The Gitrog Monster" }],
    });
    const data = t.interaction.data as { id: string; name: string; type: number; options: unknown[] };
    expect(data.name).toBe("cardsearch");
    expect(data.type).toBe(1);
    // The data.id is the registered command's snowflake.
    expect(data.id).toBe(ds.commands.findOneBy("name", "cardsearch")!.snowflake);
    expect(data.options).toEqual([{ type: 3, name: "cardname", value: "The Gitrog Monster" }]);
  });

  it("MESSAGE_COMPONENT (type 3) carries custom_id and component_type, plus the attached message", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, channel, bot } = ctx(store);
    const message = ds.messages.insert({
      snowflake: "300000000000000001",
      channel_snowflake: channel,
      guild_snowflake: ds.channels.findOneBy("snowflake", channel)!.guild_snowflake,
      author_snowflake: bot,
      content: "with button",
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
    const t = await trigger(app, {
      type: 3,
      customId: "go",
      componentType: 2,
      channelSnowflake: channel,
      messageSnowflake: message.snowflake,
    });
    const data = t.interaction.data as { custom_id: string; component_type: number };
    expect(data.custom_id).toBe("go");
    expect(data.component_type).toBe(2);
    expect((t.interaction.message as { id: string }).id).toBe(message.snowflake);
  });

  it("MODAL_SUBMIT (type 5) carries custom_id and components", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ctx(store);
    const modalComponents = [{ type: 1, components: [{ type: 4, custom_id: "field", value: "hi" }] }];
    const t = await trigger(app, { type: 5, customId: "feedback", modalComponents, channelSnowflake: channel });
    const data = t.interaction.data as { custom_id: string; components: unknown[] };
    expect(data.custom_id).toBe("feedback");
    expect(data.components).toEqual(modalComponents);
  });
});

describe("receiving-and-responding.mdx — Create Interaction Response (callback types)", () => {
  it("CHANNEL_MESSAGE_WITH_SOURCE (4) creates a message and returns 204 without with_response", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, channel } = ctx(store);
    const t = await trigger(app, { type: 2, commandName: "ping", channelSnowflake: channel });
    const res = await callback(app, t.id, t.token, { type: 4, data: { content: "pong" } });
    expect(res.status).toBe(204);
    expect(ds.messages.findBy("channel_snowflake", channel).some((m) => m.content === "pong")).toBe(true);
  });

  it("with_response=true returns 200 with interaction.{id,type} and resource.{type,message}", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ctx(store);
    const t = await trigger(app, { type: 2, commandName: "ping", channelSnowflake: channel });
    const res = await callback(app, t.id, t.token, { type: 4, data: { content: "hello" } }, "?with_response=true");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      interaction: { id: string; type: number; response_message_id?: string; response_message_ephemeral?: boolean };
      resource: { type: number; message: { id: string; content: string } };
    };
    expect(body.interaction.id).toBe(t.id);
    expect(body.interaction.type).toBe(2);
    expect(body.interaction.response_message_id).toBeTruthy();
    expect(body.interaction.response_message_ephemeral).toBe(false);
    // resource.type is the callback type, resource.message is the created message.
    expect(body.resource.type).toBe(4);
    expect(body.resource.message.content).toBe("hello");
    expect(body.resource.message.id).toBe(body.interaction.response_message_id);
  });

  it("with_response=true reports response_message_ephemeral=true for ephemeral (flag 64) responses", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ctx(store);
    const t = await trigger(app, { type: 2, commandName: "ping", channelSnowflake: channel });
    const res = await callback(app, t.id, t.token, { type: 4, data: { content: "secret", flags: 64 } }, "?with_response=true");
    const body = (await res.json()) as { interaction: { response_message_ephemeral: boolean } };
    expect(body.interaction.response_message_ephemeral).toBe(true);
  });

  it("DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (5) creates a loading placeholder registered as @original", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId, channel } = ctx(store);
    const t = await trigger(app, { type: 2, commandName: "ping", channelSnowflake: channel });
    const res = await callback(app, t.id, t.token, { type: 5 });
    expect(res.status).toBe(204);
    // @original now resolves to the loading placeholder message.
    const original = await app.request(api(`/webhooks/${appId}/${t.token}/messages/@original`), { headers: botHeaders() });
    expect(original.status).toBe(200);
    const msg = (await original.json()) as { id: string; flags: number };
    // Loading flag (1 << 7 = 128) is set on the placeholder.
    expect((msg.flags & 128) !== 0).toBe(true);
  });

  it("DEFERRED then Edit Original Interaction Response edits the placeholder in place", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId, channel } = ctx(store);
    const t = await trigger(app, { type: 2, commandName: "ping", channelSnowflake: channel });
    await callback(app, t.id, t.token, { type: 5 });
    const edit = await app.request(api(`/webhooks/${appId}/${t.token}/messages/@original`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ content: "done thinking" }),
    });
    expect(edit.status).toBe(200);
    expect(((await edit.json()) as { content: string }).content).toBe("done thinking");
  });

  it("UPDATE_MESSAGE (7) edits the component message in place", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, channel, bot } = ctx(store);
    const message = ds.messages.insert({
      snowflake: "300000000000000002",
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
    const res = await callback(app, t.id, t.token, { type: 7, data: { content: "after" } });
    expect(res.status).toBe(204);
    expect(ds.messages.findOneBy("snowflake", message.snowflake)!.content).toBe("after");
  });

  it("AUTOCOMPLETE_RESULT (8) accepts choices and returns 204", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId, channel } = ctx(store);
    await app.request(api(`/applications/${appId}/commands`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "search", description: "x" }),
    });
    const t = await trigger(app, {
      type: 4,
      commandName: "search",
      channelSnowflake: channel,
      commandOptions: [{ name: "q", type: 3, value: "ap", focused: true }],
    });
    const res = await callback(app, t.id, t.token, { type: 8, data: { choices: [{ name: "apple", value: "apple" }] } });
    expect(res.status).toBe(204);
  });

  it("MODAL (9) is accepted and creates no channel message", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, channel } = ctx(store);
    const before = ds.messages.findBy("channel_snowflake", channel).length;
    const t = await trigger(app, { type: 2, commandName: "ping", channelSnowflake: channel });
    const res = await callback(app, t.id, t.token, {
      type: 9,
      data: { custom_id: "m", title: "Hi", components: [{ type: 18, label: "Name", component: { type: 4, custom_id: "n" } }] },
    });
    expect(res.status).toBe(204);
    expect(ds.messages.findBy("channel_snowflake", channel).length).toBe(before);
  });

  it("PREMIUM_REQUIRED (10) and LAUNCH_ACTIVITY (12) are accepted callback types", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ctx(store);
    const t1 = await trigger(app, { type: 2, commandName: "ping", channelSnowflake: channel });
    expect((await callback(app, t1.id, t1.token, { type: 10 })).status).toBe(204);
    const t2 = await trigger(app, { type: 2, commandName: "ping", channelSnowflake: channel });
    expect((await callback(app, t2.id, t2.token, { type: 12 })).status).toBe(204);
  });

  it("PONG (1) is accepted for a ping interaction", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ctx(store);
    const t = await trigger(app, { type: 1, channelSnowflake: channel });
    expect((await callback(app, t.id, t.token, { type: 1 })).status).toBe(204);
  });
});

describe("receiving-and-responding.mdx — callback data passthrough & validation", () => {
  it("passes through attachments on a CHANNEL_MESSAGE_WITH_SOURCE response", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ctx(store);
    const t = await trigger(app, { type: 2, commandName: "ping", channelSnowflake: channel });
    const res = await callback(
      app,
      t.id,
      t.token,
      { type: 4, data: { content: "x", attachments: [{ id: "0", filename: "a.txt", description: "d" }] } },
      "?with_response=true",
    );
    const body = (await res.json()) as { resource: { message: { attachments: Array<{ filename: string }> } } };
    expect(body.resource.message.attachments[0].filename).toBe("a.txt");
  });

  it("passes through a poll on a CHANNEL_MESSAGE_WITH_SOURCE response", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ctx(store);
    const t = await trigger(app, { type: 2, commandName: "ping", channelSnowflake: channel });
    const res = await callback(
      app,
      t.id,
      t.token,
      { type: 4, data: { poll: { question: { text: "Pick" }, answers: [{ poll_media: { text: "A" } }, { poll_media: { text: "B" } }] } } },
      "?with_response=true",
    );
    const body = (await res.json()) as { resource: { message: { poll?: { question: { text: string } } } } };
    expect(body.resource.message.poll?.question.text).toBe("Pick");
  });

  it("rejects a callback with invalid (non-settable) flags via 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ctx(store);
    const t = await trigger(app, { type: 2, commandName: "ping", channelSnowflake: channel });
    // CROSSPOSTED (1<<0) is not a settable interaction-response flag.
    const res = await callback(app, t.id, t.token, { type: 4, data: { content: "x", flags: 1 } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50035);
  });
});

describe("receiving-and-responding.mdx — Interaction Callback errors", () => {
  it("an unknown interaction id/token returns 404 Unknown interaction (10062)", async () => {
    const { app } = createDiscordTestApp();
    const res = await callback(app, "999999999999999999", "bogus", { type: 4, data: { content: "x" } });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: number }).code).toBe(10062);
  });

  it("a second callback is rejected as already acknowledged (40060)", async () => {
    const { app, store } = createDiscordTestApp();
    const { channel } = ctx(store);
    const t = await trigger(app, { type: 2, commandName: "ping", channelSnowflake: channel });
    expect((await callback(app, t.id, t.token, { type: 4, data: { content: "first" } })).status).toBe(204);
    const second = await callback(app, t.id, t.token, { type: 4, data: { content: "second" } });
    expect(second.status).toBe(400);
    expect(((await second.json()) as { code: number }).code).toBe(40060);
  });
});

describe("receiving-and-responding.mdx — @original and followup messages", () => {
  it("Get Original Interaction Response returns the initial response message", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId, channel } = ctx(store);
    const t = await trigger(app, { type: 2, commandName: "ping", channelSnowflake: channel });
    await callback(app, t.id, t.token, { type: 4, data: { content: "the original" } });
    const res = await app.request(api(`/webhooks/${appId}/${t.token}/messages/@original`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { content: string }).content).toBe("the original");
  });

  it("Edit Original Interaction Response updates the initial response", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId, channel } = ctx(store);
    const t = await trigger(app, { type: 2, commandName: "ping", channelSnowflake: channel });
    await callback(app, t.id, t.token, { type: 4, data: { content: "v1" } });
    const res = await app.request(api(`/webhooks/${appId}/${t.token}/messages/@original`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ content: "v2" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { content: string }).content).toBe("v2");
  });

  it("Delete Original Interaction Response returns 204", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId, channel } = ctx(store);
    const t = await trigger(app, { type: 2, commandName: "ping", channelSnowflake: channel });
    await callback(app, t.id, t.token, { type: 4, data: { content: "delete me" } });
    const res = await app.request(api(`/webhooks/${appId}/${t.token}/messages/@original`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(204);
  });

  it("Create Followup Message (POST /webhooks/{app}/{token}) creates a new message (wait always true)", async () => {
    const { app, store } = createDiscordTestApp();
    const { ds, appId, channel } = ctx(store);
    const t = await trigger(app, { type: 2, commandName: "ping", channelSnowflake: channel });
    await callback(app, t.id, t.token, { type: 4, data: { content: "original" } });
    const before = ds.messages.findBy("channel_snowflake", channel).length;
    const res = await app.request(api(`/webhooks/${appId}/${t.token}`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "a followup" }),
    });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as { content: string };
    expect(msg.content).toBe("a followup");
    expect(ds.messages.findBy("channel_snowflake", channel).length).toBe(before + 1);
  });

  it("Edit / Delete Followup Message by id round-trip", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId, channel } = ctx(store);
    const t = await trigger(app, { type: 2, commandName: "ping", channelSnowflake: channel });
    await callback(app, t.id, t.token, { type: 4, data: { content: "original" } });
    const followup = (await (
      await app.request(api(`/webhooks/${appId}/${t.token}`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ content: "f1" }),
      })
    ).json()) as { id: string };

    const edit = await app.request(api(`/webhooks/${appId}/${t.token}/messages/${followup.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ content: "f2" }),
    });
    expect(edit.status).toBe(200);
    expect(((await edit.json()) as { content: string }).content).toBe("f2");

    const get = await app.request(api(`/webhooks/${appId}/${t.token}/messages/${followup.id}`), { headers: botHeaders() });
    expect(get.status).toBe(200);

    const del = await app.request(api(`/webhooks/${appId}/${t.token}/messages/${followup.id}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(del.status).toBe(204);
  });
});
