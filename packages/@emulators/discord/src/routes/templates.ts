import { randomBytes } from "node:crypto";
import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore, type DiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, toAPIUser, toAPIGuild } from "../helpers.js";
import { createGuild, createChannel, createRole } from "../factories.js";
import type { DiscordGuildTemplate } from "../entities.js";

function toAPITemplate(t: DiscordGuildTemplate, ds: DiscordStore): Record<string, unknown> {
  const creator = t.creator_snowflake ? ds.users.findOneBy("snowflake", t.creator_snowflake) : null;
  const source = ds.guilds.findOneBy("snowflake", t.source_guild_snowflake);
  return {
    code: t.code,
    name: t.name,
    description: t.description,
    usage_count: t.usage_count,
    creator_id: t.creator_snowflake,
    creator: creator ? toAPIUser(creator) : null,
    created_at: t.created_at,
    updated_at: t.updated_at,
    source_guild_id: t.source_guild_snowflake,
    serialized_source_guild: source
      ? { name: source.name, description: source.description, region: null, channels: [], roles: [] }
      : null,
    is_dirty: null,
  };
}

export function templatesRoutes(ctx: DiscordRouteContext): void {
  const { app, store } = ctx;

  app.get("/api/v:version/guilds/templates/:code", (c) => {
    const ds = getDiscordStore(store);
    const template = ds.guildTemplates.findOneBy("code", c.req.param("code"));
    if (!template) return notFound(c);
    return c.json(toAPITemplate(template, ds));
  });

  app.get("/api/v:version/guilds/:guildId/templates", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    return c.json(ds.guildTemplates.findBy("source_guild_snowflake", c.req.param("guildId")).map((t) => toAPITemplate(t, ds)));
  });

  app.post("/api/v:version/guilds/:guildId/templates", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    if (!ds.guilds.findOneBy("snowflake", guildId)) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; description?: string };
    const template = ds.guildTemplates.insert({
      code: randomBytes(6).toString("base64url").slice(0, 10),
      source_guild_snowflake: guildId,
      name: typeof body.name === "string" ? body.name : "Template",
      description: typeof body.description === "string" ? body.description : null,
      usage_count: 0,
      creator_snowflake: auth.user?.snowflake ?? null,
    });
    return c.json(toAPITemplate(template, ds), 201);
  });

  app.put("/api/v:version/guilds/:guildId/templates/:code", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const template = ds.guildTemplates.findOneBy("code", c.req.param("code"));
    if (!template || template.source_guild_snowflake !== c.req.param("guildId")) return notFound(c);
    return c.json(toAPITemplate(template, ds)); // sync is a no-op (already reflects the source)
  });

  app.patch("/api/v:version/guilds/:guildId/templates/:code", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const template = ds.guildTemplates.findOneBy("code", c.req.param("code"));
    if (!template || template.source_guild_snowflake !== c.req.param("guildId")) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; description?: string };
    const patch: Partial<DiscordGuildTemplate> = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    ds.guildTemplates.update(template.id, patch);
    return c.json(toAPITemplate(ds.guildTemplates.findOneBy("code", template.code)!, ds));
  });

  app.delete("/api/v:version/guilds/:guildId/templates/:code", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const template = ds.guildTemplates.findOneBy("code", c.req.param("code"));
    if (!template || template.source_guild_snowflake !== c.req.param("guildId")) return notFound(c);
    const payload = toAPITemplate(template, ds);
    ds.guildTemplates.delete(template.id);
    return c.json(payload);
  });

  // Create a new guild from a template.
  app.post("/api/v:version/guilds/templates/:code", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.user == null) return unauthorized(c);
    const ds = getDiscordStore(store);
    const template = ds.guildTemplates.findOneBy("code", c.req.param("code"));
    if (!template) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const guild = createGuild(ds, { name: typeof body.name === "string" ? body.name : template.name, ownerSnowflake: auth.user.snowflake });
    // Seed a couple of default structures so the new guild is usable.
    createRole(ds, guild.snowflake, { name: "Member" });
    const category = createChannel(ds, { name: "Text Channels", type: 4, guildSnowflake: guild.snowflake });
    createChannel(ds, { name: "general", type: 0, guildSnowflake: guild.snowflake, parentSnowflake: category.snowflake });
    ds.guildTemplates.update(template.id, { usage_count: template.usage_count + 1 });
    return c.json(toAPIGuild(guild, ds, { full: true }), 201);
  });
}
