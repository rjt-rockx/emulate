/**
 * Spec suite for the Discord Gateway, encoding the testable expectations of:
 *   - developers/events/gateway.mdx
 *   - developers/events/gateway-events.mdx
 *
 * Every assertion below maps to a documented behavior: the connection lifecycle
 * (Hello/Identify/Ready/Heartbeat/Resume/Reconnect/Request Guild Members), intent bit
 * values and the events they gate, privileged intents and the 4014/4010 close codes,
 * Identify field handling, the READY shard echo, and the MESSAGE_CONTENT redaction rules.
 *
 * These are integration tests against a running emulator with a raw `ws` socket, following
 * the harness pattern of the existing gateway*.test.ts files (afterEach close, swallow late
 * socket errors). Seeded data: bot token "test_bot_token", an "Emulate Server" guild.
 */
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { startDiscordTestEmulator, createDiscordTestApp, api, botHeaders, type RunningDiscordEmulator, json } from "../helpers.js";
import { GatewayOpcodes, GatewayCloseCodes } from "../../gateway/opcodes.js";
import { Intents, PRIVILEGED_INTENTS, hasIntent, intentsAllow } from "../../gateway/intents.js";
import { getDiscordStore } from "../../store.js";

const BOT_TOKEN = "test_bot_token";

interface Frame {
  op: number;
  t?: string | null;
  s?: number | null;
  d?: unknown;
}

interface Conn {
  ws: WebSocket;
  /** Resolve with the next frame received (FIFO from the moment of connect). */
  next(timeout?: number): Promise<Frame>;
  /** Resolve with the next frame whose `t` equals the given dispatch name. */
  waitFor(t: string, timeout?: number): Promise<Frame>;
  /** Resolve with the next frame whose op equals the given opcode. */
  waitForOp(op: number, timeout?: number): Promise<Frame>;
}

/**
 * Connect and attach the queue *before* the socket opens so the Hello frame (which can
 * coalesce with the 101 upgrade response on loopback) is never missed.
 */
function connect(url: string): Promise<Conn> {
  const ws = new WebSocket(url);
  ws.on("error", () => void 0); // swallow late socket errors after the server closes
  const buffer: Frame[] = [];
  const waiters: Array<(f: Frame) => void> = [];
  ws.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as Frame;
    const w = waiters.shift();
    if (w) w(frame);
    else buffer.push(frame);
  });
  const next = (timeout = 3000) => {
    const queued = buffer.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("gateway message timeout")), timeout);
      waiters.push((f) => {
        clearTimeout(timer);
        resolve(f);
      });
    });
  };
  const waitFor = async (t: string, timeout = 3000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const f = await next(Math.max(1, deadline - Date.now()));
      if (f.t === t) return f;
    }
  };
  const waitForOp = async (op: number, timeout = 3000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const f = await next(Math.max(1, deadline - Date.now()));
      if (f.op === op) return f;
    }
  };
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, next, waitFor, waitForOp }));
    ws.once("error", reject);
  });
}

/** Identify and drain through READY, returning the READY frame. */
async function identify(conn: Conn, intents: number, extra: Record<string, unknown> = {}): Promise<Frame> {
  conn.ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: BOT_TOKEN, intents, ...extra } }));
  return conn.waitFor("READY");
}

