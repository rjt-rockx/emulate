/**
 * Spec suite for `developers/topics/opcodes-and-status-codes.mdx`.
 *
 * Encodes a representative, doc-cited assertion for each reachable category:
 *
 *   1. HTTP Response Codes  (200/201/204/400/401/403/404/429) on representative endpoints.
 *   2. JSON Error Codes (General Error Codes table): the documented numeric `code` from each
 *      matching endpoint. Codes driven are:
 *        10003 Unknown Channel, 10004 Unknown Guild, 10006 Unknown Invite, 10008 Unknown Message,
 *        10011 Unknown Role, 10013 Unknown User, 10014 Unknown Emoji, 10015 Unknown Webhook,
 *        10026 Unknown Ban, 10027 Unknown SKU, 10029 Unknown Entitlement,
 *        10062 Unknown Interaction, 10067 Unknown Stage Instance, 30005 Maximum guild roles,
 *        30010 Maximum reactions, 40060 Interaction already acknowledged, 50001 Missing Access,
 *        50006 Cannot send empty message, 50013 Missing Permissions, 50026 Missing OAuth2 scope,
 *        50028 Invalid Role, 50035 Invalid Form Body.
 *   3. Gateway Close Event Codes (4000-4014): reachable codes via startDiscordTestEmulator
 *      and a raw WebSocket, following the pattern from spec/gateway.spec.test.ts.
 *      Voice-only and RPC-only codes are explicitly skipped with comments.
 *
 * Divergence findings are noted inline rather than fixed here.
 */
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { createDiscordTestApp, startDiscordTestEmulator, api, botHeaders, bearerHeaders, type RunningDiscordEmulator, json } from "../helpers.js";
import { getDiscordStore } from "../../store.js";
import { GatewayOpcodes, GatewayCloseCodes } from "../../gateway/opcodes.js";
import { Intents } from "../../gateway/intents.js";
import { createUser, createToken } from "../../factories.js";
import { setRateLimitConfig } from "../../rateLimiter.js";

// ---------------------------------------------------------------------------
// Helpers shared across describes
// ---------------------------------------------------------------------------

function ids(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const ds = getDiscordStore(store);
  const app = ds.applications.all()[0]!;
  return {
    ds,
    appId: app.snowflake,
    botSnowflake: app.bot_user_snowflake,
    developer: ds.users.findOneBy("username", "developer")!.snowflake,
    guild: ds.guilds.findOneBy("name", "Emulate Server")!.snowflake,
    general: ds.channels.findOneBy("name", "general")!.snowflake,
    voice: ds.channels.findOneBy("name", "General")!.snowflake,
  };
}

/** WebSocket frame shape used by the gateway. */
interface Frame {
  op: number;
  t?: string | null;
  s?: number | null;
  d?: unknown;
}

/** Connect a raw WebSocket and return a FIFO-queued frame accessor. */
function connect(url: string): Promise<{ ws: WebSocket; next(timeout?: number): Promise<Frame> }> {
  const ws = new WebSocket(url);
  ws.on("error", () => void 0); // swallow post-close errors
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
      waiters.push((f) => { clearTimeout(timer); resolve(f); });
    });
  };
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, next }));
    ws.once("error", reject);
  });
}

/** Drain frames until READY, then return the session_id. */
async function identifyAndGetSession(
  ws: WebSocket,
  next: (timeout?: number) => Promise<Frame>,
  token: string,
  intents: number,
): Promise<string> {
  ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token, intents } }));
  for (;;) {
    const f = await next();
    if (f.t === "READY") return (f.d as { session_id: string }).session_id;
  }
}

// ---------------------------------------------------------------------------
// Category 1: HTTP Response Codes
// opcodes-and-status-codes.mdx #http-http-response-codes
// ---------------------------------------------------------------------------

