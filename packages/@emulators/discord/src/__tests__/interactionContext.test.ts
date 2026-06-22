import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { createDiscordTestApp, startDiscordTestEmulator, api, botHeaders, type RunningDiscordEmulator } from "./helpers.js";
import { getDiscordStore } from "../store.js";
import { buildInteraction, InteractionType } from "../interactions/trigger.js";
import { MessageFlags } from "../helpers.js";
import { GatewayOpcodes } from "../gateway/opcodes.js";
import { Intents } from "../gateway/intents.js";

describe("component interaction message context", () => {
  it("carries the source message in a MESSAGE_COMPONENT interaction", () => {
    const { store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const channel = ds.channels.findOneBy("name", "general")!;
    const bot = ds.users.findOneBy("username", "emulate-bot")!;

    // A message the bot posted, carrying a button component.
    const message = ds.messages.insert({
      snowflake: "100000000000000001",
      channel_snowflake: channel.snowflake,
      guild_snowflake: channel.guild_snowflake,
      author_snowflake: bot.snowflake,
      content: "Click me",
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

    const built = buildInteraction(ds, {
      type: InteractionType.MessageComponent,
      channelSnowflake: channel.snowflake,
      customId: "go",
      componentType: 2,
      messageSnowflake: message.snowflake,
    });
    expect(built).not.toBeNull();
    const payload = built!.payload as { message?: { id: string; content: string }; data: { custom_id: string } };
    expect(payload.data.custom_id).toBe("go");
    expect(payload.message?.id).toBe(message.snowflake);
    expect(payload.message?.content).toBe("Click me");
    // The interaction record persists the message reference for UpdateMessage responses.
    expect(built!.record.message_snowflake).toBe(message.snowflake);
  });
});

describe("ephemeral interaction responses", () => {
  let emu: RunningDiscordEmulator;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await emu?.close();
  });

  it("are retrievable but not broadcast or listed in channel history", async () => {
    emu = await startDiscordTestEmulator();
    const ds = getDiscordStore(emu.store);
    const aid = ds.applications.all()[0].snowflake;
    const channelId = ds.channels.findOneBy("name", "general")!.snowflake;
    await fetch(api(`/applications/${aid}/commands`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "secret", description: "x" }),
    });

    // A second bot listens on the gateway for MESSAGE_CREATE.
    const ws = new WebSocket(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(ws);
    const frames: Array<{ op: number; t?: string | null; d?: unknown }> = [];
    ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
    await new Promise<void>((r, j) => {
      ws.once("open", () => r());
      ws.once("error", j);
    });
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents: Intents.Guilds | Intents.GuildMessages | Intents.MessageContent } }));
    await new Promise<void>((r) => {
      const check = () => (frames.some((f) => f.t === "READY") ? r() : setTimeout(check, 20));
      check();
    });
    const beforeFrames = frames.length;

    // Trigger and respond ephemerally (flags 64).
    const triggerRes = await fetch(`${emu.baseUrl}/__emulate/interactions`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: 2, commandName: "secret", channelSnowflake: channelId }),
    });
    const trigger = (await triggerRes.json()) as { id: string; token: string };
    const cb = await fetch(api(`/interactions/${trigger.id}/${trigger.token}/callback`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: 4, data: { content: "for your eyes only", flags: MessageFlags.Ephemeral } }),
    });
    expect(cb.status).toBe(204);

    // Give any (unexpected) dispatch a moment to arrive.
    await new Promise((r) => setTimeout(r, 100));
    const newDispatches = frames.slice(beforeFrames).filter((f) => f.t === "MESSAGE_CREATE");
    expect(newDispatches.length).toBe(0);

    // The ephemeral reply is retrievable via the interaction token, with the flag set.
    const original = await fetch(api(`/webhooks/${aid}/${trigger.token}/messages/@original`, emu.baseUrl), {
      headers: botHeaders(),
    });
    const originalBody = (await original.json()) as { content: string; flags: number };
    expect(originalBody.content).toBe("for your eyes only");
    expect((originalBody.flags & MessageFlags.Ephemeral) !== 0).toBe(true);

    // It does not appear in the channel message list.
    const list = await fetch(api(`/channels/${channelId}/messages`, emu.baseUrl), { headers: botHeaders() });
    const listBody = (await list.json()) as Array<{ content: string }>;
    expect(listBody.some((m) => m.content === "for your eyes only")).toBe(false);
  });

  it("updates the source message for a component UpdateMessage response", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const channel = ds.channels.findOneBy("name", "general")!;
    const bot = ds.users.findOneBy("username", "emulate-bot")!;
    const message = ds.messages.insert({
      snowflake: "100000000000000002",
      channel_snowflake: channel.snowflake,
      guild_snowflake: channel.guild_snowflake,
      author_snowflake: bot.snowflake,
      content: "before",
      timestamp: new Date().toISOString(),
      edited_timestamp: null,
      tts: false,
      mention_everyone: false,
      mention_snowflakes: [],
      mention_role_snowflakes: [],
      attachments: [],
      embeds: [],
      components: [],
      pinned: false,
      webhook_snowflake: null,
      type: 0,
      flags: 0,
      nonce: null,
      message_reference: null,
      referenced_message_snowflake: null,
    });
    const built = buildInteraction(ds, {
      type: InteractionType.MessageComponent,
      channelSnowflake: channel.snowflake,
      customId: "go",
      componentType: 2,
      messageSnowflake: message.snowflake,
    })!;

    const res = await app.request(api(`/interactions/${built.record.snowflake}/${built.record.token}/callback`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: 7, data: { content: "after" } }),
    });
    expect(res.status).toBe(204);
    expect(ds.messages.findOneBy("snowflake", message.snowflake)!.content).toBe("after");
  });
});