/** Wait until the server tears down the live session (its inspector record is gone). */
async function waitForDisconnect(emu: RunningDiscordEmulator, sessionId: string): Promise<void> {
  const ds = getDiscordStore(emu.store);
  for (let i = 0; i < 200; i++) {
    if (!ds.gatewaySessions.findOneBy("session_id", sessionId)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("gateway spec: intent bit values and privileged set (gateway.mdx List of Intents)", () => {
  // Each bit value is taken verbatim from gateway.mdx "List of Intents".
  it("exports every documented intent at its exact bit value", () => {
    expect(Intents.Guilds).toBe(1 << 0);
    expect(Intents.GuildMembers).toBe(1 << 1);
    expect(Intents.GuildModeration).toBe(1 << 2);
    expect(Intents.GuildExpressions).toBe(1 << 3);
    expect(Intents.GuildIntegrations).toBe(1 << 4);
    expect(Intents.GuildWebhooks).toBe(1 << 5);
    expect(Intents.GuildInvites).toBe(1 << 6);
    expect(Intents.GuildVoiceStates).toBe(1 << 7);
    expect(Intents.GuildPresences).toBe(1 << 8);
    expect(Intents.GuildMessages).toBe(1 << 9);
    expect(Intents.GuildMessageReactions).toBe(1 << 10);
    expect(Intents.GuildMessageTyping).toBe(1 << 11);
    expect(Intents.DirectMessages).toBe(1 << 12);
    expect(Intents.DirectMessageReactions).toBe(1 << 13);
    expect(Intents.DirectMessageTyping).toBe(1 << 14);
    expect(Intents.MessageContent).toBe(1 << 15);
    expect(Intents.GuildScheduledEvents).toBe(1 << 16);
    expect(Intents.AutoModerationConfiguration).toBe(1 << 20);
    expect(Intents.AutoModerationExecution).toBe(1 << 21);
    expect(Intents.GuildMessagePolls).toBe(1 << 24);
    expect(Intents.DirectMessagePolls).toBe(1 << 25);
  });

  it("marks exactly GUILD_MEMBERS, GUILD_PRESENCES, MESSAGE_CONTENT as privileged", () => {
    // gateway.mdx Privileged Intents: GUILD_PRESENCES, GUILD_MEMBERS, MESSAGE_CONTENT.
    expect(PRIVILEGED_INTENTS).toBe(Intents.GuildMembers | Intents.GuildPresences | Intents.MessageContent);
    expect(hasIntent(PRIVILEGED_INTENTS, Intents.GuildMembers)).toBe(true);
    expect(hasIntent(PRIVILEGED_INTENTS, Intents.GuildPresences)).toBe(true);
    expect(hasIntent(PRIVILEGED_INTENTS, Intents.MessageContent)).toBe(true);
    // Non-privileged intents must not be in the set.
    expect(hasIntent(PRIVILEGED_INTENTS, Intents.Guilds)).toBe(false);
    expect(hasIntent(PRIVILEGED_INTENTS, Intents.GuildMessages)).toBe(false);
  });

  it("ORs intents so a single bitfield can request multiple intents (gateway.mdx: 513 = GUILDS | GUILD_MESSAGES)", () => {
    // gateway.mdx example Identify uses intents 513 = (1 << 0) | (1 << 9).
    expect(Intents.Guilds | Intents.GuildMessages).toBe(513);
    // gateway-events.mdx example Identify uses intents 5 = GUILDS | GUILD_MODERATION.
    expect(Intents.Guilds | Intents.GuildModeration).toBe(5);
  });

  it("intentsAllow: ungated (0) events always pass; gated events require the bit", () => {
    expect(intentsAllow(0, 0)).toBe(true); // event with no intent is always delivered
    expect(intentsAllow(Intents.Guilds, Intents.Guilds)).toBe(true);
    expect(intentsAllow(Intents.Guilds, Intents.GuildMessages)).toBe(false);
  });
});

describe("gateway spec: connection lifecycle (gateway.mdx Connections)", () => {
  let emu: RunningDiscordEmulator;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await emu?.close();
  });

  it("sends Hello (op 10) on connect with a positive heartbeat_interval", async () => {
    emu = await startDiscordTestEmulator();
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    const hello = await conn.next();
    expect(hello.op).toBe(GatewayOpcodes.Hello);
    expect(hello.op).toBe(10);
    // Hello carries only heartbeat_interval (ms), and op != 0 so s and t are null.
    expect((hello.d as { heartbeat_interval: number }).heartbeat_interval).toBeGreaterThan(0);
    expect(hello.s ?? null).toBeNull();
    expect(hello.t ?? null).toBeNull();
  });

  it("Identify (op 2) -> Ready (op 0, t=READY) with v/user/guilds/session_id/resume_gateway_url/application", async () => {
    emu = await startDiscordTestEmulator();
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello

    const ready = await identify(conn, Intents.Guilds | Intents.GuildMessages, { properties: { os: "linux", browser: "spec", device: "spec" } });
    // READY is a Dispatch (op 0) with a sequence number and the READY name.
    expect(ready.op).toBe(GatewayOpcodes.Dispatch);
    expect(ready.op).toBe(0);
    expect(ready.t).toBe("READY");
    expect(ready.s).toBeTypeOf("number");

    const d = ready.d as {
      v: number;
      user: { id: string; bot: boolean; username: string };
      guilds: Array<{ id: string; unavailable: boolean }>;
      session_id: string;
      resume_gateway_url: string;
      application: { id: string; flags: number };
    };
    // Ready Event Fields (gateway-events.mdx).
    expect(d.v).toBe(10); // API version
    expect(d.user.bot).toBe(true);
    expect(d.user.id).toBeTruthy();
    expect(d.session_id).toBeTruthy();
    expect(d.resume_gateway_url).toBe(emu.gatewayUrl);
    expect(Array.isArray(d.guilds)).toBe(true);
    // Guilds start unavailable until a Guild Create follows (gateway.mdx Guild Availability).
    expect(d.guilds.length).toBeGreaterThan(0);
    for (const g of d.guilds) expect(g.unavailable).toBe(true);
    // application is a partial object containing id and flags.
    expect(d.application.id).toBeTruthy();
    expect(d.application).toHaveProperty("flags");
  });

  it("follows READY with one Guild Create per guild the bot is in (gateway.mdx Guild Availability)", async () => {
    emu = await startDiscordTestEmulator();
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    await identify(conn, Intents.Guilds);
    const guildCreate = await conn.waitFor("GUILD_CREATE");
    expect((guildCreate.d as { name: string }).name).toBe("Emulate Server");
    // Guild Create Extra Fields: the available guild has members and channels arrays.
    const gc = guildCreate.d as { id: string; channels?: unknown[]; members?: unknown[] };
    expect(gc.id).toBeTruthy();
  });

  it("Heartbeat (op 1) -> Heartbeat ACK (op 11)", async () => {
    emu = await startDiscordTestEmulator();
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    await identify(conn, 0);

    conn.ws.send(JSON.stringify({ op: GatewayOpcodes.Heartbeat, d: null }));
    const ack = await conn.waitForOp(GatewayOpcodes.HeartbeatAck);
    expect(ack.op).toBe(11);
    // The ACK payload carries no data, no sequence, no name.
    expect(ack.s ?? null).toBeNull();
    expect(ack.t ?? null).toBeNull();
  });

  it("accepts a heartbeat carrying the last sequence number in d (gateway-events.mdx Heartbeat)", async () => {
    emu = await startDiscordTestEmulator();
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    const ready = await identify(conn, Intents.Guilds);
    const lastSeq = ready.s ?? 0;
    // Heartbeat with the cached sequence number is acknowledged just like a null one.
    conn.ws.send(JSON.stringify({ op: GatewayOpcodes.Heartbeat, d: lastSeq }));
    const ack = await conn.waitForOp(GatewayOpcodes.HeartbeatAck);
    expect(ack.op).toBe(11);
  });

  it("Dispatch payload structure: op 0 events carry numeric s and a string t", async () => {
    emu = await startDiscordTestEmulator();
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    const ready = await identify(conn, Intents.Guilds);
    const guildCreate = await conn.waitFor("GUILD_CREATE");
    // s increases monotonically across dispatches.
    expect((ready.s ?? 0)).toBeGreaterThan(0);
    expect((guildCreate.s ?? 0)).toBeGreaterThan(ready.s ?? 0);
    expect(guildCreate.op).toBe(0);
    expect(typeof guildCreate.t).toBe("string");
  });
});

describe("gateway spec: Identify fields (gateway-events.mdx Identify Structure)", () => {
  let emu: RunningDiscordEmulator;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await emu?.close();
  });

  it("accepts the full documented Identify (token, intents, properties, compress, large_threshold, shard, presence)", async () => {
    emu = await startDiscordTestEmulator();
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    const ready = await identify(conn, Intents.Guilds | Intents.GuildModeration, {
      properties: { os: "linux", browser: "disco", device: "disco" },
      large_threshold: 250,
      shard: [0, 1],
      presence: { activities: [{ name: "Cards Against Humanity", type: 0 }], status: "dnd", since: 91879201, afk: false },
    });
    expect(ready.t).toBe("READY");
  });

  it("echoes shard back in READY when supplied (gateway-events.mdx Ready Event Fields: shard?)", async () => {
    emu = await startDiscordTestEmulator();
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    const ready = await identify(conn, Intents.Guilds, { shard: [0, 2] });
    expect((ready.d as { shard: [number, number] }).shard).toEqual([0, 2]);
  });

  it("omits shard from READY when not supplied", async () => {
    emu = await startDiscordTestEmulator();
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    const ready = await identify(conn, Intents.Guilds);
    expect((ready.d as Record<string, unknown>).shard).toBeUndefined();
  });

  it("accepts large_threshold within the documented 50-250 range", async () => {
    emu = await startDiscordTestEmulator();
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    const ready = await identify(conn, Intents.Guilds, { large_threshold: 200 });
    expect(ready.t).toBe("READY");
  });

  it("tolerates a Bot-prefixed token in the Identify token field", async () => {
    emu = await startDiscordTestEmulator();
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    conn.ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: `Bot ${BOT_TOKEN}`, intents: 0 } }));
    const ready = await conn.waitFor("READY");
    expect(ready.t).toBe("READY");
  });
});

