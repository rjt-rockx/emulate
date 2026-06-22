import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { startDiscordTestEmulator, api, botHeaders, type RunningDiscordEmulator } from "./helpers.js";
import { GatewayOpcodes } from "../gateway/opcodes.js";
import { Intents } from "../gateway/intents.js";

interface MsgQueue {
  next(timeout?: number): Promise<{ op: number; t?: string | null; s?: number | null; d?: unknown }>;
  waitFor(t: string, timeout?: number): Promise<{ op: number; t?: string | null; d?: unknown }>;
}

function queue(ws: WebSocket): MsgQueue {
  const buffer: Array<{ op: number; t?: string | null; s?: number | null; d?: unknown }> = [];
  const waiters: Array<(m: { op: number; t?: string | null; s?: number | null; d?: unknown }) => void> = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    const w = waiters.shift();
    if (w) w(msg);
    else buffer.push(msg);
  });
  const next = (timeout = 3000) => {
    const queued = buffer.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<{ op: number; t?: string | null; s?: number | null; d?: unknown }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("gateway message timeout")), timeout);
      waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  };
  const waitFor = async (t: string, timeout = 3000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const msg = await next(Math.max(1, deadline - Date.now()));
      if (msg.t === t) return msg;
    }
  };
  return { next, waitFor };
}

/**
 * Connect and attach the message queue *before* the socket opens, so the Hello frame
 * (which can coalesce with the 101 response on loopback) is never missed.
 */
function connect(url: string): Promise<{ ws: WebSocket; q: MsgQueue }> {
  const ws = new WebSocket(url);
    ws.on("error", () => void 0); // swallow late socket errors after the server closes
  const q = queue(ws);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, q }));
    ws.once("error", reject);
  });
}

describe("discord gateway", () => {
  let emu: RunningDiscordEmulator;
  afterEach(async () => {
    await emu?.close();
  });

  it("GET /gateway/bot advertises a ws url for the same host", async () => {
    emu = await startDiscordTestEmulator();
    const res = await fetch(api("/gateway/bot", emu.baseUrl), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; shards: number; session_start_limit: unknown };
    expect(body.url).toBe(emu.gatewayUrl);
    expect(body.shards).toBe(1);
    expect(body.session_start_limit).toBeTruthy();
  });

  it("completes the Hello -> Identify -> Ready -> GUILD_CREATE handshake", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, q } = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);

    const hello = await q.next();
    expect(hello.op).toBe(GatewayOpcodes.Hello);
    expect((hello.d as { heartbeat_interval: number }).heartbeat_interval).toBeGreaterThan(0);

    ws.send(
      JSON.stringify({
        op: GatewayOpcodes.Identify,
        d: { token: "test_bot_token", intents: Intents.Guilds | Intents.GuildMessages, properties: {} },
      }),
    );

    const ready = await q.waitFor("READY");
    expect(ready.op).toBe(GatewayOpcodes.Dispatch);
    const readyData = ready.d as {
      session_id: string;
      resume_gateway_url: string;
      user: { bot: boolean };
      application: { id: string };
    };
    expect(readyData.session_id).toBeTruthy();
    expect(readyData.resume_gateway_url).toBe(emu.gatewayUrl);
    expect(readyData.user.bot).toBe(true);

    const guildCreate = await q.waitFor("GUILD_CREATE");
    expect((guildCreate.d as { name: string }).name).toBe("Emulate Server");
    ws.close();
  });

  it("responds to a heartbeat with an ack", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, q } = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    await q.next(); // hello
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents: 0 } }));
    await q.waitFor("READY");

    ws.send(JSON.stringify({ op: GatewayOpcodes.Heartbeat, d: null }));
    let ack = await q.next();
    while (ack.op !== GatewayOpcodes.HeartbeatAck) ack = await q.next();
    expect(ack.op).toBe(GatewayOpcodes.HeartbeatAck);
    ws.close();
  });

  it("rejects a bad bot token with close code 4004", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, q } = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    await q.next(); // hello
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "nope", intents: 0 } }));
    expect(await closed).toBe(4004);
  });

  it("closes with 4003 when a non-handshake opcode arrives before IDENTIFY", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, q } = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    await q.next(); // hello
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send(JSON.stringify({ op: GatewayOpcodes.RequestGuildMembers, d: { guild_id: "1" } }));
    expect(await closed).toBe(4003);
  });

  it("closes with 4001 on an unknown opcode after identify", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, q } = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    await q.next(); // hello
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents: 0 } }));
    await q.waitFor("READY");
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send(JSON.stringify({ op: 99, d: {} }));
    expect(await closed).toBe(4001);
  });
});
