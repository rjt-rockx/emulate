import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { startDiscordTestEmulator, api, botHeaders, json, type RunningDiscordEmulator } from "./helpers.js";
import { GatewayOpcodes } from "../gateway/opcodes.js";
import { Intents } from "../gateway/intents.js";
import { getDiscordStore } from "../store.js";

interface Frame {
  op: number;
  t?: string | null;
  s?: number | null;
  d?: unknown;
}

function connect(url: string): Promise<{ ws: WebSocket; frames: Frame[]; waitFor: (t: string, timeout?: number) => Promise<Frame> }> {
  const ws = new WebSocket(url);
  ws.on("error", () => void 0); // swallow late socket errors after the server closes
  const frames: Frame[] = [];
  const waiters: Array<() => void> = [];
  ws.on("message", (data) => {
    frames.push(JSON.parse(data.toString()) as Frame);
    waiters.splice(0).forEach((w) => w());
  });
  let cursor = 0; // consume frames in order so repeated waits get successive matches
  const waitFor = async (t: string, timeout = 3000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      while (cursor < frames.length) {
        const frame = frames[cursor++];
        if (frame.t === t) return frame;
      }
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${t}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 30);
      });
    }
  };
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, frames, waitFor }));
    ws.once("error", reject);
  });
}

describe("gateway membership transitions", () => {
  let emu: RunningDiscordEmulator;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await emu?.close();
  });

  it("delivers GUILD_CREATE when the bot creates a guild mid-session", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, waitFor } = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(ws);
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents: Intents.Guilds } }));
    await waitFor("READY");
    await waitFor("GUILD_CREATE"); // the seeded guild

    // Create a new guild over REST after the session is established.
    const created = await fetch(api("/guilds", emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Fresh Guild" }),
    });
    const guild = await json<{ id: string; name: string }>(created);

    const event = await waitFor("GUILD_CREATE");
    expect((event.d as { id: string }).id).toBe(guild.id);
    expect((event.d as { name: string }).name).toBe("Fresh Guild");
  });

  it("delivers GUILD_CREATE when an existing bot is added to a guild it created elsewhere", async () => {
    emu = await startDiscordTestEmulator();
    const ds = getDiscordStore(emu.store);
    const botId = ds.users.findOneBy("username", "emulate-bot")!.snowflake;

    // A guild the bot is NOT yet a member of (owned by the developer user).
    const developer = ds.users.findOneBy("username", "developer")!;
    const guild = ds.guilds.insert({
      snowflake: "950000000000000001",
      name: "Invite Target",
      icon: null,
      splash: null,
      owner_snowflake: developer.snowflake,
      afk_channel_snowflake: null,
      afk_timeout: 300,
      verification_level: 0,
      default_message_notifications: 0,
      explicit_content_filter: 0,
      mfa_level: 0,
      nsfw_level: 0,
      premium_tier: 0,
      premium_subscription_count: 0,
      preferred_locale: "en-US",
      description: null,
      features: [],
      system_channel_snowflake: null,
      member_snowflakes: [developer.snowflake],
      large: false,
      unavailable: false,
    });

    const { ws, waitFor } = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(ws);
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents: Intents.Guilds | Intents.GuildMembers } }));
    await waitFor("READY");
    await waitFor("GUILD_CREATE"); // seeded guild only

    // Add the bot to the new guild — it should now receive GUILD_CREATE for it.
    await fetch(api(`/guilds/${guild.snowflake}/members/${botId}`, emu.baseUrl), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({}),
    });

    const event = await waitFor("GUILD_CREATE");
    expect((event.d as { id: string }).id).toBe(guild.snowflake);

    // And now guild-scoped events for that guild reach the session.
    const channel = await fetch(api(`/guilds/${guild.snowflake}/channels`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "new-here", type: 0 }),
    });
    const ch = await json<{ id: string }>(channel);
    const chEvent = await waitFor("CHANNEL_CREATE");
    expect((chEvent.d as { id: string }).id).toBe(ch.id);
  });

  it("delivers GUILD_DELETE only to the leaving bot", async () => {
    emu = await startDiscordTestEmulator();
    const ds = getDiscordStore(emu.store);
    const guildId = ds.guilds.findOneBy("name", "Emulate Server")!.snowflake;

    const { ws, waitFor } = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(ws);
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents: Intents.Guilds } }));
    await waitFor("READY");
    await waitFor("GUILD_CREATE");

    await fetch(api(`/users/@me/guilds/${guildId}`, emu.baseUrl), { method: "DELETE", headers: botHeaders() });

    const event = await waitFor("GUILD_DELETE");
    expect((event.d as { id: string }).id).toBe(guildId);
  });
});