describe("gateway spec: sharding validation (gateway.mdx Sharding)", () => {
  let emu: RunningDiscordEmulator;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await emu?.close();
  });

  async function expectClose(shard: unknown): Promise<number> {
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    const closed = new Promise<number>((resolve) => conn.ws.once("close", (code) => resolve(code)));
    conn.ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: BOT_TOKEN, intents: 0, shard } }));
    return closed;
  }

  it("accepts a valid [shard_id, num_shards] with 0 <= shard_id < num_shards", async () => {
    emu = await startDiscordTestEmulator();
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    const ready = await identify(conn, Intents.Guilds, { shard: [2, 3] });
    expect((ready.d as { shard: [number, number] }).shard).toEqual([2, 3]);
  });

  it("closes with 4010 InvalidShard when shard_id >= num_shards", async () => {
    emu = await startDiscordTestEmulator();
    expect(await expectClose([3, 3])).toBe(GatewayCloseCodes.InvalidShard);
    expect(GatewayCloseCodes.InvalidShard).toBe(4010);
  });

  it("closes with 4010 InvalidShard when shard_id is negative", async () => {
    emu = await startDiscordTestEmulator();
    expect(await expectClose([-1, 3])).toBe(4010);
  });

  it("closes with 4010 InvalidShard when num_shards is < 1", async () => {
    emu = await startDiscordTestEmulator();
    expect(await expectClose([0, 0])).toBe(4010);
  });

  it("closes with 4010 InvalidShard when the shard array is the wrong length", async () => {
    emu = await startDiscordTestEmulator();
    expect(await expectClose([0])).toBe(4010);
  });

  it("closes with 4010 InvalidShard when shard entries are non-integers", async () => {
    emu = await startDiscordTestEmulator();
    expect(await expectClose([0.5, 2])).toBe(4010);
  });
});

