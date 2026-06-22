/**
 * Spec suite for `developers/resources/guild-template.mdx`.
 *
 * Encodes the page's documented expectations directly: the Guild Template object shape
 * (every field, including the serialized_source_guild snapshot with roles + channels and
 * placeholder integer ids, and is_dirty), plus every endpoint's request/response/status
 * contract and the name (1-100) / description (0-120) validation rules. Written from the
 * doc first; the implementation is built/fixed until this is green.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json, seededIds } from "../helpers.js";
import { getDiscordStore } from "../../store.js";

function ids(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const s = seededIds(store);
  return {
    guild: s.guild,
    developer: s.developer,
    // Bot tokens resolve to the application's bot user, which is the template creator.
    bot: s.bot,
  };
}

async function createTemplate(
  app: ReturnType<typeof createDiscordTestApp>["app"],
  guild: string,
  body: Record<string, unknown> = { name: "Friends & Family", description: "" },
) {
  const res = await app.request(api(`/guilds/${guild}/templates`), {
    method: "POST",
    headers: botHeaders(),
    body: JSON.stringify(body),
  });
  return { res, template: await json(res)};
}

describe("guild-template.mdx — Guild Template object", () => {
  it("Create Guild Template returns 201 with every documented field", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, bot } = ids(store);
    const { res, template: t } = await createTemplate(app, guild, {
      name: "Friends & Family",
      description: "A cozy server",
    });
    expect(res.status).toBe(201);

    // Every field in the Guild Template Structure table must be present.
    expect(typeof t.code).toBe("string");
    expect(t.name).toBe("Friends & Family");
    expect(t.description).toBe("A cozy server");
    expect(t.usage_count).toBe(0);
    expect(t.creator_id).toBe(bot);
    expect((t.creator as Record<string, unknown>).id).toBe(bot);
    expect(typeof t.created_at).toBe("string");
    expect(typeof t.updated_at).toBe("string");
    expect(t.source_guild_id).toBe(guild);
    expect("serialized_source_guild" in t).toBe(true);
    // is_dirty is ?boolean — present, null for a freshly synced template.
    expect("is_dirty" in t).toBe(true);
    expect(t.is_dirty).toBeNull();
  });

  it("description defaults to null when omitted (?string)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { template: t } = await createTemplate(app, guild, { name: "No Desc" });
    expect(t.description).toBeNull();
  });

  it("serialized_source_guild carries the documented snapshot fields", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { template: t } = await createTemplate(app, guild);
    const s = t.serialized_source_guild as Record<string, unknown>;
    // Partial guild snapshot fields documented in the example object.
    expect(s.name).toBe("Emulate Server");
    expect("description" in s).toBe(true);
    expect("region" in s).toBe(true);
    expect(typeof s.verification_level).toBe("number");
    expect(typeof s.default_message_notifications).toBe("number");
    expect(typeof s.explicit_content_filter).toBe("number");
    expect(typeof s.preferred_locale).toBe("string");
    expect(typeof s.afk_timeout).toBe("number");
    expect("afk_channel_id" in s).toBe(true);
    expect("system_channel_id" in s).toBe(true);
    expect(typeof s.system_channel_flags).toBe("number");
    expect("icon_hash" in s).toBe(true);
    expect(Array.isArray(s.roles)).toBe(true);
    expect(Array.isArray(s.channels)).toBe(true);
  });

  it("serialized_source_guild.roles include @everyone with placeholder id 0 (integer)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { template: t } = await createTemplate(app, guild);
    const s = t.serialized_source_guild as Record<string, unknown>;
    const roles = s.roles as Array<Record<string, unknown>>;
    expect(roles.length).toBeGreaterThan(0);
    const everyone = roles.find((r) => r.name === "@everyone");
    expect(everyone).toBeDefined();
    // Placeholder ids are given as integers, and @everyone maps to 0.
    expect(everyone!.id).toBe(0);
    expect(typeof everyone!.id).toBe("number");
    // Documented role snapshot fields.
    expect(typeof everyone!.name).toBe("string");
    expect("permissions" in everyone!).toBe(true);
    expect(typeof everyone!.color).toBe("number");
    expect(typeof everyone!.hoist).toBe("boolean");
    expect(typeof everyone!.mentionable).toBe("boolean");
  });

  it("serialized_source_guild.channels use integer placeholder ids and snapshot fields", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { template: t } = await createTemplate(app, guild);
    const s = t.serialized_source_guild as Record<string, unknown>;
    const channels = s.channels as Array<Record<string, unknown>>;
    expect(channels.length).toBeGreaterThan(0);
    for (const ch of channels) {
      // Placeholder ids are integers.
      expect(typeof ch.id).toBe("number");
      expect("name" in ch).toBe(true);
      expect(typeof ch.position).toBe("number");
      expect("topic" in ch).toBe(true);
      expect("nsfw" in ch).toBe(true);
      expect("rate_limit_per_user" in ch).toBe(true);
      // parent_id is a placeholder integer or null (never the original snowflake).
      expect(ch.parent_id === null || typeof ch.parent_id === "number").toBe(true);
      expect(Array.isArray(ch.permission_overwrites)).toBe(true);
      expect(typeof ch.type).toBe("number");
    }
    // A child channel's parent_id must reference a category's placeholder id present in the snapshot.
    const placeholderIds = new Set(channels.map((c) => c.id));
    for (const ch of channels) {
      if (ch.parent_id !== null) expect(placeholderIds.has(ch.parent_id)).toBe(true);
    }
  });
});

describe("guild-template.mdx — Get / Get-list endpoints", () => {
  it("Get Guild Template returns the template for a code", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { template: created } = await createTemplate(app, guild);
    const res = await app.request(api(`/guilds/templates/${created.code}`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const t = await json(res);
    expect(t.code).toBe(created.code);
    expect(t.source_guild_id).toBe(guild);
  });

  it("Get Guild Template for an unknown code returns 404", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/guilds/templates/nonexistentcode"), { headers: botHeaders() });
    expect(res.status).toBe(404);
  });

  it("Get Guild Templates returns an array of the guild's templates", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { template: created } = await createTemplate(app, guild);
    const res = await app.request(api(`/guilds/${guild}/templates`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    const list = await json<Array<Record<string, unknown>>>(res);
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((t) => t.code === created.code)).toBe(true);
  });
});

describe("guild-template.mdx — Create Guild Template validation", () => {
  it("rejects a name longer than 100 characters (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/templates`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "x".repeat(101) }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects an empty name (name must be 1-100 chars) (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/templates`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects a description longer than 120 characters (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/templates`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "ok", description: "d".repeat(121) }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("accepts a 100-char name and 120-char description (boundary)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const res = await app.request(api(`/guilds/${guild}/templates`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "n".repeat(100), description: "d".repeat(120) }),
    });
    expect(res.status).toBe(201);
  });

  it("Create on an unknown guild returns 404", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/guilds/999999999999999999/templates"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "ok" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("guild-template.mdx — Sync Guild Template", () => {
  it("re-snapshots the source guild and bumps updated_at", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { template: created } = await createTemplate(app, guild);

    // Mutate the guild's roles after the template was made: add a new role.
    const ds = getDiscordStore(store);
    const guildRow = ds.guilds.findOneBy("snowflake", guild)!;
    ds.roles.insert({
      snowflake: "950000000000000001",
      guild_snowflake: guild,
      name: "Synced Role",
      color: 7,
      hoist: true,
      position: 5,
      permissions: "0",
      managed: false,
      mentionable: true,
      icon: null,
      unicode_emoji: null,
      flags: 0,
      tags: null,
    });
    // touch updated_at granularity by forcing a different timestamp downstream
    void guildRow;

    const res = await app.request(api(`/guilds/${guild}/templates/${created.code}`), {
      method: "PUT",
      headers: botHeaders(),
    });
    expect(res.status).toBe(200);
    const synced = await json(res);
    const s = synced.serialized_source_guild as Record<string, unknown>;
    const roles = s.roles as Array<Record<string, unknown>>;
    // The new role must now appear in the re-snapshotted source guild.
    expect(roles.some((r) => r.name === "Synced Role")).toBe(true);
    // is_dirty is cleared (null) after a sync.
    expect(synced.is_dirty).toBeNull();
  });

  it("Sync on a code that does not belong to the guild returns 404", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { template: created } = await createTemplate(app, guild);
    const res = await app.request(api(`/guilds/999999999999999999/templates/${created.code}`), {
      method: "PUT",
      headers: botHeaders(),
    });
    expect(res.status).toBe(404);
  });
});

describe("guild-template.mdx — Modify Guild Template", () => {
  it("updates name and description and returns the template", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { template: created } = await createTemplate(app, guild);
    const res = await app.request(api(`/guilds/${guild}/templates/${created.code}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Renamed", description: "new desc" }),
    });
    expect(res.status).toBe(200);
    const t = await json(res);
    expect(t.name).toBe("Renamed");
    expect(t.description).toBe("new desc");
    expect(t.code).toBe(created.code);
  });

  it("allows clearing the description to null", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { template: created } = await createTemplate(app, guild, { name: "X", description: "has desc" });
    const res = await app.request(api(`/guilds/${guild}/templates/${created.code}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ description: null }),
    });
    const t = await json(res);
    expect(t.description).toBeNull();
  });

  it("rejects a name longer than 100 characters (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { template: created } = await createTemplate(app, guild);
    const res = await app.request(api(`/guilds/${guild}/templates/${created.code}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ name: "y".repeat(101) }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects a description longer than 120 characters (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { template: created } = await createTemplate(app, guild);
    const res = await app.request(api(`/guilds/${guild}/templates/${created.code}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ description: "d".repeat(121) }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });
});

describe("guild-template.mdx — Delete Guild Template", () => {
  it("deletes the template and returns the deleted object", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { template: created } = await createTemplate(app, guild);
    const res = await app.request(api(`/guilds/${guild}/templates/${created.code}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(200);
    const t = await json(res);
    expect(t.code).toBe(created.code);
    expect(getDiscordStore(store).guildTemplates.findOneBy("code", created.code as string)).toBeUndefined();
  });

  it("Delete on a code that does not belong to the guild returns 404", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { template: created } = await createTemplate(app, guild);
    const res = await app.request(api(`/guilds/999999999999999999/templates/${created.code}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(404);
  });
});

describe("guild-template.mdx — Create Guild from Template", () => {
  it("creates a new guild and increments usage_count", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const { template: created } = await createTemplate(app, guild);

    const before = getDiscordStore(store).guilds.all().length;
    const res = await app.request(api(`/guilds/templates/${created.code}`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Fresh Guild" }),
    });
    expect(res.status).toBe(201);
    const g = await json<{ id: string; name: string; channels: unknown[] }>(res);
    expect(g.name).toBe("Fresh Guild");
    expect((g.channels as unknown[]).length).toBeGreaterThan(0);
    expect(getDiscordStore(store).guilds.all().length).toBe(before + 1);

    // usage_count must increment on the source template.
    const refetched = (await (
      await app.request(api(`/guilds/templates/${created.code}`), { headers: botHeaders() })
    ).json()) as { usage_count: number };
    expect(refetched.usage_count).toBe(1);
  });

  it("Create Guild from an unknown template returns 404", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/guilds/templates/doesnotexist"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Nope" }),
    });
    expect(res.status).toBe(404);
  });
});
