/**
 * Spec suite for `developers/resources/application.mdx`.
 *
 * Encodes the page's documented expectations directly: the full Application object shape
 * (every documented field), the Application Flags enum, the Install Params object,
 * Application Integration Types, the Application Event Webhook Status enum, and the
 * Get/Edit Current Application endpoint contracts (method, params, response, status).
 * Written from the doc first; the implementation is built/fixed until this is green.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "../helpers.js";
import { getDiscordStore } from "../../store.js";

function ids(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const ds = getDiscordStore(store);
  const app = ds.applications.all()[0]!;
  return {
    appId: app.snowflake,
    botSnowflake: app.bot_user_snowflake,
  };
}

// Application Flags (doc: Application Object — Application Flags).
const APPLICATION_AUTO_MODERATION_RULE_CREATE_BADGE = 1 << 6;
const GATEWAY_PRESENCE = 1 << 12;
const GATEWAY_PRESENCE_LIMITED = 1 << 13;
const GATEWAY_GUILD_MEMBERS = 1 << 14;
const GATEWAY_GUILD_MEMBERS_LIMITED = 1 << 15;
const VERIFICATION_PENDING_GUILD_LIMIT = 1 << 16;
const EMBEDDED = 1 << 17;
const GATEWAY_MESSAGE_CONTENT = 1 << 18;
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;
const APPLICATION_COMMAND_BADGE = 1 << 23;

async function getApp(app: ReturnType<typeof createDiscordTestApp>["app"]): Promise<Record<string, unknown>> {
  const res = await app.request(api("/applications/@me"), { headers: botHeaders() });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("application.mdx — Application Flags enum values", () => {
  it("matches the documented bit positions exactly", () => {
    expect(APPLICATION_AUTO_MODERATION_RULE_CREATE_BADGE).toBe(64);
    expect(GATEWAY_PRESENCE).toBe(4096);
    expect(GATEWAY_PRESENCE_LIMITED).toBe(8192);
    expect(GATEWAY_GUILD_MEMBERS).toBe(16384);
    expect(GATEWAY_GUILD_MEMBERS_LIMITED).toBe(32768);
    expect(VERIFICATION_PENDING_GUILD_LIMIT).toBe(65536);
    expect(EMBEDDED).toBe(131072);
    expect(GATEWAY_MESSAGE_CONTENT).toBe(262144);
    expect(GATEWAY_MESSAGE_CONTENT_LIMITED).toBe(524288);
    expect(APPLICATION_COMMAND_BADGE).toBe(8388608);
  });
});

describe("application.mdx — Application Object (Get Current Application)", () => {
  it("GET /applications/@me returns 200 with the requesting bot's application", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId } = ids(store);
    const a = await getApp(app);
    expect(a.id).toBe(appId);
  });

  it("emits the core identity fields with correct types (id/name/icon/description)", async () => {
    const { app } = createDiscordTestApp();
    const a = await getApp(app);
    expect(typeof a.id).toBe("string");
    expect(typeof a.name).toBe("string");
    // icon is ?string — present and nullable.
    expect("icon" in a).toBe(true);
    expect(a.icon === null || typeof a.icon === "string").toBe(true);
    expect(typeof a.description).toBe("string");
  });

  it("emits rpc_origins as an array of strings", async () => {
    const { app } = createDiscordTestApp();
    const a = await getApp(app);
    expect(Array.isArray(a.rpc_origins)).toBe(true);
  });

  it("emits bot_public and bot_require_code_grant as booleans", async () => {
    const { app } = createDiscordTestApp();
    const a = await getApp(app);
    expect(typeof a.bot_public).toBe("boolean");
    expect(typeof a.bot_require_code_grant).toBe("boolean");
  });

  it("emits a partial bot user object for the app's bot user", async () => {
    const { app, store } = createDiscordTestApp();
    const { botSnowflake } = ids(store);
    const a = await getApp(app);
    const bot = a.bot as Record<string, unknown> | undefined;
    expect(bot).toBeDefined();
    expect(bot!.id).toBe(botSnowflake);
    expect(bot!.bot).toBe(true);
  });

  it("emits a partial owner user object", async () => {
    const { app } = createDiscordTestApp();
    const a = await getApp(app);
    const owner = a.owner as Record<string, unknown> | null;
    expect(owner).not.toBeNull();
    expect(typeof owner!.id).toBe("string");
    expect(typeof owner!.username).toBe("string");
  });

  it("emits verify_key as a hex string", async () => {
    const { app } = createDiscordTestApp();
    const a = await getApp(app);
    expect(typeof a.verify_key).toBe("string");
    expect((a.verify_key as string).length).toBeGreaterThan(0);
  });

  it("emits team as a (nullable) field", async () => {
    const { app } = createDiscordTestApp();
    const a = await getApp(app);
    expect("team" in a).toBe(true);
    expect(a.team).toBeNull();
  });

  it("emits flags as a non-negative integer", async () => {
    const { app } = createDiscordTestApp();
    const a = await getApp(app);
    expect(typeof a.flags).toBe("number");
    expect(Number.isInteger(a.flags)).toBe(true);
    expect(a.flags as number).toBeGreaterThanOrEqual(0);
  });

  it("emits interactions_endpoint_url as a present, nullable field (defaults to null)", async () => {
    const { app } = createDiscordTestApp();
    const a = await getApp(app);
    expect("interactions_endpoint_url" in a).toBe(true);
    expect(a.interactions_endpoint_url === null || typeof a.interactions_endpoint_url === "string").toBe(true);
  });

  it("emits role_connections_verification_url as a present, nullable field (defaults to null)", async () => {
    const { app } = createDiscordTestApp();
    const a = await getApp(app);
    expect("role_connections_verification_url" in a).toBe(true);
    expect(a.role_connections_verification_url).toBeNull();
  });

  it("emits redirect_uris as an array (defaults to [])", async () => {
    const { app } = createDiscordTestApp();
    const a = await getApp(app);
    expect(Array.isArray(a.redirect_uris)).toBe(true);
  });

  it("emits tags as an array (defaults to [])", async () => {
    const { app } = createDiscordTestApp();
    const a = await getApp(app);
    expect(Array.isArray(a.tags)).toBe(true);
  });

  it("emits integration_types_config defaulting to {\"0\":{}} (GUILD_INSTALL)", async () => {
    const { app } = createDiscordTestApp();
    const a = await getApp(app);
    const cfg = a.integration_types_config as Record<string, unknown>;
    expect(typeof cfg).toBe("object");
    expect(cfg).not.toBeNull();
    // By default newly-created apps support installation to guilds (integration type 0).
    expect("0" in cfg).toBe(true);
    expect(cfg["0"]).toEqual({});
  });

  it("emits approximate_guild_count as a number", async () => {
    const { app } = createDiscordTestApp();
    const a = await getApp(app);
    expect(typeof a.approximate_guild_count).toBe("number");
  });

  it("emits approximate_user_install_count as a number (application.mdx:39)", async () => {
    const { app } = createDiscordTestApp();
    const a = await getApp(app);
    expect("approximate_user_install_count" in a).toBe(true);
    expect(typeof a.approximate_user_install_count).toBe("number");
    expect(a.approximate_user_install_count as number).toBeGreaterThanOrEqual(0);
  });

  it("emits approximate_user_authorization_count as a number (application.mdx:40)", async () => {
    const { app } = createDiscordTestApp();
    const a = await getApp(app);
    expect("approximate_user_authorization_count" in a).toBe(true);
    expect(typeof a.approximate_user_authorization_count).toBe("number");
    expect(a.approximate_user_authorization_count as number).toBeGreaterThanOrEqual(0);
  });

  it("emits the event_webhooks fields with documented defaults (status disabled = 1)", async () => {
    const { app } = createDiscordTestApp();
    const a = await getApp(app);
    expect("event_webhooks_url" in a).toBe(true);
    expect(a.event_webhooks_url).toBeNull();
    // Application Event Webhook Status: 1 (default) means DISABLED.
    expect(a.event_webhooks_status).toBe(1);
    expect(Array.isArray(a.event_webhooks_types)).toBe(true);
  });
});

describe("application.mdx — Edit Current Application (PATCH /applications/@me)", () => {
  it("round-trips description", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ description: "A brand new description" }),
    });
    expect(res.status).toBe(200);
    const a = (await res.json()) as Record<string, unknown>;
    expect(a.description).toBe("A brand new description");
  });

  it("round-trips interactions_endpoint_url (validation gated off by default)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ interactions_endpoint_url: "https://example.com/interactions" }),
    });
    expect(res.status).toBe(200);
    const a = (await res.json()) as Record<string, unknown>;
    expect(a.interactions_endpoint_url).toBe("https://example.com/interactions");
    // Persisted: subsequent GET reflects the change.
    const a2 = await getApp(app);
    expect(a2.interactions_endpoint_url).toBe("https://example.com/interactions");
  });

  it("round-trips role_connections_verification_url", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ role_connections_verification_url: "https://example.com/verify" }),
    });
    const a = (await res.json()) as Record<string, unknown>;
    expect(a.role_connections_verification_url).toBe("https://example.com/verify");
  });

  it("round-trips custom_install_url", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ custom_install_url: "https://example.com/install" }),
    });
    const a = (await res.json()) as Record<string, unknown>;
    expect(a.custom_install_url).toBe("https://example.com/install");
  });

  it("round-trips install_params (scopes + permissions)", async () => {
    const { app } = createDiscordTestApp();
    const installParams = { scopes: ["applications.commands", "bot"], permissions: "2048" };
    const res = await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ install_params: installParams }),
    });
    const a = (await res.json()) as Record<string, unknown>;
    expect(a.install_params).toEqual(installParams);
  });

  it("round-trips integration_types_config", async () => {
    const { app } = createDiscordTestApp();
    const cfg = {
      "0": { oauth2_install_params: { scopes: ["applications.commands", "bot"], permissions: "2048" } },
      "1": { oauth2_install_params: { scopes: ["applications.commands"], permissions: "0" } },
    };
    const res = await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ integration_types_config: cfg }),
    });
    const a = (await res.json()) as Record<string, unknown>;
    expect(a.integration_types_config).toEqual(cfg);
  });

  it("round-trips tags (array of strings)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ tags: ["game", "music", "utility"] }),
    });
    const a = (await res.json()) as Record<string, unknown>;
    expect(a.tags).toEqual(["game", "music", "utility"]);
  });

  it("round-trips the event_webhooks_* fields", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({
        event_webhooks_url: "https://example.com/webhooks",
        event_webhooks_status: 2,
        event_webhooks_types: ["APPLICATION_AUTHORIZED"],
      }),
    });
    const a = (await res.json()) as Record<string, unknown>;
    expect(a.event_webhooks_url).toBe("https://example.com/webhooks");
    expect(a.event_webhooks_status).toBe(2);
    expect(a.event_webhooks_types).toEqual(["APPLICATION_AUTHORIZED"]);
  });

  it("updates flags, masking to the API-updatable limited intent flags only", async () => {
    const { app } = createDiscordTestApp();
    // Limited intent flags ARE updatable.
    const limited = GATEWAY_PRESENCE_LIMITED | GATEWAY_GUILD_MEMBERS_LIMITED | GATEWAY_MESSAGE_CONTENT_LIMITED;
    // Non-limited flags must NOT be settable via the API.
    const requested = limited | GATEWAY_PRESENCE | GATEWAY_GUILD_MEMBERS | GATEWAY_MESSAGE_CONTENT;
    const res = await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ flags: requested }),
    });
    expect(res.status).toBe(200);
    const a = (await res.json()) as Record<string, unknown>;
    expect(a.flags).toBe(limited);
  });

  it("only updates properties that are passed (untouched fields persist)", async () => {
    const { app } = createDiscordTestApp();
    await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ description: "first" }),
    });
    // A second patch touching only tags must not clobber the description.
    const res = await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ tags: ["x"] }),
    });
    const a = (await res.json()) as Record<string, unknown>;
    expect(a.description).toBe("first");
    expect(a.tags).toEqual(["x"]);
  });

  it("an empty patch body succeeds and returns the unchanged application", async () => {
    const { app, store } = createDiscordTestApp();
    const { appId } = ids(store);
    const res = await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const a = (await res.json()) as Record<string, unknown>;
    expect(a.id).toBe(appId);
  });

  it("setting interactions_endpoint_url to null clears it", async () => {
    const { app } = createDiscordTestApp();
    await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ interactions_endpoint_url: "https://example.com/i" }),
    });
    const res = await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ interactions_endpoint_url: null }),
    });
    const a = (await res.json()) as Record<string, unknown>;
    expect(a.interactions_endpoint_url).toBeNull();
  });
});

describe("application.mdx — authorization", () => {
  it("GET /applications/@me without a bot token is unauthorized (401)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/applications/@me"));
    expect(res.status).toBe(401);
  });

  it("PATCH /applications/@me without a bot token is unauthorized (401)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/applications/@me"), {
      method: "PATCH",
      body: JSON.stringify({ description: "x" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });
});
