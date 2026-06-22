import { describe, it, expect, afterEach } from "vitest";
import zlib from "node:zlib";
import WebSocket from "ws";
import { startDiscordTestEmulator, type RunningDiscordEmulator } from "./helpers.js";
import { GatewayOpcodes } from "../gateway/opcodes.js";
import { Intents } from "../gateway/intents.js";

/** A single shared inflate context, exactly as a zlib-stream client (discord.py) uses. */
function makeInflater() {
  const inflate = zlib.createInflate();
  let chunks: Buffer[] = [];
  inflate.on("data", (c: Buffer) => chunks.push(c));
  return (buf: Buffer): Promise<{ op: number; t?: string | null; d?: unknown }> =>
    new Promise((resolve) => {
      inflate.write(buf, () => {
        inflate.flush(zlib.constants.Z_SYNC_FLUSH, () => {
          const text = Buffer.concat(chunks).toString("utf8");
          chunks = [];
          resolve(JSON.parse(text));
        });
      });
    });
}

describe("discord gateway zlib-stream compression", () => {
  let emu: RunningDiscordEmulator;
  afterEach(async () => {
    await emu?.close();
  });

  it("compresses gateway frames so a single-context inflate client can read them", async () => {
    emu = await startDiscordTestEmulator();
    const ws = new WebSocket(`${emu.gatewayUrl}?v=10&encoding=json&compress=zlib-stream`);
    const inflate = makeInflater();
    const frames: Array<{ op: number; t?: string | null; d?: unknown }> = [];
    const decodeQueue: Array<Promise<void>> = [];
    ws.on("message", (data) => {
      // Frames must be binary (Buffer) when compression is active.
      expect(Buffer.isBuffer(data)).toBe(true);
      decodeQueue.push(inflate(data as Buffer).then((f) => void frames.push(f)));
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    const waitFor = async (predicate: () => boolean, timeout = 3000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        await Promise.all(decodeQueue.splice(0));
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("timeout");
    };

    await waitFor(() => frames.some((f) => f.op === GatewayOpcodes.Hello));
    const hello = frames.find((f) => f.op === GatewayOpcodes.Hello)!;
    expect((hello.d as { heartbeat_interval: number }).heartbeat_interval).toBeGreaterThan(0);

    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents: Intents.Guilds } }));
    await waitFor(() => frames.some((f) => f.t === "READY"));
    const ready = frames.find((f) => f.t === "READY")!;
    expect((ready.d as { session_id: string }).session_id).toBeTruthy();

    await waitFor(() => frames.some((f) => f.t === "GUILD_CREATE"));
    ws.close();
  });
});
