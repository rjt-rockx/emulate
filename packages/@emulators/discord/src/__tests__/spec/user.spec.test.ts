/**
 * Spec suite for `developers/resources/user.mdx`.
 *
 * Encodes the page's documented expectations directly: the User object shape and its
 * scope-gated fields, the connection/role-connection objects, and every endpoint's
 * request/response contract, limits, and behavioral notes. Written from the doc first;
 * the implementation is built/fixed until this is green.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json, seededIds } from "../helpers.js";
import { getDiscordStore } from "../../store.js";

function ids(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const s = seededIds(store);
  return {
    appId: s.app,
    botSnowflake: s.bot,
    developer: s.developer,
    guild: s.guild,
  };
}

describe("user.mdx — User object", () => {
  it("Get Current User returns the requester (bot) user with all identify-scope fields", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me"), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const u = await json(res);
    // Required identify fields (always present).
    expect(typeof u.id).toBe("string");
    expect(typeof u.username).toBe("string");
    expect(typeof u.discriminator).toBe("string");
    expect("global_name" in u).toBe(true);
    expect("avatar" in u).toBe(true);
    expect("public_flags" in u).toBe(true);
    // Nullable identify-scope objects must be present and null, not absent.
    expect(u.avatar_decoration_data).toBeNull();
    expect(u.collectibles).toBeNull();
    expect(u.primary_guild).toBeNull();
  });

  it("bot users carry the migrated discriminator '0'", async () => {
    const { app } = createDiscordTestApp();
    const u = (await (await app.request(api("/users/@me"), { headers: botHeaders() })).json()) as {
      discriminator: string;
      bot: boolean;
    };
    expect(u.bot).toBe(true);
    expect(u.discriminator).toBe("0");
  });

  it("@me exposes the email-scope and self-only fields (email/verified/mfa_enabled/flags/premium_type/locale)", async () => {
    const { app } = createDiscordTestApp();
    const u = (await (await app.request(api("/users/@me"), { headers: botHeaders() })).json()) as Record<string, unknown>;
    expect("email" in u).toBe(true);
    expect("verified" in u).toBe(true);
    expect("mfa_enabled" in u).toBe(true);
    expect("flags" in u).toBe(true);
    expect("premium_type" in u).toBe(true);
    expect("locale" in u).toBe(true);
    // premium_type is one of the documented Premium Types (0-3).
    expect([0, 1, 2, 3]).toContain(u.premium_type);
  });

  it("Get User (by id) returns a public user WITHOUT the email/self-only fields", async () => {
    const { app, store } = createDiscordTestApp();
    const { developer } = ids(store);
    const res = await app.request(api(`/users/${developer}`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const u = await json(res);
    expect(typeof u.id).toBe("string");
    expect("username" in u).toBe(true);
    expect("public_flags" in u).toBe(true);
    // Email and other self-only fields must NOT leak for a non-self fetch.
    expect("email" in u).toBe(false);
    expect("verified" in u).toBe(false);
    expect("mfa_enabled" in u).toBe(false);
    expect("premium_type" in u).toBe(false);
  });

  it("Get User for an unknown id returns 404 Unknown User (10013)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/999999999999999999"), { headers: botHeaders() });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10013);
  });
});

describe("user.mdx — Modify Current User", () => {
  it("applies username, avatar AND banner (all optional)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ username: "renamed-bot", avatar: "avatarhash", banner: "bannerhash" }),
    });
    expect(res.status).toBe(200);
    const u = await json(res);
    expect(u.username).toBe("renamed-bot");
    expect(u.avatar).toBe("avatarhash");
    expect(u.banner).toBe("bannerhash");
  });
});

describe("user.mdx — Get Current User Guilds", () => {
  it("returns partial guilds with id/name/icon/owner/permissions(string)/features", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me/guilds"), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const guilds = await json<Array<Record<string, unknown>>>(res);
    expect(guilds.length).toBeGreaterThan(0);
    const g = guilds[0];
    expect(typeof g.id).toBe("string");
    expect(typeof g.name).toBe("string");
    expect("icon" in g).toBe(true);
    expect(typeof g.owner).toBe("boolean");
    // permissions is the user's computed permission bitfield, serialized as a string.
    expect(typeof g.permissions).toBe("string");
    expect(Array.isArray(g.features)).toBe(true);
    // Counts are absent unless with_counts is requested.
    expect("approximate_member_count" in g).toBe(false);
  });

  it("with_counts=true adds approximate member and presence counts", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me/guilds?with_counts=true"), { headers: botHeaders() });
    const g = (await json<Array<Record<string, unknown>>>(res))[0];
    expect(typeof g.approximate_member_count).toBe("number");
    expect(typeof g.approximate_presence_count).toBe("number");
  });

  it("honors the limit query param (1-200)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me/guilds?limit=0"), { headers: botHeaders() });
    const guilds = await json<unknown[]>(res);
    expect(guilds.length).toBe(0);
  });
});

describe("user.mdx — guild membership endpoints", () => {
  it("Get Current User Guild Member returns the member object", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/users/@me/guilds/${guild}/member`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const m = await json(res);
    expect(Array.isArray(m.roles)).toBe(true);
    expect("joined_at" in m).toBe(true);
  });

  it("Leave Guild returns 204 and drops the membership", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, botSnowflake } = ids(store);
    const res = await app.request(api(`/users/@me/guilds/${guild}`), { method: "DELETE", headers: botHeaders() });
    expect(res.status).toBe(204);
    const ds = getDiscordStore(store);
    const stillMember = ds.members.findBy("guild_snowflake", guild).some((m) => m.user_snowflake === botSnowflake);
    expect(stillMember).toBe(false);
  });
});

describe("user.mdx — Create DM", () => {
  it("returns a DM channel (type 1) with the recipient, and is idempotent", async () => {
    const { app, store } = createDiscordTestApp();
    const { developer } = ids(store);
    const first = await app.request(api("/users/@me/channels"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ recipient_id: developer }),
    });
    expect(first.status).toBe(200);
    const dm = (await first.json()) as { id: string; type: number; recipients?: string[] };
    expect(dm.type).toBe(1);
    // Opening the same DM again returns the existing channel, not a new one.
    const second = await app.request(api("/users/@me/channels"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ recipient_id: developer }),
    });
    const dm2 = (await second.json()) as { id: string };
    expect(dm2.id).toBe(dm.id);
  });

  it("Create DM with an unknown recipient returns 404 Unknown User (10013)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me/channels"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ recipient_id: "999999999999999999" }),
    });
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10013);
  });
});

describe("user.mdx — Modify Current User username validation (U2)", () => {
  it("rejects a username shorter than 2 chars with 50035", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ username: "x" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects a username longer than 32 chars with 50035", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ username: "a".repeat(33) }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects a username containing '@' with 50035", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ username: "bad@name" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects a username containing 'discord' with 50035", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ username: "notadiscorduser" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects the reserved word 'everyone' with 50035", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ username: "everyone" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects the reserved word 'here' with 50035", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ username: "here" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("accepts a valid username that passes all rules", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ username: "valid-name-42" }),
    });
    expect(res.status).toBe(200);
    const u = await json<{ username: string }>(res);
    expect(u.username).toBe("valid-name-42");
  });
});

describe("user.mdx — Create Group DM (U1)", () => {
  it("returns a group DM channel (type 3) when access_tokens array is supplied", async () => {
    const { app, store } = createDiscordTestApp();
    const { developer } = ids(store);
    const res = await app.request(api("/users/@me/channels"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ access_tokens: [developer] }),
    });
    expect(res.status).toBe(200);
    const ch = await json<{ type: number }>(res);
    expect(ch.type).toBe(3);
  });

  it("group DM creation is idempotent — same member set returns existing channel", async () => {
    const { app, store } = createDiscordTestApp();
    const { developer } = ids(store);
    const first = await app.request(api("/users/@me/channels"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ access_tokens: [developer] }),
    });
    const ch1 = (await first.json()) as { id: string };
    const second = await app.request(api("/users/@me/channels"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ access_tokens: [developer] }),
    });
    const ch2 = (await second.json()) as { id: string };
    expect(ch2.id).toBe(ch1.id);
  });
});

describe("user.mdx — connections & role connection", () => {
  it("Get Current User Connections returns an array", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/users/@me/connections"), { headers: botHeaders() });
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("Update + Get Application Role Connection round-trips platform_name/platform_username/metadata", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId } = ids(store);
    const put = await app.request(api(`/users/@me/applications/${appId}/role-connection`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ platform_name: "Chess.com", platform_username: "grandmaster", metadata: { rank: "100" } }),
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as Record<string, unknown>;
    expect(body.platform_name).toBe("Chess.com");
    expect(body.platform_username).toBe("grandmaster");
    expect((body.metadata as Record<string, string>).rank).toBe("100");

    const get = await app.request(api(`/users/@me/applications/${appId}/role-connection`), { headers: botHeaders() });
    const fetched = (await get.json()) as Record<string, unknown>;
    expect(fetched.platform_name).toBe("Chess.com");
  });

  it("Delete Application Role Connection returns 204", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId } = ids(store);
    const res = await app.request(api(`/users/@me/applications/${appId}/role-connection`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(204);
  });
});
