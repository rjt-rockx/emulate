import type { DiscordRouteContext } from "../context.js";
import type { DiscordStore } from "../store.js";
import {
  getAuth,
  unauthorized,
  toAPIUser,
  recordAudit,
  AuditLogEvent,
  auditReason,
  requireBot,
  requireGuild,
} from "../helpers.js";
import { Intents } from "../gateway/intents.js";
import type { DiscordGuildMember } from "../entities.js";

const VOICE_REGIONS = [
  { id: "us-east", name: "US East", optimal: true, deprecated: false, custom: false },
  { id: "us-west", name: "US West", optimal: false, deprecated: false, custom: false },
  { id: "us-central", name: "US Central", optimal: false, deprecated: false, custom: false },
  { id: "europe", name: "Europe", optimal: false, deprecated: false, custom: false },
  { id: "singapore", name: "Singapore", optimal: false, deprecated: false, custom: false },
];

/**
 * Members eligible for a prune: those with no roles beyond @everyone (whose id equals the guild
 * id) AND who have been inactive — modeled here as having joined more than `days` days ago. When
 * `includeRoles` is non-empty, members whose roles are a subset of the provided set are also
 * eligible — matching Discord's documented behavior. The guild owner is never pruned.
 */
function prunableMembers(
  ds: DiscordStore,
  guildId: string,
  ownerSnowflake: string,
  includeRoles: string[],
  days: number,
): DiscordGuildMember[] {
  const includeSet = new Set(includeRoles);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return ds.members.findBy("guild_snowflake", guildId).filter((m) => {
    if (m.user_snowflake === ownerSnowflake) return false;
    // Inactive: joined before the cutoff (recently-joined members are not pruned).
    const joined = m.joined_at ? Date.parse(m.joined_at) : 0;
    if (Number.isFinite(joined) && joined > cutoff) return false;
    const realRoles = m.role_snowflakes.filter((r) => r !== guildId);
    if (realRoles.length === 0) return true;
    if (includeSet.size === 0) return false;
    // Every role the member has must be in the provided include set (a subset).
    return realRoles.every((r) => includeSet.has(r));
  });
}

