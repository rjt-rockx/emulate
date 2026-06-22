import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import {
  getAuth,
  unauthorized,
  notFound,
  unknownChannel,
  unknownGuild,
  unknownStageInstance,
  invalidFormBody,
  toAPIStageInstance,
  snowflake,
  recordAudit,
  AuditLogEvent,
  auditReason,
} from "../helpers.js";
import { Intents } from "../gateway/intents.js";
import type { DiscordAutoModRule } from "../entities.js";

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

// ----- Auto Moderation enums (from the docs) -----
const TRIGGER_TYPES = new Set([1, 3, 4, 5, 6]); // KEYWORD, SPAM, KEYWORD_PRESET, MENTION_SPAM, MEMBER_PROFILE
const EVENT_TYPES = new Set([1, 2]); // MESSAGE_SEND, MEMBER_UPDATE
const ACTION_TYPES = new Set([1, 2, 3, 4]); // BLOCK_MESSAGE, SEND_ALERT_MESSAGE, TIMEOUT, BLOCK_MEMBER_INTERACTION
const KEYWORD_PRESET_TYPES = new Set([1, 2, 3]); // PROFANITY, SEXUAL_CONTENT, SLURS

// Per-trigger-type maximum number of rules per guild.
const MAX_RULES_PER_GUILD: Record<number, number> = {
  1: 6, // KEYWORD
  3: 1, // SPAM
  4: 1, // KEYWORD_PRESET
  5: 1, // MENTION_SPAM
  6: 1, // MEMBER_PROFILE
};

// Trigger metadata field/limit constraints, keyed by trigger type.
const TIMEOUT_MAX_DURATION = 2419200; // 4 weeks, in seconds
const CUSTOM_MESSAGE_MAX = 150;
const MENTION_TOTAL_LIMIT_MAX = 50;
const KEYWORD_FILTER_MAX_ARRAY = 1000;
const KEYWORD_FILTER_MAX_CHARS = 60;
const REGEX_PATTERNS_MAX_ARRAY = 10;
const REGEX_PATTERNS_MAX_CHARS = 260;
const ALLOW_LIST_MAX_CHARS = 60;
const ALLOW_LIST_KEYWORD_MAX_ARRAY = 100; // KEYWORD / MEMBER_PROFILE
const ALLOW_LIST_PRESET_MAX_ARRAY = 1000; // KEYWORD_PRESET

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Validate an automod rule body's enum + metadata shape against the docs.
 * Returns a map of field->message for invalidFormBody, or null when valid.
 * `requireType` distinguishes create (trigger/event required) from modify (all optional).
 */
