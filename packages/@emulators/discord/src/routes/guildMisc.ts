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

  // Audit log: returns the referenced entities from the store with an (as-yet) empty entry
  // list. Entries are not tracked retroactively; the endpoint is valid and stateful in its
  // referenced data.
  app.get("/api/v:version/guilds/:guildId/audit-logs", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const guildId = c.req.param("guildId");
    if (!ds.guilds.findOneBy("snowflake", guildId)) return notFound(c);
    const memberIds = new Set(ds.members.findBy("guild_snowflake", guildId).map((m) => m.user_snowflake));
    const users = ds.users
      .all()
      .filter((u) => memberIds.has(u.snowflake))
      .map((u) => toAPIUser(u));
    return c.json({
      audit_log_entries: [],
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