function parseIncludeRoles(value: string | string[] | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export function guildMiscRoutes(ctx: DiscordRouteContext): void {
  const { app, store, bus } = ctx;

  app.get("/api/v:version/voice/regions", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    return c.json(VOICE_REGIONS);
  });

  app.get("/api/v:version/guilds/:guildId/regions", (c) => {
    const _g = requireBot(c, store); if (_g instanceof Response) return _g;
    return c.json(VOICE_REGIONS);
  });

  // Get Guild Prune Count: report (don't remove) the number of role-less inactive members.
  app.get("/api/v:version/guilds/:guildId/prune", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { ds } = g;
    const guildId = c.req.param("guildId");
    const guild = requireGuild(c, ds, guildId); if (guild instanceof Response) return guild;
    const includeRoles = parseIncludeRoles(c.req.query("include_roles"));
    const daysRaw = Number(c.req.query("days"));
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 7;
    const pruned = prunableMembers(ds, guildId, guild.owner_snowflake, includeRoles, days).length;
    return c.json({ pruned });
  });

  // Begin Guild Prune: compute + remove role-less inactive members, firing GUILD_MEMBER_REMOVE per
  // removed member and recording a single MEMBER_PRUNE audit entry with delete_member_days /
  // members_removed in its options. `compute_prune_count: false` forces `pruned` to null.
  app.post("/api/v:version/guilds/:guildId/prune", async (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { auth, ds } = g;
    const guildId = c.req.param("guildId");
    const guild = requireGuild(c, ds, guildId); if (guild instanceof Response) return guild;
    const body = (await c.req.json().catch(() => ({}))) as {
      days?: number;
      compute_prune_count?: boolean;
      include_roles?: string[];
    };
    const days = typeof body.days === "number" ? body.days : 7;
    const includeRoles = parseIncludeRoles(body.include_roles);
    const targets = prunableMembers(ds, guildId, guild.owner_snowflake, includeRoles, days);

    let remaining = guild.member_snowflakes;
    for (const member of targets) {
      const user = ds.users.findOneBy("snowflake", member.user_snowflake);
      ds.members.delete(member.id);
      remaining = remaining.filter((s) => s !== member.user_snowflake);
      bus.publish({
        t: "GUILD_MEMBER_REMOVE",
        guildId,
        requiredIntents: Intents.GuildMembers,
        d: { guild_id: guildId, user: user ? toAPIUser(user) : { id: member.user_snowflake } },
      });
    }
    ds.guilds.update(guild.id, { member_snowflakes: remaining });

    const removed = targets.length;
    if (removed > 0) {
      recordAudit(ds, bus, {
        guildSnowflake: guildId,
        actionType: AuditLogEvent.MemberPrune,
        actorSnowflake: auth.user?.snowflake ?? null,
        targetSnowflake: null,
        reason: auditReason(c),
        options: { delete_member_days: String(days), members_removed: String(removed) },
      });
    }

    return c.json({ pruned: body.compute_prune_count === false ? null : removed });
  });

  // Get Guild Vanity URL: a partial invite object ({ code, uses }). `code` is null when no vanity
  // url is set; `uses` reflects the stored vanity usage count.
  app.get("/api/v:version/guilds/:guildId/vanity-url", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { ds } = g;
    const guildId = c.req.param("guildId");
    const guild = requireGuild(c, ds, guildId); if (guild instanceof Response) return guild;
    // The emulator does not track vanity-invite redemptions, so uses is always 0.
    return c.json({ code: guild.vanity_url_code ?? null, uses: 0 });
  });

  // Get Guild Audit Log: entries recorded retroactively by mutation routes (bans, kicks, prune,
  // role/channel create-update-delete, member role updates), newest first by default, with the
  // referenced actor/target users hydrated and the documented entity arrays populated. Supports
  // the action_type / user_id / before / after / limit query filters.
  app.get("/api/v:version/guilds/:guildId/audit-logs", (c) => {
    const g = requireBot(c, store); if (g instanceof Response) return g; const { ds } = g;
    const guildId = c.req.param("guildId");
    { const _g = requireGuild(c, ds, guildId); if (_g instanceof Response) return _g; }

    const actionTypeFilter = c.req.query("action_type");
    const userIdFilter = c.req.query("user_id");
    const beforeFilter = c.req.query("before");
    const afterFilter = c.req.query("after");
    const limitRaw = Number(c.req.query("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 50;

    let entries = ds.auditLog.findBy("guild_snowflake", guildId).slice();
    // `after` yields ascending (oldest first); otherwise descending (newest first).
    const ascending = afterFilter !== undefined && beforeFilter === undefined;
    entries.sort((a, b) =>
      BigInt(a.snowflake) < BigInt(b.snowflake) ? (ascending ? -1 : 1) : ascending ? 1 : -1,
    );
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
      ...(e.options ? { options: e.options } : {}),
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

    // Hydrated reference arrays for the entities the audit log can point at.
    const integrations = ds.integrations.findBy("guild_snowflake", guildId).map((integ) => ({
      id: integ.snowflake,
      name: integ.name,
      type: integ.type,
      account: integ.account,
      ...(integ.application_snowflake ? { application_id: integ.application_snowflake } : {}),
    }));
    const threads = ds.channels
      .findBy("guild_snowflake", guildId)
      .filter((ch) => ch.type === 10 || ch.type === 11 || ch.type === 12)
      .map((ch) => ({
        id: ch.snowflake,
        type: ch.type,
        name: ch.name,
        parent_id: ch.parent_snowflake,
        guild_id: guildId,
        thread_metadata: ch.thread_metadata ?? null,
      }));
    const applicationCommands = ds.commands
      .findBy("guild_snowflake", guildId)
      .map((cmd) => ({
        id: cmd.snowflake,
        application_id: cmd.application_snowflake,
        name: cmd.name,
        description: cmd.description,
        type: cmd.type,
      }));
    const autoModerationRules = ds.autoModRules.findBy("guild_snowflake", guildId).map((r) => ({
      id: r.snowflake,
      guild_id: r.guild_snowflake,
      name: r.name,
      event_type: r.event_type,
      trigger_type: r.trigger_type,
      enabled: r.enabled,
    }));

    return c.json({
      application_commands: applicationCommands,
      audit_log_entries: auditLogEntries,
      auto_moderation_rules: autoModerationRules,
      guild_scheduled_events: ds.scheduledEvents
        .findBy("guild_snowflake", guildId)
        .map((e) => ({ id: e.snowflake, name: e.name })),
      integrations,
      threads,
      users,
      webhooks: ds.webhooks
        .all()
        .filter((w) => w.guild_snowflake === guildId)
        .map((w) => ({ id: w.snowflake, channel_id: w.channel_snowflake, name: w.name, type: w.type })),
    });
  });
}