describe("gateway spec: privileged intents and close codes (gateway.mdx Privileged Intents)", () => {
  let emu: RunningDiscordEmulator;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await emu?.close();
  });

  it("by default allows privileged intents (all approved for ergonomics)", async () => {
    emu = await startDiscordTestEmulator();
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    const ready = await identify(conn, PRIVILEGED_INTENTS);
    expect(ready.t).toBe("READY");
  });

  it("closes with 4014 DisallowedIntents when a disallowed privileged intent is requested", async () => {
    emu = await startDiscordTestEmulator();
    // Mark GUILD_MEMBERS as not-approved for this app.
    emu.store.setData("discord.gateway.disallowed_intents", Intents.GuildMembers);
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    const closed = new Promise<number>((resolve) => conn.ws.once("close", (code) => resolve(code)));
    conn.ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: BOT_TOKEN, intents: Intents.GuildMembers } }));
    expect(await closed).toBe(GatewayCloseCodes.DisallowedIntents);
    expect(GatewayCloseCodes.DisallowedIntents).toBe(4014);
  });

  it("closes with 4014 when MESSAGE_CONTENT is requested but disallowed", async () => {
    emu = await startDiscordTestEmulator();
    emu.store.setData("discord.gateway.disallowed_intents", Intents.MessageContent);
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    const closed = new Promise<number>((resolve) => conn.ws.once("close", (code) => resolve(code)));
    conn.ws.send(
      JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: BOT_TOKEN, intents: Intents.Guilds | Intents.MessageContent } }),
    );
    expect(await closed).toBe(4014);
  });

  it("still admits non-disallowed intents when only one privileged intent is disallowed", async () => {
    emu = await startDiscordTestEmulator();
    emu.store.setData("discord.gateway.disallowed_intents", Intents.GuildPresences);
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    // Requesting GUILD_MEMBERS (privileged but allowed) succeeds.
    const ready = await identify(conn, Intents.GuildMembers | Intents.Guilds);
    expect(ready.t).toBe("READY");
  });

  it("closes with 4013 InvalidIntents when intents are out of range / non-integer", async () => {
    emu = await startDiscordTestEmulator();
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    const closed = new Promise<number>((resolve) => conn.ws.once("close", (code) => resolve(code)));
    conn.ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: BOT_TOKEN, intents: -1 } }));
    expect(await closed).toBe(GatewayCloseCodes.InvalidIntents);
    expect(GatewayCloseCodes.InvalidIntents).toBe(4013);
  });
});

