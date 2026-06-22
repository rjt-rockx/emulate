import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { packETF, unpackETF } from "../gateway/etf.js";
import { startDiscordTestEmulator, type RunningDiscordEmulator } from "./helpers.js";
import { GatewayOpcodes } from "../gateway/opcodes.js";
import { Intents } from "../gateway/intents.js";

describe("ETF codec", () => {
  it("round-trips primitives", () => {
    expect(unpackETF(packETF(null))).toBe(null);
    expect(unpackETF(packETF(true))).toBe(true);
    expect(unpackETF(packETF(false))).toBe(false);
    expect(unpackETF(packETF(0))).toBe(0);
    expect(unpackETF(packETF(255))).toBe(255);
    expect(unpackETF(packETF(-1))).toBe(-1);
    expect(unpackETF(packETF(123456))).toBe(123456);
    expect(unpackETF(packETF(-123456))).toBe(-123456);
    expect(unpackETF(packETF(3.5))).toBe(3.5);
    expect(unpackETF(packETF("hello"))).toBe("hello");
    expect(unpackETF(packETF("snowflake: 123456789012345678"))).toBe("snowflake: 123456789012345678");
  });

  it("round-trips large integers beyond int32", () => {
    expect(unpackETF(packETF(9007199254740991))).toBe(9007199254740991);
    expect(unpackETF(packETF(41250))).toBe(41250);
  });

  it("round-trips arrays and nested objects", () => {
    expect(unpackETF(packETF([]))).toEqual([]);
    expect(unpackETF(packETF([1, "two", true, null]))).toEqual([1, "two", true, null]);
    const payload = {
      op: 0,
      s: 3,
      t: "MESSAGE_CREATE",
      d: { id: "123", content: "hi", embeds: [], mentions: [{ id: "456", bot: false }] },
    };
    expect(unpackETF(packETF(payload))).toEqual(payload);
  });

  it("decodes maps with binary keys", () => {
    const buf = packETF({ token: "abc", intents: 513, properties: { os: "linux" } });
    expect(unpackETF(buf)).toEqual({ token: "abc", intents: 513, properties: { os: "linux" } });
  });
});

describe("gateway over ETF", () => {
  let emu: RunningDiscordEmulator;
  afterEach(async () => {
    await emu?.close();
  });

  it("completes the handshake with encoding=etf", async () => {
    emu = await startDiscordTestEmulator();
    const ws = new WebSocket(`${emu.gatewayUrl}?v=10&encoding=etf`);
    ws.on("error", () => void 0); // swallow late socket errors after the server closes
    const messages: Array<{ op: number; t?: string | null; d?: unknown }> = [];
    const waiters: Array<() => void> = [];
    ws.on("message", (data) => {
      const buf = Array.isArray(data) ? Buffer.concat(data as Buffer[]) : (data as Buffer);
      messages.push(unpackETF(buf) as { op: number; t?: string | null; d?: unknown });
      waiters.shift()?.();
    });
    const nextMatching = async (predicate: (m: { op: number; t?: string | null }) => boolean, timeout = 3000) => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const found = messages.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) throw new Error("etf gateway message timeout");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(1, deadline - Date.now()));
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    };

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    const hello = await nextMatching((m) => m.op === GatewayOpcodes.Hello);
    expect((hello.d as { heartbeat_interval: number }).heartbeat_interval).toBeGreaterThan(0);

    ws.send(
      packETF({
        op: GatewayOpcodes.Identify,
        d: { token: "test_bot_token", intents: Intents.Guilds, properties: { os: "linux" } },
      }),
    );

    const ready = await nextMatching((m) => m.t === "READY");
    const readyData = ready.d as { session_id: string; user: { bot: boolean } };
    expect(readyData.session_id).toBeTruthy();
    expect(readyData.user.bot).toBe(true);

    const guildCreate = await nextMatching((m) => m.t === "GUILD_CREATE");
    expect((guildCreate.d as { name: string }).name).toBe("Emulate Server");
    ws.close();
  });
});
