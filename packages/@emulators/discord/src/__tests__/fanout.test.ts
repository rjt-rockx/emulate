import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { startDiscordTestEmulator, api, botHeaders, type RunningDiscordEmulator } from "./helpers.js";
import { getDiscordStore } from "../store.js";
import { getDiscordRuntime } from "../runtime.js";
import { createMessage } from "../factories.js";
import { toAPIMessage, redactMessageContent } from "../helpers.js";
import { GatewayOpcodes } from "../gateway/opcodes.js";
import { Intents } from "../gateway/intents.js";

interface Frame {
  op: number;
  t?: string | null;
  d?: unknown;
}

function queue(ws: WebSocket) {
  const buffer: Frame[] = [];
  const waiters: Array<(f: Frame) => void> = [];
  ws.on("message", (data) => {
    const f = JSON.parse(data.toString());
    const w = waiters.shift();
    if (w) w(f);
    else buffer.push(f);
  });
  const next = (timeout = 3000): Promise<Frame> => {
    const queued = buffer.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), timeout);
      waiters.push((f) => {
        clearTimeout(timer);
        resolve(f);
      });
    });
  };
  return {
    next,
    async waitFor(t: string, timeout = 3000): Promise<Frame> {
      const deadline = Date.now() + timeout;
      for (;;) {
        const f = await next(Math.max(1, deadline - Date.now()));
        if (f.t === t) return f;
      }
    },
    async expectNo(t: string, within = 400): Promise<boolean> {
      const deadline = Date.now() + within;
      for (;;) {
        try {
          const f = await next(Math.max(1, deadline - Date.now()));
          if (f.t === t) return false;
        } catch {
          return true; // timed out without seeing t
        }
      }
    },
  };
}

async function identify(emu: RunningDiscordEmulator, intents: number) {
  const ws = new WebSocket(`${emu.gatewayUrl}?v=10&encoding=json`);
    ws.on("error", () => void 0); // swallow late socket errors after the server closes
  const q = queue(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  await q.next(); // hello
  ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents } }));
  await q.waitFor("READY");
  await q.waitFor("GUILD_CREATE");
  return { ws, q };
}

describe("discord gateway fan-out from REST mutations", () => {
  let emu: RunningDiscordEmulator;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await emu?.close();
  });

  it("dispatches MESSAGE_CREATE to a subscribed bot when a message is posted over REST", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, q } = await identify(emu, Intents.Guilds | Intents.GuildMessages | Intents.MessageContent);
    sockets.push(ws);
    const channelId = getDiscordStore(emu.store).channels.findOneBy("name", "general")!.snowflake;

    const res = await fetch(api(`/channels/${channelId}/messages`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "live message" }),
    });
    expect(res.status).toBe(200);

    const event = await q.waitFor("MESSAGE_CREATE");
    expect((event.d as { content: string; channel_id: string }).content).toBe("live message");
    expect((event.d as { channel_id: string }).channel_id).toBe(channelId);
    // guild_id is a gateway-only field (not part of the REST message shape): the server injects it
    // into MESSAGE_CREATE/MESSAGE_UPDATE payloads even though toAPIMessage omits it.
    const guildId = getDiscordStore(emu.store).guilds.findOneBy("name", "Emulate Server")!.snowflake;
    expect((event.d as { guild_id?: string }).guild_id).toBe(guildId);
  });

  it("does NOT dispatch MESSAGE_CREATE to a bot lacking the GuildMessages intent", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, q } = await identify(emu, Intents.Guilds); // no GuildMessages
    sockets.push(ws);
    const channelId = getDiscordStore(emu.store).channels.findOneBy("name", "general")!.snowflake;

    await fetch(api(`/channels/${channelId}/messages`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "unseen" }),
    });
    expect(await q.expectNo("MESSAGE_CREATE")).toBe(true);
  });

  it("redacts another user's message content for a bot without the MessageContent intent", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, q } = await identify(emu, Intents.Guilds | Intents.GuildMessages); // no MessageContent
    sockets.push(ws);
    const ds = getDiscordStore(emu.store);
    const channel = ds.channels.findOneBy("name", "general")!;
    const developer = ds.users.findOneBy("username", "developer")!;

    // A message authored by a non-bot user: content is gated by MESSAGE_CONTENT.
    const message = createMessage(ds, {
      channelSnowflake: channel.snowflake,
      guildSnowflake: channel.guild_snowflake,
      authorSnowflake: developer.snowflake,
      content: "secret content",
    });
    const payload = toAPIMessage(message, ds);
    getDiscordRuntime(emu.store).bus.publish({
      t: "MESSAGE_CREATE",
      guildId: channel.guild_snowflake,
      requiredIntents: Intents.GuildMessages,
      d: payload,
      redactedData: redactMessageContent(payload),
      messageAuthorId: developer.snowflake,
      messageMentionIds: [],
    });

    const event = await q.waitFor("MESSAGE_CREATE");
    expect((event.d as { content: string }).content).toBe("");
  });

  it("responds to REQUEST_GUILD_MEMBERS with a GUILD_MEMBERS_CHUNK", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, q } = await identify(emu, Intents.Guilds | Intents.GuildMembers);
    sockets.push(ws);
    const guildId = getDiscordStore(emu.store).guilds.findOneBy("name", "Emulate Server")!.snowflake;
    ws.send(JSON.stringify({ op: GatewayOpcodes.RequestGuildMembers, d: { guild_id: guildId, nonce: "n1" } }));
    const chunk = await q.waitFor("GUILD_MEMBERS_CHUNK");
    const d = chunk.d as { guild_id: string; members: unknown[]; nonce: string };
    expect(d.guild_id).toBe(guildId);
    expect(d.members.length).toBeGreaterThan(0);
    expect(d.nonce).toBe("n1");
  });

  it("includes content for the bot's own message even without MessageContent", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, q } = await identify(emu, Intents.Guilds | Intents.GuildMessages); // no MessageContent
    sockets.push(ws);
    const channelId = getDiscordStore(emu.store).channels.findOneBy("name", "general")!.snowflake;

    await fetch(api(`/channels/${channelId}/messages`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "my own message" }),
    });
    const event = await q.waitFor("MESSAGE_CREATE");
    expect((event.d as { content: string }).content).toBe("my own message");
  });
});