describe("gateway spec: close codes and when each is sent (opcodes 4000-4014)", () => {
  let emu: RunningDiscordEmulator;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await emu?.close();
  });

  it("declares the documented close-code constants at their numeric values", () => {
    expect(GatewayCloseCodes.UnknownError).toBe(4000);
    expect(GatewayCloseCodes.UnknownOpcode).toBe(4001);
    expect(GatewayCloseCodes.DecodeError).toBe(4002);
    expect(GatewayCloseCodes.NotAuthenticated).toBe(4003);
    expect(GatewayCloseCodes.AuthenticationFailed).toBe(4004);
    expect(GatewayCloseCodes.AlreadyAuthenticated).toBe(4005);
    expect(GatewayCloseCodes.InvalidSeq).toBe(4007);
    expect(GatewayCloseCodes.RateLimited).toBe(4008);
    expect(GatewayCloseCodes.SessionTimedOut).toBe(4009);
    expect(GatewayCloseCodes.InvalidShard).toBe(4010);
    expect(GatewayCloseCodes.ShardingRequired).toBe(4011);
    expect(GatewayCloseCodes.InvalidApiVersion).toBe(4012);
    expect(GatewayCloseCodes.InvalidIntents).toBe(4013);
    expect(GatewayCloseCodes.DisallowedIntents).toBe(4014);
  });

  it("4004 AuthenticationFailed: bad token at Identify", async () => {
    emu = await startDiscordTestEmulator();
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    const closed = new Promise<number>((resolve) => conn.ws.once("close", (code) => resolve(code)));
    conn.ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "nope", intents: 0 } }));
    expect(await closed).toBe(4004);
  });

  it("4003 NotAuthenticated: a non-handshake opcode arrives before Identify", async () => {
    emu = await startDiscordTestEmulator();
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    const closed = new Promise<number>((resolve) => conn.ws.once("close", (code) => resolve(code)));
    conn.ws.send(JSON.stringify({ op: GatewayOpcodes.RequestGuildMembers, d: { guild_id: "1" } }));
    expect(await closed).toBe(4003);
  });

  it("4001 UnknownOpcode: an opcode the gateway never receives from clients", async () => {
    emu = await startDiscordTestEmulator();
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    await identify(conn, 0);
    const closed = new Promise<number>((resolve) => conn.ws.once("close", (code) => resolve(code)));
    conn.ws.send(JSON.stringify({ op: 99, d: {} }));
    expect(await closed).toBe(4001);
  });

  it("4002 DecodeError: an undecodable payload", async () => {
    emu = await startDiscordTestEmulator();
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    const closed = new Promise<number>((resolve) => conn.ws.once("close", (code) => resolve(code)));
    conn.ws.send("this is not json {{{");
    expect(await closed).toBe(4002);
  });

  it("4005 AlreadyAuthenticated: a second Identify on an identified session", async () => {
    emu = await startDiscordTestEmulator();
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    await identify(conn, Intents.Guilds);
    const closed = new Promise<number>((resolve) => conn.ws.once("close", (code) => resolve(code)));
    conn.ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: BOT_TOKEN, intents: 0 } }));
    expect(await closed).toBe(4005);
  });

  it("4009 SessionTimedOut: the client stops heartbeating (zombie)", async () => {
    emu = await startDiscordTestEmulator();
    emu.store.setData("discord.gateway.heartbeat_interval", 120); // fast zombie timer
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    const closed = new Promise<number>((resolve) => conn.ws.once("close", (code) => resolve(code)));
    await identify(conn, Intents.Guilds);
    expect(await closed).toBe(4009);
  });

  it("4008 RateLimited: the per-window command limit is exceeded", async () => {
    emu = await startDiscordTestEmulator();
    emu.store.setData("discord.gateway.command_limit", 3);
    emu.store.setData("discord.gateway.command_window_ms", 60_000);
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    const closed = new Promise<number>((resolve) => conn.ws.once("close", (code) => resolve(code)));
    await identify(conn, 0); // command 1
    for (let i = 0; i < 4; i++) conn.ws.send(JSON.stringify({ op: GatewayOpcodes.Heartbeat, d: null }));
    expect(await closed).toBe(4008);
  });

  it("4007 InvalidSeq: a Resume seq beyond anything dispatched", async () => {
    emu = await startDiscordTestEmulator();
    const first = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(first.ws);
    await first.next(); // Hello
    const ready = await identify(first, Intents.Guilds);
    const sessionId = (ready.d as { session_id: string }).session_id;
    first.ws.close();
    await waitForDisconnect(emu, sessionId);

    const second = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(second.ws);
    await second.next(); // Hello
    const closed = new Promise<number>((resolve) => second.ws.once("close", (code) => resolve(code)));
    second.ws.send(
      JSON.stringify({ op: GatewayOpcodes.Resume, d: { token: BOT_TOKEN, session_id: sessionId, seq: 999999 } }),
    );
    expect(await closed).toBe(4007);
  });
});

describe("gateway spec: Resume (op 6) -> Resumed / Invalid Session (op 9)", () => {
  let emu: RunningDiscordEmulator;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await emu?.close();
  });

  it("replays events missed while disconnected, then sends RESUMED (gateway.mdx Resuming)", async () => {
    emu = await startDiscordTestEmulator();
    const gid = getDiscordStore(emu.store).guilds.findOneBy("name", "Emulate Server")!.snowflake;

    const first = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(first.ws);
    await first.next(); // Hello
    const ready = await identify(first, Intents.Guilds | Intents.GuildMessages);
    const sessionId = (ready.d as { session_id: string }).session_id;
    const guildCreate = await first.waitFor("GUILD_CREATE");
    const lastSeq = guildCreate.s ?? 0;
    expect(lastSeq).toBeGreaterThan(0);

    first.ws.close();
    await waitForDisconnect(emu, sessionId);

    // A channel is created while we are away.
    const created = await fetch(api(`/guilds/${gid}/channels`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "while-away", type: 0 }),
    });
    const channel = (await created.json()) as { id: string };

    const second = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(second.ws);
    await second.next(); // Hello
    second.ws.send(
      JSON.stringify({ op: GatewayOpcodes.Resume, d: { token: BOT_TOKEN, session_id: sessionId, seq: lastSeq } }),
    );

    const replayed = await second.waitFor("CHANNEL_CREATE");
    expect((replayed.d as { id: string }).id).toBe(channel.id);
    // Replayed events keep sequence numbers beyond the client's last seq.
    expect(replayed.s ?? 0).toBeGreaterThan(lastSeq);
    const resumed = await second.waitFor("RESUMED");
    // RESUMED is a Dispatch signalling that replay has finished.
    expect(resumed.op).toBe(GatewayOpcodes.Dispatch);
  });

  it("rejects a Resume for an unknown session with Invalid Session (op 9), d=false", async () => {
    emu = await startDiscordTestEmulator();
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    conn.ws.send(JSON.stringify({ op: GatewayOpcodes.Resume, d: { token: BOT_TOKEN, session_id: "0000000000", seq: 5 } }));
    const invalid = await conn.waitForOp(GatewayOpcodes.InvalidSession);
    expect(invalid.op).toBe(9);
    expect(invalid.d).toBe(false);
  });

  it("rejects a Resume with a mismatched token via Invalid Session(false)", async () => {
    emu = await startDiscordTestEmulator();
    const first = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(first.ws);
    await first.next(); // Hello
    const ready = await identify(first, Intents.Guilds);
    const sessionId = (ready.d as { session_id: string }).session_id;
    first.ws.close();
    await waitForDisconnect(emu, sessionId);

    const second = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(second.ws);
    await second.next(); // Hello
    second.ws.send(
      JSON.stringify({ op: GatewayOpcodes.Resume, d: { token: "wrong_token", session_id: sessionId, seq: 1 } }),
    );
    const invalid = await second.waitForOp(GatewayOpcodes.InvalidSession);
    expect(invalid.d).toBe(false);
  });
});

