import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, snowflake } from "../helpers.js";
import { Intents } from "../gateway/intents.js";
import type { DiscordStageInstance, DiscordAutoModRule } from "../entities.js";

function toAPIStage(s: DiscordStageInstance): Record<string, unknown> {
  return {
    id: s.snowflake,
    guild_id: s.guild_snowflake,
    channel_id: s.channel_snowflake,
    topic: s.topic,
    privacy_level: s.privacy_level,
    discoverable_disabled: s.discoverable_disabled,
    guild_scheduled_event_id: null,
  };
}

function toAPIAutoMod(r: DiscordAutoModRule): Record<string, unknown> {
  return {
    id: r.snowflake,
    guild_id: r.guild_snowflake,
    creator_id: r.creator_snowflake,
    name: r.name,
    event_type: r.event_type,
    trigger_type: r.trigger_type,
    trigger_metadata: r.trigger_metadata,
    actions: r.actions,
    enabled: r.enabled,
    exempt_roles: r.exempt_roles,
    exempt_channels: r.exempt_channels,
  };
}

export function moderationRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  // ----- Stage instances -----
  app.post("/api/v:version/stage-instances", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const channel = typeof body.channel_id === "string" ? ds.channels.findOneBy("snowflake", body.channel_id) : null;
    if (!channel) return notFound(c);
    const stage = ds.stageInstances.insert({
      snowflake: snowflake(),
      guild_snowflake: channel.guild_snowflake ?? "",
      channel_snowflake: channel.snowflake,
      topic: typeof body.topic === "string" ? body.topic : "",
      privacy_level: typeof body.privacy_level === "number" ? body.privacy_level : 2,
      discoverable_disabled: true,
    });
    const payload = toAPIStage(stage);
    bus.publish({ t: "STAGE_INSTANCE_CREATE", guildId: stage.guild_snowflake, requiredIntents: Intents.Guilds, d: payload });
    return c.json(payload, 201);
  });

  app.get("/api/v:version/stage-instances/:channelId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const stage = ds.stageInstances.findOneBy("channel_snowflake", c.req.param("channelId"));
    if (!stage) return notFound(c);
    return c.json(toAPIStage(stage));
  });

  app.patch("/api/v:version/stage-instances/:channelId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const stage = ds.stageInstances.findOneBy("channel_snowflake", c.req.param("channelId"));
    if (!stage) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.topic === "string") ds.stageInstances.update(stage.id, { topic: body.topic });
    const payload = toAPIStage(ds.stageInstances.findOneBy("snowflake", stage.snowflake)!);
    bus.publish({ t: "STAGE_INSTANCE_UPDATE", guildId: stage.guild_snowflake, requiredIntents: Intents.Guilds, d: payload });
    return c.json(payload);
  });

  app.delete("/api/v:version/stage-instances/:channelId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const stage = ds.stageInstances.findOneBy("channel_snowflake", c.req.param("channelId"));
    if (!stage) return notFound(c);
    const payload = toAPIStage(stage);
    ds.stageInstances.delete(stage.id);
    bus.publish({ t: "STAGE_INSTANCE_DELETE", guildId: stage.guild_snowflake, requiredIntents: Intents.Guilds, d: payload });
    return new Response(null, { status: 204 });
  });

  // ----- Auto-moderation rules -----
  app.get("/api/v:version/guilds/:guildId/auto-moderation/rules", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    return c.json(ds.autoModRules.findBy("guild_snowflake", c.req.param("guildId")).map(toAPIAutoMod));
  });

  app.get("/api/v:version/guilds/:guildId/auto-moderation/rules/:ruleId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const rule = ds.autoModRules.findOneBy("snowflake", c.req.param("ruleId"));
    if (!rule || rule.guild_snowflake !== c.req.param("guildId")) return notFound(c);
    return c.json(toAPIAutoMod(rule));
  });

  app.post("/api/v:version/guilds/:guildId/auto-moderation/rules", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    if (!ds.guilds.findOneBy("snowflake", guildId)) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const rule = ds.autoModRules.insert({
      snowflake: snowflake(),
      guild_snowflake: guildId,
      creator_snowflake: auth.user?.snowflake ?? null,
      name: typeof body.name === "string" ? body.name : "rule",
      event_type: typeof body.event_type === "number" ? body.event_type : 1,
      trigger_type: typeof body.trigger_type === "number" ? body.trigger_type : 1,
      trigger_metadata: (body.trigger_metadata as Record<string, unknown>) ?? {},
      actions: (body.actions as unknown[]) ?? [],
      enabled: body.enabled !== false,
      exempt_roles: (body.exempt_roles as string[]) ?? [],
      exempt_channels: (body.exempt_channels as string[]) ?? [],
    });
    const payload = toAPIAutoMod(rule);
    bus.publish({ t: "AUTO_MODERATION_RULE_CREATE", guildId, requiredIntents: Intents.AutoModerationConfiguration, d: payload });
    return c.json(payload, 201);
  });

  app.patch("/api/v:version/guilds/:guildId/auto-moderation/rules/:ruleId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const rule = ds.autoModRules.findOneBy("snowflake", c.req.param("ruleId"));
    if (!rule || rule.guild_snowflake !== c.req.param("guildId")) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Partial<DiscordAutoModRule> = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (body.actions !== undefined) patch.actions = body.actions as unknown[];
    if (body.trigger_metadata !== undefined) patch.trigger_metadata = body.trigger_metadata as Record<string, unknown>;
    ds.autoModRules.update(rule.id, patch);
    const payload = toAPIAutoMod(ds.autoModRules.findOneBy("snowflake", rule.snowflake)!);
    bus.publish({ t: "AUTO_MODERATION_RULE_UPDATE", guildId: rule.guild_snowflake, requiredIntents: Intents.AutoModerationConfiguration, d: payload });
    return c.json(payload);
  });

  app.delete("/api/v:version/guilds/:guildId/auto-moderation/rules/:ruleId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const rule = ds.autoModRules.findOneBy("snowflake", c.req.param("ruleId"));
    if (!rule || rule.guild_snowflake !== c.req.param("guildId")) return notFound(c);
    const payload = toAPIAutoMod(rule);
    ds.autoModRules.delete(rule.id);
    bus.publish({ t: "AUTO_MODERATION_RULE_DELETE", guildId: rule.guild_snowflake, requiredIntents: Intents.AutoModerationConfiguration, d: payload });
    return new Response(null, { status: 204 });
  });
}
