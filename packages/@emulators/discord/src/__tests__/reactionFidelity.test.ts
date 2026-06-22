import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { createDiscordTestApp, startDiscordTestEmulator, api, botHeaders, json, type RunningDiscordEmulator } from "./helpers.js";
import { getDiscordStore } from "../store.js";
import { GatewayOpcodes } from "../gateway/opcodes.js";
import { Intents } from "../gateway/intents.js";

describe("reaction object fidelity", () => {
  it("includes count_details, me_burst, and burst_colors", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const channel = ds.channels.findOneBy("name", "general")!.snowflake;
    const msg = await json<{ id: string }>(await app.request(api(`/channels/${channel}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "react to me" }),
    }));

    await app.request(api(`/channels/${channel}/messages/${msg.id}/reactions/${encodeURIComponent("👍")}/@me`), {
      method: "PUT",
      headers: botHeaders(),
    });

    const fetched = await json<{
      reactions: Array<{ count: number; count_details: { burst: number; normal: number }; me_burst: boolean; burst_colors: unknown[] }>;
    }>(await app.request(api(`/channels/${channel}/messages/${msg.id}`), { headers: botHeaders() }));
    expect(fetched.reactions[0].count).toBe(1);
    expect(fetched.reactions[0].count_details).toEqual({ burst: 0, normal: 1 });
    expect(fetched.reactions[0].me_burst).toBe(false);
    expect(Array.isArray(fetched.reactions[0].burst_colors)).toBe(true);
  });
});

describe("reaction gateway event fidelity", () => {
  let emu: RunningDiscordEmulator;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await emu?.close();
  });

  it("MESSAGE_REACTION_ADD carries member, message_author_id, burst and type", async () => {
    emu = await startDiscordTestEmulator();
    const ds = getDiscordStore(emu.store);
    const channel = ds.channels.findOneBy("name", "general")!.snowflake;
    const bot = ds.users.findOneBy("username", "emulate-bot")!.snowflake;

    const ws = new WebSocket(`${emu.gatewayUrl}?v=10&encoding=json`);
    ws.on("error", () => void 0);
    sockets.push(ws);
    const frames: Array<{ t?: string | null; d?: unknown }> = [];
    ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
    await new Promise<void>((r, j) => {
      ws.once("open", () => r());
      ws.once("error", j);
    });
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents: Intents.Guilds | Intents.GuildMessages | Intents.GuildMessageReactions } }));
    await new Promise<void>((r) => {
      const check = () => (frames.some((f) => f.t === "READY") ? r() : setTimeout(check, 20));
      check();
    });

    const msg = await json<{ id: string }>(await fetch(api(`/channels/${channel}/messages`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "hi" }),
    }));

    await fetch(api(`/channels/${channel}/messages/${msg.id}/reactions/${encodeURIComponent("🎉")}/@me`, emu.baseUrl), {
      method: "PUT",
      headers: botHeaders(),
    });

    const deadline = Date.now() + 3000;
    let add: { d?: unknown } | undefined;
    while (Date.now() < deadline && !(add = frames.find((f) => f.t === "MESSAGE_REACTION_ADD"))) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(add).toBeTruthy();
    const d = add!.d as { member?: { user: { id: string } }; message_author_id: string; burst: boolean; type: number };
    expect(d.member?.user.id).toBe(bot);
    expect(d.message_author_id).toBe(bot);
    expect(d.burst).toBe(false);
    expect(d.type).toBe(0);
  });
});
