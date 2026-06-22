import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { startDiscordTestEmulator, api, botHeaders, type RunningDiscordEmulator } from "./helpers.js";
import { GatewayOpcodes } from "../gateway/opcodes.js";
import { Intents } from "../gateway/intents.js";
import { getDiscordStore } from "../store.js";

interface GatewayMessage {
  op: number;
  t?: string | null;
  s?: number | null;
  d?: unknown;
}

interface MsgQueue {
  next(timeout?: number): Promise<GatewayMessage>;
  waitFor(t: string, timeout?: number): Promise<GatewayMessage>;
}

function queue(ws: WebSocket): MsgQueue {
  const buffer: GatewayMessage[] = [];
  const waiters: Array<(m: GatewayMessage) => void> = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString()) as GatewayMessage;
    const w = waiters.shift();
    if (w) w(msg);
    else buffer.push(msg);
  });
  const next = (timeout = 3000) => {
    const queued = buffer.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<GatewayMessage>((resolve, reject) => {
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

function connect(url: string): Promise<{ ws: WebSocket; q: MsgQueue }> {
  const ws = new WebSocket(url);
  const q = queue(ws);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, q }));
    ws.once("error", reject);
  });
}

/** Wait until the server has torn down the live session (its inspector record is gone). */
async function waitForDisconnect(emu: RunningDiscordEmulator, sessionId: string): Promise<void> {
  const ds = getDiscordStore(emu.store);
  for (let i = 0; i < 100; i++) {
    if (!ds.gatewaySessions.findOneBy("session_id", sessionId)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("discord gateway resume", () => {
  let emu: RunningDiscordEmulator;
  afterEach(async () => {
    await emu?.close();
  });

  it("replays events missed while disconnected, then RESUMED", async () => {
    emu = await startDiscordTestEmulator();
    const gid = getDiscordStore(emu.store).guilds.findOneBy("name", "Emulate Server")!.snowflake;

    // First connection: identify and drain the handshake.
    const first = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    await first.q.next(); // Hello
    first.ws.send(
      JSON.stringify({
        op: GatewayOpcodes.Identify,
        d: { token: "test_bot_token", intents: Intents.Guilds | Intents.GuildMessages },
      }),
    );
    const ready = await first.q.waitFor("READY");
    const sessionId = (ready.d as { session_id: string }).session_id;
    const guildCreate = await first.q.waitFor("GUILD_CREATE");
    const lastSeq = guildCreate.s ?? 0;
    expect(lastSeq).toBeGreaterThan(0);

    // Drop the connection and wait for the server to make it resumable.
    first.ws.close();
    await waitForDisconnect(emu, sessionId);

    // An event arrives during the gap: create a channel -> CHANNEL_CREATE.
    const created = await fetch(api(`/guilds/${gid}/channels`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "while-away", type: 0 }),
    });
    const channel = (await created.json()) as { id: string };

    // Reconnect and RESUME from the last seq we saw.
    const second = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    await second.q.next(); // Hello
    second.ws.send(
      JSON.stringify({
        op: GatewayOpcodes.Resume,
        d: { token: "test_bot_token", session_id: sessionId, seq: lastSeq },
      }),
    );

    // The missed CHANNEL_CREATE is replayed at a seq beyond our last, then RESUMED follows.
    const replayed = await second.q.waitFor("CHANNEL_CREATE");
    expect((replayed.d as { id: string }).id).toBe(channel.id);
    expect(replayed.s ?? 0).toBeGreaterThan(lastSeq);
    const resumed = await second.q.waitFor("RESUMED");
    expect(resumed.op).toBe(GatewayOpcodes.Dispatch);
    second.ws.close();
  });

  it("rejects a resume for an unknown session with InvalidSession(false)", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, q } = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    await q.next(); // Hello
    ws.send(
      JSON.stringify({
        op: GatewayOpcodes.Resume,
        d: { token: "test_bot_token", session_id: "0000000000", seq: 5 },
      }),
    );
    let msg = await q.next();
    while (msg.op !== GatewayOpcodes.InvalidSession) msg = await q.next();
    expect(msg.op).toBe(GatewayOpcodes.InvalidSession);
    expect(msg.d).toBe(false);
    ws.close();
  });

  it("rejects a resume with a mismatched token", async () => {
    emu = await startDiscordTestEmulator();
    const first = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    await first.q.next(); // Hello
    first.ws.send(
      JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents: Intents.Guilds } }),
    );
    const ready = await first.q.waitFor("READY");
    const sessionId = (ready.d as { session_id: string }).session_id;
    first.ws.close();
    await waitForDisconnect(emu, sessionId);

    const second = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    await second.q.next(); // Hello
    second.ws.send(
      JSON.stringify({ op: GatewayOpcodes.Resume, d: { token: "wrong_token", session_id: sessionId, seq: 1 } }),
    );
    let msg = await second.q.next();
    while (msg.op !== GatewayOpcodes.InvalidSession) msg = await second.q.next();
    expect(msg.d).toBe(false);
    second.ws.close();
  });
});