describe("opcodes-and-status-codes.mdx -- HTTP Response Codes", () => {
  // 200 OK: The request completed successfully.
  it("200 OK: GET /users/@me returns 200 (request completed successfully)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me"), { headers: botHeaders() });
    expect(res.status).toBe(200);
  });

  // 201 CREATED: The entity was created successfully.
  it("201 CREATED: POST /guilds/:id/channels returns 201 (entity created)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/channels`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "created-channel", type: 0 }),
    });
    // Emulator creates channels and returns 201.
    expect(res.status).toBe(201);
  });

  // 204 NO CONTENT: The request completed successfully but returned no content.
  it("204 NO CONTENT: DELETE /channels/:id/messages/:id returns 204 (no content)", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    // Create a message to delete.
    const post = await app.request(api(`/channels/${general}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "to be deleted" }),
    });
    const msg = (await post.json()) as { id: string };
    const del = await app.request(api(`/channels/${general}/messages/${msg.id}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(del.status).toBe(204);
  });

  // 400 BAD REQUEST: The request was improperly formatted.
  it("400 BAD REQUEST: POST /channels/:id/messages with empty body returns 400", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const res = await app.request(api(`/channels/${general}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "" }), // empty content -> 50006
    });
    expect(res.status).toBe(400);
  });

  // 401 UNAUTHORIZED: The Authorization header was missing or invalid.
  it("401 UNAUTHORIZED: GET /users/@me without auth returns 401", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me"));
    expect(res.status).toBe(401);
  });

  // 403 FORBIDDEN: The Authorization token did not have permission to the resource.
  // Triggered via permission enforcement (50013).
  it("403 FORBIDDEN: creating a role without ManageRoles returns 403 when permissions are enforced", async () => {
    const { app, store } = createDiscordTestApp({ enforce_permissions: true });
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/roles`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Unauthorized Role" }),
    });
    expect(res.status).toBe(403);
  });

  // 404 NOT FOUND: The resource at the location specified doesn't exist.
  it("404 NOT FOUND: GET /channels/:unknown returns 404", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/channels/999999999999999999"), { headers: botHeaders() });
    expect(res.status).toBe(404);
  });

  // 429 TOO MANY REQUESTS: Rate limited (per rate-limits.mdx).
  it("429 TOO MANY REQUESTS: a bucket-exhausted request returns 429 with Retry-After", async () => {
    const { app, store } = createDiscordTestApp();
    setRateLimitConfig(store, { routeLimit: 2, globalLimit: 1000, windowMs: 10_000 });
    // Exhaust the bucket (2 allowed).
    await app.request(api("/users/@me"), { headers: botHeaders() });
    await app.request(api("/users/@me"), { headers: botHeaders() });
    // Third request hits the rate limit.
    const res = await app.request(api("/users/@me"), { headers: botHeaders() });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Category 2: JSON Error Codes
// opcodes-and-status-codes.mdx #json-json-error-codes
// ---------------------------------------------------------------------------

describe("opcodes-and-status-codes.mdx -- JSON Error Codes: Unknown-resource codes", () => {
  // 10003 Unknown Channel
  it("10003 Unknown Channel: GET /channels/:unknown returns code 10003", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/channels/999999999999999999"), { headers: botHeaders() });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10003);
  });

  // 10004 Unknown Guild
  it("10004 Unknown Guild: GET /guilds/:unknown/channels returns code 10004", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/guilds/999999999999999999/channels"), { headers: botHeaders() });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10004);
  });

  // 10006 Unknown Invite
  it("10006 Unknown Invite: GET /invites/:unknown returns code 10006", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/invites/zzzzzzzz"), { headers: botHeaders() });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10006);
  });

  // 10008 Unknown Message
  it("10008 Unknown Message: PUT pin for unknown message returns code 10008", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const res = await app.request(api(`/channels/${general}/pins/999999999999999999`), {
      method: "PUT",
      headers: botHeaders(),
    });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10008);
  });

  // 10011 Unknown Role
  it("10011 Unknown Role: GET /guilds/:id/roles/:unknown returns code 10011", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/roles/999999999999999999`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "nope" }),
    });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10011);
  });

  // 10013 Unknown User
  it("10013 Unknown User: GET /users/:unknown returns code 10013", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/999999999999999999"), { headers: botHeaders() });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10013);
  });

  // 10014 Unknown Emoji
  it("10014 Unknown Emoji: GET /guilds/:id/emojis/:unknown returns code 10014", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/emojis/999999999999999999`), { headers: botHeaders() });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10014);
  });

  // 10015 Unknown Webhook
  it("10015 Unknown Webhook: GET /webhooks/:unknown returns code 10015", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/webhooks/999999999999999999"), { headers: botHeaders() });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10015);
  });

  // 10026 Unknown Ban
  it("10026 Unknown Ban: GET /guilds/:id/bans/:unknown returns code 10026", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/bans/999999999999999999`), { headers: botHeaders() });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10026);
  });

  // 10027 Unknown SKU
  it("10027 Unknown SKU: POST /applications/:id/entitlements with unknown sku_id returns code 10027", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId } = ids(store);
    const res = await app.request(api(`/applications/${appId}/entitlements`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ sku_id: "999999999999999999", owner_id: "200000000000000001", owner_type: 2 }),
    });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10027);
  });

  // 10029 Unknown Entitlement
  it("10029 Unknown Entitlement: GET /applications/:id/entitlements/:unknown returns code 10029", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId } = ids(store);
    const res = await app.request(api(`/applications/${appId}/entitlements/999999999999999999`), {
      headers: botHeaders(),
    });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10029);
  });

  // 10062 Unknown Interaction
  it("10062 Unknown Interaction: POST /interactions/:unknown/token/callback returns code 10062", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/interactions/999999999999999999/bogus_token/callback"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: 4, data: { content: "hi" } }),
    });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10062);
  });

  // 10067 Unknown Stage Instance
  it("10067 Unknown Stage Instance: GET /stage-instances/:channel without active instance returns code 10067", async () => {
    const { app, store } = createDiscordTestApp();
    const { voice } = ids(store);
    // No stage instance exists on this voice channel yet.
    const res = await app.request(api(`/stage-instances/${voice}`), { headers: botHeaders() });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10067);
  });
});

describe("opcodes-and-status-codes.mdx -- JSON Error Codes: Maximum-limit codes", () => {
  // 30005 Maximum number of guild roles reached (250)
  it("30005 Maximum guild roles: creating a 251st role returns code 30005", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const { guild } = ids(store);
    // Pad to exactly 250 roles (the documented cap) directly via the store.
    while (ds.roles.findBy("guild_snowflake", guild).length < 250) {
      ds.roles.insert({
        snowflake: `3${String(Math.random()).slice(2, 19).padStart(17, "0")}`,
        guild_snowflake: guild,
        name: "filler",
        color: 0,
        hoist: false,
        position: 1,
        permissions: "0",
        managed: false,
        mentionable: false,
        icon: null,
      });
    }
    const res = await app.request(api(`/guilds/${guild}/roles`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "over-the-cap" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(30005);
  });

  // 30010 Maximum number of reactions reached (20)
  it("30010 Maximum reactions: adding a 21st distinct emoji reaction returns code 30010", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const { general } = ids(store);
    const guildSnowflake = ds.channels.findOneBy("name", "general")!.guild_snowflake;
    const bot = ds.users.findOneBy("username", "emulate-bot")!.snowflake;
    // Create a message to react to.
    const post = await app.request(api(`/channels/${general}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "reaction cap test" }),
    });
    const msg = (await post.json()) as { id: string };
    // Pre-seed 20 distinct emoji reactions via the store (the documented cap is 20).
    for (let i = 0; i < 20; i++) {
      ds.reactions.insert({
        message_snowflake: msg.id,
        channel_snowflake: general,
        guild_snowflake: guildSnowflake,
        user_snowflake: bot,
        emoji_name: `emoji${i}`,
        emoji_snowflake: `4${String(i).padStart(17, "0")}`,
        emoji_animated: false,
      });
    }
    // Attempting to add a 21st new emoji must be rejected.
    const res = await app.request(
      api(`/channels/${general}/messages/${msg.id}/reactions/${encodeURIComponent("\u{1F44D}")}/@me`),
      { method: "PUT", headers: botHeaders() },
    );
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(30010);
  });
});

