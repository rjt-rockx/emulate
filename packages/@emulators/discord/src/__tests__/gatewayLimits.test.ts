import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { startDiscordTestEmulator, type RunningDiscordEmulator } from "./helpers.js";
import { GatewayOpcodes } from "../gateway/opcodes.js";
import { Intents } from "../gateway/intents.js";

function open(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  ws.on("error", () => void 0);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitFor(ws: WebSocket, t: string, timeout = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout for ${t}`)), timeout);
    const onMsg = (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString()) as { t?: string | null };
      if (frame.t === t) {
        clearTimeout(timer);
        ws.off("message", onMsg);
        resolve();
      }
    };
    ws.on("message", onMsg);
  });
}

describe("gateway heartbeat zombie + command rate limit", () => {
  let emu: RunningDiscordEmulator;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await emu?.close();
  });

  it("closes with 4009 when the client stops heartbeating", async () => {
    emu = await startDiscordTestEmulator();
    emu.store.setData("discord.gateway.heartbeat_interval", 120); // short, so the zombie timer fires fast
    const ws = await open(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(ws);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents: Intents.Guilds } }));
    await waitFor(ws, "READY");
    // Never heartbeat -> expect a 4009 Session Timed Out within ~1.5x the interval.
    expect(await closed).toBe(4009);
  });

  it("does not declare a zombie while the client keeps heartbeating", async () => {
    emu = await startDiscordTestEmulator();
    emu.store.setData("discord.gateway.heartbeat_interval", 120);
    const ws = await open(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(ws);
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents: Intents.Guilds } }));
    await waitFor(ws, "READY");
    let closedCode: number | null = null;
    ws.once("close", (code) => (closedCode = code));
    // Heartbeat every 80ms for ~400ms (well past 1.5x interval) -> stays open.
    const interval = setInterval(() => ws.send(JSON.stringify({ op: GatewayOpcodes.Heartbeat, d: null })), 80);
    await new Promise((r) => setTimeout(r, 400));
    clearInterval(interval);
    expect(closedCode).toBeNull();
  });

  it("closes with 4008 when the per-window command limit is exceeded", async () => {
    emu = await startDiscordTestEmulator();
    emu.store.setData("discord.gateway.command_limit", 3);
    emu.store.setData("discord.gateway.command_window_ms", 60_000);
    const ws = await open(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(ws);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    // Identify is command 1; three more heartbeats push the count past the limit of 3.
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents: 0 } }));
    await waitFor(ws, "READY");
    for (let i = 0; i < 4; i++) ws.send(JSON.stringify({ op: GatewayOpcodes.Heartbeat, d: null }));
    expect(await closed).toBe(4008);
  });
});