describe("gateway spec: Request Guild Members (op 8) -> Guild Members Chunk", () => {
  let emu: RunningDiscordEmulator;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await emu?.close();
  });

  it("responds with a GUILD_MEMBERS_CHUNK containing members, chunk_index and chunk_count", async () => {
    emu = await startDiscordTestEmulator();
    const gid = getDiscordStore(emu.store).guilds.findOneBy("name", "Emulate Server")!.snowflake;
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    await identify(conn, Intents.Guilds | Intents.GuildMembers);
    await conn.waitFor("GUILD_CREATE");

    conn.ws.send(JSON.stringify({ op: GatewayOpcodes.RequestGuildMembers, d: { guild_id: gid, query: "", limit: 0 } }));
    const chunk = await conn.waitFor("GUILD_MEMBERS_CHUNK");
    const d = chunk.d as { guild_id: string; members: unknown[]; chunk_index: number; chunk_count: number };
    expect(d.guild_id).toBe(gid);
    expect(Array.isArray(d.members)).toBe(true);
    expect(d.members.length).toBeGreaterThan(0);
    // gateway-events.mdx Guild Members Chunk: 0 <= chunk_index < chunk_count.
    expect(d.chunk_index).toBe(0);
    expect(d.chunk_count).toBeGreaterThanOrEqual(1);
    expect(d.chunk_index).toBeLessThan(d.chunk_count);
  });

  it("echoes the nonce back on the chunk when one is supplied", async () => {
    emu = await startDiscordTestEmulator();
    const gid = getDiscordStore(emu.store).guilds.findOneBy("name", "Emulate Server")!.snowflake;
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    await identify(conn, Intents.Guilds | Intents.GuildMembers);
    await conn.waitFor("GUILD_CREATE");

    conn.ws.send(
      JSON.stringify({ op: GatewayOpcodes.RequestGuildMembers, d: { guild_id: gid, query: "", limit: 0, nonce: "abc123" } }),
    );
    const chunk = await conn.waitFor("GUILD_MEMBERS_CHUNK");
    expect((chunk.d as { nonce?: string }).nonce).toBe("abc123");
  });

  it("filters members by user_ids when supplied", async () => {
    emu = await startDiscordTestEmulator();
    const ds = getDiscordStore(emu.store);
    const gid = ds.guilds.findOneBy("name", "Emulate Server")!.snowflake;
    const botId = ds.users.findOneBy("username", "emulate-bot")!.snowflake;
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    await identify(conn, Intents.Guilds | Intents.GuildMembers);
    await conn.waitFor("GUILD_CREATE");

    conn.ws.send(JSON.stringify({ op: GatewayOpcodes.RequestGuildMembers, d: { guild_id: gid, user_ids: [botId] } }));
    const chunk = await conn.waitFor("GUILD_MEMBERS_CHUNK");
    const members = (chunk.d as { members: Array<{ user: { id: string } }> }).members;
    expect(members.length).toBe(1);
    expect(members[0].user.id).toBe(botId);
  });
});