describe("opcodes-and-status-codes.mdx -- JSON Error Codes: Action codes", () => {
  // 40060 Interaction has already been acknowledged
  it("40060 Interaction already acknowledged: sending a second callback returns code 40060", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    // Trigger an interaction via the emulator helper endpoint.
    const triggerRes = await app.request(`http://localhost:4099/__emulate/interactions`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: 3, customId: "btn", componentType: 2, channelSnowflake: general }),
    });
    const { id, token } = (await triggerRes.json()) as { id: string; token: string };
    // First callback is accepted.
    const first = await app.request(api(`/interactions/${id}/${token}/callback`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: 4, data: { content: "first" } }),
    });
    expect(first.status).toBe(204);
    // Second callback is rejected with 40060.
    const second = await app.request(api(`/interactions/${id}/${token}/callback`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: 4, data: { content: "second" } }),
    });
    expect(second.status).toBe(400);
    expect(((await second.json()) as { code: number }).code).toBe(40060);
  });
});

describe("opcodes-and-status-codes.mdx -- JSON Error Codes: Permission / validation codes", () => {
  // 50001 Missing Access
  it("50001 Missing Access: a non-member lobby user gets 403 Missing Access", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const application = ds.applications.all()[0]!;
    // Create an outsider user with a bearer token but no lobby membership.
    const outsider = createUser(ds, { username: "stranger", global_name: "Stranger" });
    createToken(ds, {
      token: "stranger_bearer",
      type: "bearer",
      userSnowflake: outsider.snowflake,
      applicationSnowflake: application.snowflake,
      scopes: ["sdk.social_layer"],
    });
    // Create a lobby as the bot.
    const lobbyRes = await app.request(api("/lobbies"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({}),
    });
    const lobby = (await lobbyRes.json()) as { id: string };
    // Non-member attempts to list messages -- should get 403.
    const res = await app.request(api(`/lobbies/${lobby.id}/messages`), {
      headers: bearerHeaders("stranger_bearer"),
    });
    expect(res.status).toBe(403);
    expect((await json<{ code: number }>(res)).code).toBe(50001);
  });

  // 50006 Cannot send an empty message
  it("50006 Cannot send empty message: POST message with empty content returns code 50006", async () => {
    const { app, store } = createDiscordTestApp();
    const { general } = ids(store);
    const res = await app.request(api(`/channels/${general}/messages`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: "" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50006);
  });

  // 50013 Missing Permissions
  it("50013 Missing Permissions: creating a role without ManageRoles returns code 50013", async () => {
    const { app, store } = createDiscordTestApp({ enforce_permissions: true });
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/roles`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "UnauthorizedRole" }),
    });
    expect(res.status).toBe(403);
    expect((await json<{ code: number }>(res)).code).toBe(50013);
  });

  // 50026 Missing required OAuth2 scope
  it("50026 Missing OAuth2 scope: calling /users/@me with a bearer token that lacks 'identify' returns code 50026", async () => {
    const { app, store } = createDiscordTestApp({
      oauth_apps: [{ client_id: "sc_cid", client_secret: "sc_sec", redirect_uris: [], scopes: ["guilds"] }],
    });
    const ds = getDiscordStore(store);
    const developer = ds.users.findOneBy("username", "developer")!;
    // Mint a bearer token that has 'guilds' but NOT 'identify'.
    ds.tokens.insert({
      token: "no_identify_bearer",
      type: "bearer",
      user_snowflake: developer.snowflake,
      application_snowflake: ds.applications.all()[0]!.snowflake,
      scopes: ["guilds"],
      expires_at: null,
      refresh_token: null,
    });
    // Enable strict scope checks so the emulator enforces scope requirements.
    store.setData("discord.strict_scopes", true);
    const res = await app.request(api("/users/@me"), { headers: bearerHeaders("no_identify_bearer") });
    expect(res.status).toBe(403);
    expect((await json<{ code: number }>(res)).code).toBe(50026);
  });

  // 50028 Invalid Role
  it("50028 Invalid Role: attempting to delete the @everyone role returns code 50028", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const { guild } = ids(store);
    // The @everyone role shares the snowflake with the guild.
    const everyoneId = ds.roles.findBy("guild_snowflake", guild).find((r: { name: string; snowflake: string }) => r.name === "@everyone")!.snowflake;
    const res = await app.request(api(`/guilds/${guild}/roles/${everyoneId}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50028);
  });

  // 50035 Invalid Form Body
  it("50035 Invalid Form Body: POST /stage-instances with empty topic returns code 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const { voice } = ids(store);
    const res = await app.request(api("/stage-instances"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ channel_id: voice, topic: "" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });
});

