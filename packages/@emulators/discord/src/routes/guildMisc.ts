import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, toAPIUser } from "../helpers.js";

const VOICE_REGIONS = [
  { id: "us-east", name: "US East", optimal: true, deprecated: false, custom: false },
  { id: "us-west", name: "US West", optimal: false, deprecated: false, custom: false },
  { id: "us-central", name: "US Central", optimal: false, deprecated: false, custom: false },
  { id: "europe", name: "Europe", optimal: false, deprecated: false, custom: false },
  { id: "singapore", name: "Singapore", optimal: false, deprecated: false, custom: false },
];

export function guildMiscRoutes(ctx: DiscordRouteContext): void {
  const { app, store } = ctx;

  app.get("/api/v:version/voice/regions", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    return c.json(VOICE_REGIONS);
  });

  app.get("/api/v:version/guilds/:guildId/regions", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    return c.json(VOICE_REGIONS);
  });

  // Prune (no inactivity tracking: report and remove nothing by default).
  app.get("/api/v:version/guilds/:guildId/prune", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    return c.json({ pruned: 0 });
  });

  app.post("/api/v:version/guilds/:guildId/prune", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const body = (await c.req.json().catch(() => ({}))) as { compute_prune_count?: boolean };
    return c.json({ pruned: body.compute_prune_count === false ? null : 0 });
  });

  app.get("/api/v:version/guilds/:guildId/vanity-url", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    return c.json({ code: null, uses: 0 });
  });

  // Audit log: returns entries recorded retroactively by mutation routes (bans, kicks,
  // role/channel create-update-delete, member role updates), newest first, with the referenced
  // actor/target users hydrated. Supports the action_type / user_id / before / after / limit
  // query filters Discord clients send.
  app.get("/api/v:version/guilds/:guildId/audit-logs", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    if (!ds.guilds.findOneBy("snowflake", guildId)) return notFound(c);

    const actionTypeFilter = c.req.query("action_type");
    const userIdFilter = c.req.query("user_id");
    const beforeFilter = c.req.query("before");
    const afterFilter = c.req.query("after");
    const limitRaw = Number(c.req.query("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 50;

    let entries = ds.auditLog
      .findBy("guild_snowflake", guildId)
      .slice()
      .sort((a, b) => (BigInt(a.snowflake) < BigInt(b.snowflake) ? 1 : -1));
    if (actionTypeFilter !== undefined) entries = entries.filter((e) => e.action_type === Number(actionTypeFilter));
    if (userIdFilter !== undefined) entries = entries.filter((e) => e.user_snowflake === userIdFilter);
    if (beforeFilter !== undefined) entries = entries.filter((e) => BigInt(e.snowflake) < BigInt(beforeFilter));
    if (afterFilter !== undefined) entries = entries.filter((e) => BigInt(e.snowflake) > BigInt(afterFilter));
    entries = entries.slice(0, limit);

    const auditLogEntries = entries.map((e) => ({
      id: e.snowflake,
      target_id: e.target_snowflake,
      user_id: e.user_snowflake,
      action_type: e.action_type,
      changes: e.changes,
      reason: e.reason ?? undefined,
    }));

    // Hydrate every user referenced as an actor or target, plus guild members.
    const referencedIds = new Set<string>(ds.members.findBy("guild_snowflake", guildId).map((m) => m.user_snowflake));
    for (const e of entries) {
      if (e.user_snowflake) referencedIds.add(e.user_snowflake);
      if (e.target_snowflake) referencedIds.add(e.target_snowflake);
    }
    const users = ds.users
      .all()
      .filter((u) => referencedIds.has(u.snowflake))
      .map((u) => toAPIUser(u));

    return c.json({
      audit_log_entries: auditLogEntries,
      users,
      integrations: [],
      webhooks: ds.webhooks
        .all()
        .filter((w) => w.guild_snowflake === guildId)
        .map((w) => ({ id: w.snowflake, channel_id: w.channel_snowflake, name: w.name, type: w.type })),
      threads: [],
      application_commands: [],
      auto_moderation_rules: [],
      guild_scheduled_events: ds.scheduledEvents.findBy("guild_snowflake", guildId).map((e) => ({ id: e.snowflake, name: e.name })),
    });
  });
}