describe("gateway spec: intent gating of Gateway events (gateway.mdx List of Intents)", () => {
  let emu: RunningDiscordEmulator;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await emu?.close();
  });

  /** Connect, identify with the given intents, and wait through READY + GUILD_CREATE. */
  async function ready(intents: number): Promise<Conn> {
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    await identify(conn, intents);
    await conn.waitFor("GUILD_CREATE");
    return conn;
  }

  it("delivers CHANNEL_CREATE under the GUILDS intent", async () => {
    emu = await startDiscordTestEmulator();
    const gid = getDiscordStore(emu.store).guilds.findOneBy("name", "Emulate Server")!.snowflake;
    const conn = await ready(Intents.Guilds);
    await fetch(api(`/guilds/${gid}/channels`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "gated-by-guilds", type: 0 }),
    });
    const event = await conn.waitFor("CHANNEL_CREATE");
    expect((event.d as { name: string }).name).toBe("gated-by-guilds");
  });

  it("withholds CHANNEL_CREATE when the GUILDS intent is absent", async () => {
    emu = await startDiscordTestEmulator();
    const gid = getDiscordStore(emu.store).guilds.findOneBy("name", "Emulate Server")!.snowflake;
    // GUILD_MESSAGES alone does not gate channel events; the bot is in the guild but won't see them.
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    await identify(conn, Intents.GuildMessages);

    await fetch(api(`/guilds/${gid}/channels`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "should-not-arrive", type: 0 }),
    });
    // No CHANNEL_CREATE within the window.
    await expect(conn.waitFor("CHANNEL_CREATE", 600)).rejects.toThrow();
  });

  it("delivers MESSAGE_CREATE under the GUILD_MESSAGES intent", async () => {
    emu = await startDiscordTestEmulator();
    const ds = getDiscordStore(emu.store);
    const channelId = ds.channels.findOneBy("name", "general")!.snowflake;
    const conn = await ready(Intents.Guilds | Intents.GuildMessages);
    await fetch(api(`/channels/${channelId}/messages`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "hello" }),
    });
    const event = await conn.waitFor("MESSAGE_CREATE");
    expect((event.d as { channel_id: string }).channel_id).toBe(channelId);
  });

  it("delivers GUILD_EMOJIS_UPDATE under the GUILD_EXPRESSIONS intent", async () => {
    emu = await startDiscordTestEmulator();
    const gid = getDiscordStore(emu.store).guilds.findOneBy("name", "Emulate Server")!.snowflake;
    const conn = await ready(Intents.Guilds | Intents.GuildExpressions);
    await fetch(api(`/guilds/${gid}/emojis`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      // image is a required field on Create Guild Emoji.
      body: JSON.stringify({ name: "blobspec", image: "data:image/png;base64,iVBORw0KGgo=" }),
    });
    const event = await conn.waitFor("GUILD_EMOJIS_UPDATE");
    expect((event.d as { emojis: Array<{ name: string }> }).emojis.some((e) => e.name === "blobspec")).toBe(true);
  });

  it("delivers GUILD_MEMBER_ADD only with the GUILD_MEMBERS intent (privileged-gated event)", async () => {
    emu = await startDiscordTestEmulator();
    const ds = getDiscordStore(emu.store);
    const gid = ds.guilds.findOneBy("name", "Emulate Server")!.snowflake;
    // A fresh user to add to the guild.
    const joiner = ds.users.insert({
      snowflake: "960000000000000123",
      username: "joiner",
      global_name: "Joiner",
      discriminator: "0",
      email: null,
      avatar: null,
      bot: false,
      system: false,
      mfa_enabled: false,
      flags: 0,
      public_flags: 0,
      premium_type: 0,
      accent_color: null,
      banner: null,
      locale: "en-US",
      verified: false,
    });
    const conn = await ready(Intents.Guilds | Intents.GuildMembers);
    await fetch(api(`/guilds/${gid}/members/${joiner.snowflake}`, emu.baseUrl), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({}),
    });
    const event = await conn.waitFor("GUILD_MEMBER_ADD");
    expect((event.d as { guild_id: string }).guild_id).toBe(gid);
  });
});

describe("gateway spec: MESSAGE_CONTENT redaction (gateway.mdx Message Content Intent)", () => {
  let emu: RunningDiscordEmulator;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await emu?.close();
  });

  /**
   * Send a message as the developer (a user who is not the receiving bot) so that the
   * receiving session is not the author and is not mentioned, isolating pure redaction.
   */
  async function postAsDeveloper(emuRef: RunningDiscordEmulator, channelId: string, content: string): Promise<void> {
    const ds = getDiscordStore(emuRef.store);
    const developer = ds.users.findOneBy("username", "developer")!;
    // Mint a bot-type token bound to the developer user so the REST message route accepts it
    // and authors the message as a non-bot-session user.
    const token = "developer_msg_token";
    if (!ds.tokens.findOneBy("token", token)) {
      ds.tokens.insert({ token, type: "bot", user_snowflake: developer.snowflake, application_snowflake: null, scopes: [], expires_at: null, refresh_token: null });
    }
    await fetch(api(`/channels/${channelId}/messages`, emuRef.baseUrl), {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  }

  it("redacts content/embeds/components/attachments without MESSAGE_CONTENT for a guild message the bot didn't author or get mentioned in", async () => {
    emu = await startDiscordTestEmulator();
    const channelId = getDiscordStore(emu.store).channels.findOneBy("name", "general")!.snowflake;
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    await identify(conn, Intents.Guilds | Intents.GuildMessages); // no MESSAGE_CONTENT
    await conn.waitFor("GUILD_CREATE");

    await postAsDeveloper(emu, channelId, "secret guild content");
    const event = await conn.waitFor("MESSAGE_CREATE");
    const d = event.d as { content: string; embeds: unknown[]; components: unknown[]; attachments: unknown[] };
    // Apps without the intent receive empty values in fields that contain user content.
    expect(d.content).toBe("");
    expect(d.embeds).toEqual([]);
    expect(d.components).toEqual([]);
    expect(d.attachments).toEqual([]);
  });

  it("includes full content with the MESSAGE_CONTENT intent", async () => {
    emu = await startDiscordTestEmulator();
    const channelId = getDiscordStore(emu.store).channels.findOneBy("name", "general")!.snowflake;
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    await identify(conn, Intents.Guilds | Intents.GuildMessages | Intents.MessageContent);
    await conn.waitFor("GUILD_CREATE");

    await postAsDeveloper(emu, channelId, "visible with intent");
    const event = await conn.waitFor("MESSAGE_CREATE");
    expect((event.d as { content: string }).content).toBe("visible with intent");
  });

  it("includes content even without the intent for a message the bot itself authored (exception)", async () => {
    emu = await startDiscordTestEmulator();
    const channelId = getDiscordStore(emu.store).channels.findOneBy("name", "general")!.snowflake;
    const conn = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(conn.ws);
    await conn.next(); // Hello
    await identify(conn, Intents.Guilds | Intents.GuildMessages); // no MESSAGE_CONTENT
    await conn.waitFor("GUILD_CREATE");

    // The receiving bot authors the message -> content is never redacted for its own messages.
    await fetch(api(`/channels/${channelId}/messages`, emu.baseUrl), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "my own message" }),
    });
    const event = await conn.waitFor("MESSAGE_CREATE");
    expect((event.d as { content: string }).content).toBe("my own message");
  });
});