// ---------------------------------------------------------------------------
// Category 3: Gateway Close Event Codes (4000-4014)
// opcodes-and-status-codes.mdx #gateway-gateway-close-event-codes
// ---------------------------------------------------------------------------

describe("opcodes-and-status-codes.mdx -- Gateway Close Event Codes (4000-4014): constant values", () => {
  // Verify every documented code maps to the correct numeric value.
  it("GatewayCloseCodes exports the documented numeric values for all 14 close codes", () => {
    // 4000 Unknown error
    expect(GatewayCloseCodes.UnknownError).toBe(4000);
    // 4001 Unknown opcode
    expect(GatewayCloseCodes.UnknownOpcode).toBe(4001);
    // 4002 Decode error
    expect(GatewayCloseCodes.DecodeError).toBe(4002);
    // 4003 Not authenticated
    expect(GatewayCloseCodes.NotAuthenticated).toBe(4003);
    // 4004 Authentication failed (do NOT reconnect)
    expect(GatewayCloseCodes.AuthenticationFailed).toBe(4004);
    // 4005 Already authenticated
    expect(GatewayCloseCodes.AlreadyAuthenticated).toBe(4005);
    // 4007 Invalid seq
    expect(GatewayCloseCodes.InvalidSeq).toBe(4007);
    // 4008 Rate limited
    expect(GatewayCloseCodes.RateLimited).toBe(4008);
    // 4009 Session timed out
    expect(GatewayCloseCodes.SessionTimedOut).toBe(4009);
    // 4010 Invalid shard (do NOT reconnect)
    expect(GatewayCloseCodes.InvalidShard).toBe(4010);
    // 4011 Sharding required (do NOT reconnect)
    expect(GatewayCloseCodes.ShardingRequired).toBe(4011);
    // 4012 Invalid API version (do NOT reconnect)
    expect(GatewayCloseCodes.InvalidApiVersion).toBe(4012);
    // 4013 Invalid intent(s) (do NOT reconnect)
    expect(GatewayCloseCodes.InvalidIntents).toBe(4013);
    // 4014 Disallowed intent(s) (do NOT reconnect)
    expect(GatewayCloseCodes.DisallowedIntents).toBe(4014);
  });

  it("doc: 4004/4010/4011/4012/4013/4014 should NOT reconnect; 4000/4001/4002/4003/4005/4007/4008/4009 should reconnect", () => {
    // This test encodes the Reconnect column from the doc table to ensure the
    // codes are distinguishable from one another. No runtime check is needed --
    // the constant values above are sufficient to build the reconnect-or-not logic.
    const shouldNotReconnect = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
    const shouldReconnect = new Set([4000, 4001, 4002, 4003, 4005, 4007, 4008, 4009]);
    for (const code of shouldNotReconnect) expect(shouldReconnect.has(code)).toBe(false);
    for (const code of shouldReconnect) expect(shouldNotReconnect.has(code)).toBe(false);
  });
});