function validateAutoModRuleBody(
  body: Record<string, unknown>,
  triggerType: number,
  requireEvent: boolean,
): Record<string, string> | null {
  const errors: Record<string, string> = {};

  if (requireEvent) {
    if (typeof body.event_type !== "number" || !EVENT_TYPES.has(body.event_type)) {
      errors.event_type = "Value must be one of (1, 2).";
    }
  } else if (body.event_type !== undefined) {
    if (typeof body.event_type !== "number" || !EVENT_TYPES.has(body.event_type)) {
      errors.event_type = "Value must be one of (1, 2).";
    }
  }

  if (!TRIGGER_TYPES.has(triggerType)) {
    errors.trigger_type = "Value must be one of (1, 3, 4, 5, 6).";
  }

  // Actions array + each action's type enum and required metadata.
  if (body.actions !== undefined) {
    if (!Array.isArray(body.actions)) {
      errors.actions = "This field is required.";
    } else {
      body.actions.forEach((raw, i) => {
        const action = raw as Record<string, unknown>;
        const type = action?.type;
        if (typeof type !== "number" || !ACTION_TYPES.has(type)) {
          errors[`actions.${i}.type`] = "Value must be one of (1, 2, 3, 4).";
          return;
        }
        const metadata = (action.metadata as Record<string, unknown> | undefined) ?? undefined;
        if (type === 2) {
          // SEND_ALERT_MESSAGE requires channel_id.
          if (!metadata || typeof metadata.channel_id !== "string") {
            errors[`actions.${i}.metadata.channel_id`] = "This field is required.";
          }
        } else if (type === 3) {
          // TIMEOUT requires duration_seconds (<= 2419200).
          if (!metadata || typeof metadata.duration_seconds !== "number") {
            errors[`actions.${i}.metadata.duration_seconds`] = "This field is required.";
          } else if (metadata.duration_seconds > TIMEOUT_MAX_DURATION) {
            errors[`actions.${i}.metadata.duration_seconds`] = `Value must be 1 day, ${TIMEOUT_MAX_DURATION} seconds or less.`;
          }
        } else if (type === 1) {
          // BLOCK_MESSAGE custom_message is optional but capped at 150 chars.
          if (metadata && typeof metadata.custom_message === "string" && metadata.custom_message.length > CUSTOM_MESSAGE_MAX) {
            errors[`actions.${i}.metadata.custom_message`] = `Must be ${CUSTOM_MESSAGE_MAX} or fewer in length.`;
          }
        }
      });
    }
  }

  // Trigger metadata shape / array & character limits.
  if (body.trigger_metadata !== undefined && body.trigger_metadata !== null) {
    if (typeof body.trigger_metadata !== "object") {
      errors.trigger_metadata = "Value must be an object.";
    } else {
      const tm = body.trigger_metadata as Record<string, unknown>;
      if (tm.keyword_filter !== undefined) {
        if (!isStringArray(tm.keyword_filter)) {
          errors["trigger_metadata.keyword_filter"] = "Value must be an array of strings.";
        } else if (tm.keyword_filter.length > KEYWORD_FILTER_MAX_ARRAY) {
          errors["trigger_metadata.keyword_filter"] = `Must be ${KEYWORD_FILTER_MAX_ARRAY} or fewer in length.`;
        } else if (tm.keyword_filter.some((k) => k.length > KEYWORD_FILTER_MAX_CHARS)) {
          errors["trigger_metadata.keyword_filter"] = `Each keyword must be ${KEYWORD_FILTER_MAX_CHARS} or fewer in length.`;
        }
      }
      if (tm.regex_patterns !== undefined) {
        if (!isStringArray(tm.regex_patterns)) {
          errors["trigger_metadata.regex_patterns"] = "Value must be an array of strings.";
        } else if (tm.regex_patterns.length > REGEX_PATTERNS_MAX_ARRAY) {
          errors["trigger_metadata.regex_patterns"] = `Must be ${REGEX_PATTERNS_MAX_ARRAY} or fewer in length.`;
        } else if (tm.regex_patterns.some((p) => p.length > REGEX_PATTERNS_MAX_CHARS)) {
          errors["trigger_metadata.regex_patterns"] = `Each pattern must be ${REGEX_PATTERNS_MAX_CHARS} or fewer in length.`;
        }
      }
      if (tm.presets !== undefined) {
        if (!Array.isArray(tm.presets) || !tm.presets.every((p) => typeof p === "number" && KEYWORD_PRESET_TYPES.has(p))) {
          errors["trigger_metadata.presets"] = "Value must be an array of (1, 2, 3).";
        }
      }
      if (tm.allow_list !== undefined) {
        const allowMax = triggerType === 4 ? ALLOW_LIST_PRESET_MAX_ARRAY : ALLOW_LIST_KEYWORD_MAX_ARRAY;
        if (!isStringArray(tm.allow_list)) {
          errors["trigger_metadata.allow_list"] = "Value must be an array of strings.";
        } else if (tm.allow_list.length > allowMax) {
          errors["trigger_metadata.allow_list"] = `Must be ${allowMax} or fewer in length.`;
        } else if (tm.allow_list.some((k) => k.length > ALLOW_LIST_MAX_CHARS)) {
          errors["trigger_metadata.allow_list"] = `Each keyword must be ${ALLOW_LIST_MAX_CHARS} or fewer in length.`;
        }
      }
      if (tm.mention_total_limit !== undefined) {
        if (typeof tm.mention_total_limit !== "number" || tm.mention_total_limit > MENTION_TOTAL_LIMIT_MAX) {
          errors["trigger_metadata.mention_total_limit"] = `Value must be ${MENTION_TOTAL_LIMIT_MAX} or fewer.`;
        }
      }
      if (tm.mention_raid_protection_enabled !== undefined && typeof tm.mention_raid_protection_enabled !== "boolean") {
        errors["trigger_metadata.mention_raid_protection_enabled"] = "Value must be a boolean.";
      }
    }
  }

  return Object.keys(errors).length > 0 ? errors : null;
}