// GET /gateway — no auth required (gateway.mdx:717-733)
// GET /gateway/bot — bot auth, returns url/shards/session_start_limit (gateway.mdx:738-779)

describe("gateway spec: GET /gateway and GET /gateway/bot REST shapes (gateway.mdx:717-779)", () => {
  it("GET /gateway returns 200 with a url string and requires no auth", async () => {
    const { app } = createDiscordTestApp();
    // No Authorization header — must succeed.
    const res = await app.request(api("/gateway"));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(typeof body.url).toBe("string");
    expect((body.url as string).length).toBeGreaterThan(0);
  });

  it("GET /gateway does not include session_start_limit (that is a /gateway/bot field)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/gateway"));
    const body = await json(res);
    // GET /gateway returns only {url}; no shards or session_start_limit.
    expect("session_start_limit" in body).toBe(false);
    expect("shards" in body).toBe(false);
  });

  it("GET /gateway/bot session_start_limit has all four documented fields at correct types (gateway.mdx:769-779)", async () => {
    // Doc: session_start_limit = { total, remaining, reset_after, max_concurrency } (all integers).
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/gateway/bot"), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const body = await json<{ session_start_limit: Record<string, unknown>; shards: unknown }>(res);
    const ssl = body.session_start_limit;
    expect(typeof ssl).toBe("object");
    expect(ssl).not.toBeNull();
    expect(typeof ssl.total).toBe("number");
    expect(typeof ssl.remaining).toBe("number");
    expect(typeof ssl.reset_after).toBe("number");
    expect(typeof ssl.max_concurrency).toBe("number");
    // Documented invariants: total >= remaining >= 0; max_concurrency >= 1.
    expect(ssl.total as number).toBeGreaterThanOrEqual(ssl.remaining as number);
    expect(ssl.remaining as number).toBeGreaterThanOrEqual(0);
    expect(ssl.max_concurrency as number).toBeGreaterThanOrEqual(1);
    // shards is an integer (gateway.mdx:769).
    expect(typeof body.shards).toBe("number");
    expect(Number.isInteger(body.shards)).toBe(true);
  });

  it("GET /gateway/bot requires a bot token (401 without auth)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/gateway/bot"));
    expect(res.status).toBe(401);
  });
});

describe("gateway spec: Reconnect (op 7) value (gateway-events.mdx Reconnect)", () => {
  it("declares Reconnect as opcode 7", () => {
    expect(GatewayOpcodes.Reconnect).toBe(7);
  });
  it("declares the send/receive opcodes at their documented values", () => {
    // gateway-events.mdx + opcodes: the opcodes referenced throughout the lifecycle.
    expect(GatewayOpcodes.Dispatch).toBe(0);
    expect(GatewayOpcodes.Heartbeat).toBe(1);
    expect(GatewayOpcodes.Identify).toBe(2);
    expect(GatewayOpcodes.PresenceUpdate).toBe(3);
    expect(GatewayOpcodes.VoiceStateUpdate).toBe(4);
    expect(GatewayOpcodes.Resume).toBe(6);
    expect(GatewayOpcodes.Reconnect).toBe(7);
    expect(GatewayOpcodes.RequestGuildMembers).toBe(8);
    expect(GatewayOpcodes.InvalidSession).toBe(9);
    expect(GatewayOpcodes.Hello).toBe(10);
    expect(GatewayOpcodes.HeartbeatAck).toBe(11);
  });
});