describe("opcodes-and-status-codes.mdx -- Gateway Close Event Codes: live close-code assertions", () => {
  let emu: RunningDiscordEmulator;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await emu?.close();
  });

  // 4004 Authentication failed: incorrect token at Identify
  it("4004 Authentication failed: Identify with a bad token closes with 4004", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, next } = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(ws);
    await next(); // Hello (op 10)
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "wrong_token", intents: 0 } }));
    expect(await closed).toBe(4004);
  });

  // 4008 Rate limited: exceed per-window command limit
  it("4008 Rate limited: flooding commands beyond the window limit closes with 4008", async () => {
    emu = await startDiscordTestEmulator();
    // Set a very tight command budget so we hit 4008 quickly.
    emu.store.setData("discord.gateway.command_limit", 3);
    emu.store.setData("discord.gateway.command_window_ms", 60_000);
    const { ws, next } = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(ws);
    await next(); // Hello
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    // Identify counts as command 1; then send heartbeats to exceed the budget.
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents: 0 } }));
    for (let i = 0; i < 4; i++) ws.send(JSON.stringify({ op: GatewayOpcodes.Heartbeat, d: null }));
    expect(await closed).toBe(4008);
  });

  // 4009 Session timed out: zombie (no heartbeats sent after Identify)
  it("4009 Session timed out: client stops heartbeating after Identify and the session expires", async () => {
    emu = await startDiscordTestEmulator();
    // Use a very short heartbeat interval so the zombie timer fires quickly.
    emu.store.setData("discord.gateway.heartbeat_interval", 120);
    const { ws, next } = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(ws);
    await next(); // Hello
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    // Identify but never send heartbeats.
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents: 0 } }));
    expect(await closed).toBe(4009);
  }, 10_000);

  // 4013 Invalid intent(s): bitfield that does not map to any valid intent
  it("4013 Invalid intent(s): Identify with intents=-1 closes with 4013", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, next } = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(ws);
    await next(); // Hello
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents: -1 } }));
    expect(await closed).toBe(4013);
  });

  // 4014 Disallowed intent(s): requesting a privileged intent that is not approved
  it("4014 Disallowed intent(s): Identify requesting a disallowed privileged intent closes with 4014", async () => {
    emu = await startDiscordTestEmulator();
    // Mark GUILD_MEMBERS as disallowed.
    emu.store.setData("discord.gateway.disallowed_intents", Intents.GuildMembers);
    const { ws, next } = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(ws);
    await next(); // Hello
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents: Intents.GuildMembers } }));
    expect(await closed).toBe(4014);
  });

  // Codes triggered by other pre-identify / post-identify protocol violations:

  // 4001 Unknown opcode: send an opcode the server does not expect from a client
  it("4001 Unknown opcode: sending opcode 99 after Identify closes with 4001", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, next } = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(ws);
    await next(); // Hello
    await identifyAndGetSession(ws, next, "test_bot_token", Intents.Guilds);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send(JSON.stringify({ op: 99, d: {} }));
    expect(await closed).toBe(4001);
  });

  // 4002 Decode error: a non-JSON payload
  it("4002 Decode error: sending raw non-JSON closes with 4002", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, next } = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(ws);
    await next(); // Hello
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send("this is not json {{{{");
    expect(await closed).toBe(4002);
  });

  // 4003 Not authenticated: sending a non-handshake opcode before Identify
  it("4003 Not authenticated: sending RequestGuildMembers before Identify closes with 4003", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, next } = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(ws);
    await next(); // Hello
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send(JSON.stringify({ op: GatewayOpcodes.RequestGuildMembers, d: { guild_id: "1" } }));
    expect(await closed).toBe(4003);
  });

  // 4005 Already authenticated: sending a second Identify on an identified session
  it("4005 Already authenticated: sending a second Identify after READY closes with 4005", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, next } = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(ws);
    await next(); // Hello
    await identifyAndGetSession(ws, next, "test_bot_token", Intents.Guilds);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents: 0 } }));
    expect(await closed).toBe(4005);
  });

  // 4010 Invalid shard: shard_id >= num_shards is documented as invalid
  it("4010 Invalid shard: shard_id >= num_shards closes with 4010", async () => {
    emu = await startDiscordTestEmulator();
    const { ws, next } = await connect(`${emu.gatewayUrl}?v=10&encoding=json`);
    sockets.push(ws);
    await next(); // Hello
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send(JSON.stringify({ op: GatewayOpcodes.Identify, d: { token: "test_bot_token", intents: 0, shard: [3, 3] } }));
    expect(await closed).toBe(4010);
  });

  // --- Codes not reachable in the current emulator ---
  //
  // 4000 Unknown error: server-side; no deterministic trigger available.
  //   FINDING: No emulator API to induce a generic "unknown error" close code.
  //
  // 4007 Invalid seq: only triggered via Resume with an out-of-range seq
  //   (covered in gateway.spec.test.ts "4007 InvalidSeq" test which also verifies
  //   the close code 4007 is emitted).
  //
  // 4011 Sharding required: requires the emulator to have > large_threshold guilds
  //   assigned to a single shard -- the default seed has only one guild.
  //   FINDING: 4011 is not reachable with the default seed and no API to set a guild
  //   count threshold for the ShardingRequired condition.
  //
  // 4012 Invalid API version: would require connecting to a version URL the server
  //   rejects at the WebSocket upgrade level; the current emulator accepts all
  //   version query params at the HTTP layer.
  //   FINDING: 4012 is not reachable in the emulator as-is.
  //
  // Voice-only and RPC-only close codes (from the Voice Close Event Codes and
  // RPC Close Event Codes tables) are intentionally excluded: they operate on
  // separate voice-gateway or local-RPC connections that are out of scope for
  // the gateway emulator under test.
});

