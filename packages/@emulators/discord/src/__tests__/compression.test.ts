import { describe, it, expect, afterEach } from "vitest";
import zlib from "node:zlib";
import WebSocket from "ws";
import { startDiscordTestEmulator, type RunningDiscordEmulator } from "./helpers.js";
import { GatewayOpcodes } from "../gateway/opcodes.js";
import { Intents } from "../gateway/intents.js";

/**
 * A single shared inflate context, exactly as a zlib-stream client (discord.py) uses.
 * Inflate operations are serialized through a promise chain so concurrent frames never
 * interleave writes on the shared stream (which would corrupt the shared chunk buffer).
 */
function makeInflater() {
  const inflate = zlib.createInflate();
  let chunks: Buffer[] = [];
  inflate.on("data", (c: Buffer) => chunks.push(c));
  let queue: Promise<unknown> = Promise.resolve();
  return (buf: Buffer): Promise<{ op: number; t?: string | null; d?: unknown }> => {
    const next = queue.then(
      () =>
        new Promise<{ op: number; t?: string | null; d?: unknown }>((resolve) => {
          inflate.write(buf, () => {
            inflate.flush(zlib.constants.Z_SYNC_FLUSH, () => {
              const text = Buffer.concat(chunks).toString("utf8");
              chunks = [];
              resolve(JSON.parse(text));
            });
          });
        }),
    );
    queue = next.catch(() => undefined);
    return next;
  };
}

describe("discord gateway zlib-stream compression", () => {
  let emu: RunningDiscordEmulator;
  afterEach(async () => {
    await emu?.close();
  });

  it("compresses gateway frames so a single-context inflate client can read them", { timeout: 15000 }, async () => {
    emu = await startDiscordTestEmulator();
    const ws = new WebSocket(`${emu.gatewayUrl}?v=10&encoding=json&compress=zlib-stream`);
    ws.on("error", () => void 0); // swallow late socket errors after the server closes
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

  it("compresses gateway frames with zstd-stream (discord.py 2.7+ default)", { timeout: 15000 }, async () => {
    emu = await startDiscordTestEmulator();
    const ws = new WebSocket(`${emu.gatewayUrl}?v=10&encoding=json&compress=zstd-stream`);
    ws.on("error", () => void 0);
    // A single shared zstd-stream decompress context, exactly as discord.py 2.7 uses.
    const dec = zlib.createZstdDecompress();
    let chunks: Buffer[] = [];
    dec.on("data", (c: Buffer) => chunks.push(c));
    let dq: Promise<unknown> = Promise.resolve();
    const inflate = (buf: Buffer): Promise<{ op: number; t?: string | null; d?: unknown }> => {
      const next = dq.then(
        () =>
          new Promise<{ op: number; t?: string | null; d?: unknown }>((resolve) => {
            dec.write(buf, () => dec.flush(zlib.constants.ZSTD_e_flush, () => {
              const text = Buffer.concat(chunks).toString("utf8");
              chunks = [];
              resolve(JSON.parse(text));
            }));
          }),
      );
      dq = next.catch(() => undefined);
      return next;
    };
    const frames: Array<{ op: number; t?: string | null; d?: unknown }> = [];
    const decodeQueue: Array<Promise<void>> = [];
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      expect(isBinary).toBe(true); // compressed frames are binary
      decodeQueue.push(inflate(data).then((f) => void frames.push(f)));
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const waitFor = async (predicate: () => boolean, timeout = 4000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        await Promise.all(decodeQueue.splice(0));
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("timeout");
    };

    await waitFor(() => frames.some((f) => f.op === GatewayOpcodes.Hello));
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents: Intents.Guilds } }));
    await waitFor(() => frames.some((f) => f.t === "READY"));
    await waitFor(() => frames.some((f) => f.t === "GUILD_CREATE"));
    ws.close();
  });

  it("serves Identify compress:true as independent per-message zlib blocks (discordgo default)", { timeout: 15000 }, async () => {
    emu = await startDiscordTestEmulator();
    // No transport compression on the URL — payload compression is requested via IDENTIFY instead.
    const ws = new WebSocket(`${emu.gatewayUrl}?v=10&encoding=json`);
    ws.on("error", () => void 0);
    const frames: Array<{ op: number; t?: string | null; d?: unknown }> = [];
    let binaryFrames = 0;
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        binaryFrames++;
        // Each frame must be a complete, standalone zlib block — decode with a FRESH context.
        // (The pre-fix streaming compressor failed here on the 2nd+ frame: "zlib: invalid header".)
        frames.push(JSON.parse(zlib.inflateSync(data).toString("utf8")));
      } else {
        frames.push(JSON.parse(data.toString("utf8")));
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    const waitFor = async (predicate: () => boolean, timeout = 4000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("timeout");
    };

    // HELLO is sent before IDENTIFY, so it is plain text.
    await waitFor(() => frames.some((f) => f.op === GatewayOpcodes.Hello));
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents: Intents.Guilds, compress: true } }));

    // READY and the following GUILD_CREATE arrive as separate, independently-decodable zlib blocks.
    await waitFor(() => frames.some((f) => f.t === "READY"));
    await waitFor(() => frames.some((f) => f.t === "GUILD_CREATE"));
    expect(binaryFrames).toBeGreaterThanOrEqual(2);
    ws.close();
  });
});