export function moderationRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  // ----- Stage instances -----
  app.post("/api/v:version/stage-instances", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    // channel_id and topic (1-120) are required per the create JSON params.
    if (typeof body.topic !== "string" || body.topic.length < 1 || body.topic.length > 120) {
      return invalidFormBody(c, { topic: "Must be between 1 and 120 in length." });
    }
    const channel = typeof body.channel_id === "string" ? ds.channels.findOneBy("snowflake", body.channel_id) : null;
    if (!channel) return unknownChannel(c);

    let privacyLevel = 2; // default GUILD_ONLY
    if (body.privacy_level !== undefined) {
      if (typeof body.privacy_level !== "number" || (body.privacy_level !== 1 && body.privacy_level !== 2)) {
        return invalidFormBody(c, { privacy_level: "Value must be one of (1, 2)." });
      }
      privacyLevel = body.privacy_level;
    }

    const scheduledEvent =
      typeof body.guild_scheduled_event_id === "string" ? body.guild_scheduled_event_id : null;

    const stage = ds.stageInstances.insert({
      snowflake: snowflake(),
      guild_snowflake: channel.guild_snowflake ?? "",
      channel_snowflake: channel.snowflake,
      topic: body.topic,
      privacy_level: privacyLevel,
      discoverable_disabled: true,
      guild_scheduled_event_snowflake: scheduledEvent,
    });
    const payload = toAPIStageInstance(stage);
    bus.publish({ t: "STAGE_INSTANCE_CREATE", guildId: stage.guild_snowflake, requiredIntents: Intents.Guilds, d: payload });
    recordAudit(ds, bus, {
      guildSnowflake: stage.guild_snowflake,
      actionType: AuditLogEvent.StageInstanceCreate,
      actorSnowflake: auth.user?.snowflake ?? null,
      targetSnowflake: stage.snowflake,
      changes: [{ key: "topic", new_value: stage.topic }],
      reason: auditReason(c),
    });
    return c.json(payload, 201);
  });

  app.get("/api/v:version/stage-instances/:channelId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const stage = ds.stageInstances.findOneBy("channel_snowflake", c.req.param("channelId"));
    if (!stage) return unknownStageInstance(c);
    return c.json(toAPIStageInstance(stage));
  });

  app.patch("/api/v:version/stage-instances/:channelId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const stage = ds.stageInstances.findOneBy("channel_snowflake", c.req.param("channelId"));
    if (!stage) return unknownStageInstance(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const stageChanges: unknown[] = [];
    const patch: Record<string, unknown> = {};
    if (typeof body.topic === "string") {
      if (body.topic.length < 1 || body.topic.length > 120) {
        return invalidFormBody(c, { topic: "Must be between 1 and 120 in length." });
      }
      stageChanges.push({ key: "topic", old_value: stage.topic, new_value: body.topic });
      patch.topic = body.topic;
    }
    if (body.privacy_level !== undefined) {
      if (typeof body.privacy_level !== "number" || (body.privacy_level !== 1 && body.privacy_level !== 2)) {
        return invalidFormBody(c, { privacy_level: "Value must be one of (1, 2)." });
      }
      stageChanges.push({ key: "privacy_level", old_value: stage.privacy_level, new_value: body.privacy_level });
      patch.privacy_level = body.privacy_level;
    }
    if (Object.keys(patch).length > 0) ds.stageInstances.update(stage.id, patch);
    const payload = toAPIStageInstance(ds.stageInstances.findOneBy("snowflake", stage.snowflake)!);
    bus.publish({ t: "STAGE_INSTANCE_UPDATE", guildId: stage.guild_snowflake, requiredIntents: Intents.Guilds, d: payload });
    if (stageChanges.length > 0) {
      recordAudit(ds, bus, {
        guildSnowflake: stage.guild_snowflake,
        actionType: AuditLogEvent.StageInstanceUpdate,
        actorSnowflake: auth.user?.snowflake ?? null,
        targetSnowflake: stage.snowflake,
        changes: stageChanges,
        reason: auditReason(c),
      });
    }
    return c.json(payload);
  });

  app.delete("/api/v:version/stage-instances/:channelId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const stage = ds.stageInstances.findOneBy("channel_snowflake", c.req.param("channelId"));
    if (!stage) return unknownStageInstance(c);
    const payload = toAPIStageInstance(stage);
    ds.stageInstances.delete(stage.id);
    bus.publish({ t: "STAGE_INSTANCE_DELETE", guildId: stage.guild_snowflake, requiredIntents: Intents.Guilds, d: payload });
    recordAudit(ds, bus, {
      guildSnowflake: stage.guild_snowflake,
      actionType: AuditLogEvent.StageInstanceDelete,
      actorSnowflake: auth.user?.snowflake ?? null,
      targetSnowflake: stage.snowflake,
      changes: [{ key: "topic", old_value: stage.topic }],
      reason: auditReason(c),
    });
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
    if (!ds.guilds.findOneBy("snowflake", guildId)) return unknownGuild(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    const triggerType = typeof body.trigger_type === "number" ? body.trigger_type : NaN;
    const errors = validateAutoModRuleBody(body, triggerType, true);
    if (errors) return invalidFormBody(c, errors);

    // Enforce the per-trigger-type maximum number of rules per guild.
    const cap = MAX_RULES_PER_GUILD[triggerType];
    if (cap !== undefined) {
      const existing = ds.autoModRules
        .findBy("guild_snowflake", guildId)
        .filter((r) => r.trigger_type === triggerType).length;
      if (existing >= cap) {
        return invalidFormBody(c, {
          trigger_type: `You have reached the maximum number of rules for this trigger type (${cap}).`,
        });
      }
    }

    const rule = ds.autoModRules.insert({
      snowflake: snowflake(),
      guild_snowflake: guildId,
      creator_snowflake: auth.user?.snowflake ?? null,
      name: typeof body.name === "string" ? body.name : "rule",
      event_type: body.event_type as number,
      trigger_type: triggerType,
      trigger_metadata: (body.trigger_metadata as Record<string, unknown>) ?? {},
      actions: (body.actions as unknown[]) ?? [],
      enabled: body.enabled === true, // False by default per docs.
      exempt_roles: (body.exempt_roles as string[]) ?? [],
      exempt_channels: (body.exempt_channels as string[]) ?? [],
    });
    const payload = toAPIAutoMod(rule);
    bus.publish({ t: "AUTO_MODERATION_RULE_CREATE", guildId, requiredIntents: Intents.AutoModerationConfiguration, d: payload });
    recordAudit(ds, bus, {
      guildSnowflake: guildId,
      actionType: AuditLogEvent.AutoModerationRuleCreate,
      actorSnowflake: auth.user?.snowflake ?? null,
      targetSnowflake: rule.snowflake,
      changes: [{ key: "name", new_value: rule.name }],
      reason: auditReason(c),
    });
    return c.json(payload, 201);
  });

  app.patch("/api/v:version/guilds/:guildId/auto-moderation/rules/:ruleId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const rule = ds.autoModRules.findOneBy("snowflake", c.req.param("ruleId"));
    if (!rule || rule.guild_snowflake !== c.req.param("guildId")) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    // Modify: all params optional; validate against the rule's (unchangeable) trigger type.
    const errors = validateAutoModRuleBody(body, rule.trigger_type, false);
    if (errors) return invalidFormBody(c, errors);

    const patch: Partial<DiscordAutoModRule> = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.event_type === "number") patch.event_type = body.event_type;
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (body.actions !== undefined) patch.actions = body.actions as unknown[];
    if (body.trigger_metadata !== undefined) patch.trigger_metadata = body.trigger_metadata as Record<string, unknown>;
    if (Array.isArray(body.exempt_roles)) patch.exempt_roles = body.exempt_roles as string[];
    if (Array.isArray(body.exempt_channels)) patch.exempt_channels = body.exempt_channels as string[];
    const autoModChanges = (Object.keys(patch) as Array<keyof DiscordAutoModRule>).map((key) => ({
      key,
      old_value: rule[key],
      new_value: patch[key],
    }));
    ds.autoModRules.update(rule.id, patch);
    const payload = toAPIAutoMod(ds.autoModRules.findOneBy("snowflake", rule.snowflake)!);
    bus.publish({ t: "AUTO_MODERATION_RULE_UPDATE", guildId: rule.guild_snowflake, requiredIntents: Intents.AutoModerationConfiguration, d: payload });
    if (autoModChanges.length > 0) {
      recordAudit(ds, bus, {
        guildSnowflake: rule.guild_snowflake,
        actionType: AuditLogEvent.AutoModerationRuleUpdate,
        actorSnowflake: auth.user?.snowflake ?? null,
        targetSnowflake: rule.snowflake,
        changes: autoModChanges,
        reason: auditReason(c),
      });
    }
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
    recordAudit(ds, bus, {
      guildSnowflake: rule.guild_snowflake,
      actionType: AuditLogEvent.AutoModerationRuleDelete,
      actorSnowflake: auth.user?.snowflake ?? null,
      targetSnowflake: rule.snowflake,
      changes: [{ key: "name", old_value: rule.name }],
      reason: auditReason(c),
    });
    return new Response(null, { status: 204 });
  });
}