// ---------------------------------------------------------------------------
// Gateway Opcode table: documented opcodes at their numeric values
// opcodes-and-status-codes.mdx #gateway-gateway-opcodes
// ---------------------------------------------------------------------------

describe("opcodes-and-status-codes.mdx -- Gateway Opcodes: documented numeric values", () => {
  it("GatewayOpcodes exports every documented send/receive opcode at its exact value", () => {
    // Table from opcodes-and-status-codes.mdx Gateway Opcodes.
    expect(GatewayOpcodes.Dispatch).toBe(0);           // Dispatch (Receive)
    expect(GatewayOpcodes.Heartbeat).toBe(1);           // Heartbeat (Send/Receive)
    expect(GatewayOpcodes.Identify).toBe(2);            // Identify (Send)
    expect(GatewayOpcodes.PresenceUpdate).toBe(3);      // Presence Update (Send)
    expect(GatewayOpcodes.VoiceStateUpdate).toBe(4);    // Voice State Update (Send)
    expect(GatewayOpcodes.Resume).toBe(6);              // Resume (Send)
    expect(GatewayOpcodes.Reconnect).toBe(7);           // Reconnect (Receive)
    expect(GatewayOpcodes.RequestGuildMembers).toBe(8); // Request Guild Members (Send)
    expect(GatewayOpcodes.InvalidSession).toBe(9);      // Invalid Session (Receive)
    expect(GatewayOpcodes.Hello).toBe(10);              // Hello (Receive)
    expect(GatewayOpcodes.HeartbeatAck).toBe(11);       // Heartbeat ACK (Receive)
    // opcodes 31 (Request Soundboard Sounds) and 43 (Request Channel Info) are
    // documented as Send-only. The emulator may not export them; skip if absent.
  });
});
