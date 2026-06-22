import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore, type DiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, invalidFormBody, toAPIUser } from "../helpers.js";
import type { DiscordGuildJoinRequest } from "../entities.js";

/** Serialize a guild join request to GuildJoinRequestResponse. */
function toAPIGuildJoinRequest(r: DiscordGuildJoinRequest, ds: DiscordStore): Record<string, unknown> {
  const user = ds.users.findOneBy("snowflake", r.user_snowflake);
  const actionedBy = r.actioned_by_user_snowflake ? ds.users.findOneBy("snowflake", r.actioned_by_user_snowflake) : null;
  return {
    id: r.snowflake,
    created_at: r.created_at,
    reviewed_at: r.reviewed_at,
    application_status: r.application_status,
    rejection_reason: r.rejection_reason,
    guild_id: r.guild_snowflake,
    user_id: r.user_snowflake,
    user: user ? toAPIUser(user) : null,
    form_responses: null,
    actioned_by_user: actionedBy ? toAPIUser(actionedBy) : null,
  };
}

const JOIN_REQUEST_STATUSES = new Set(["STARTED", "SUBMITTED", "REJECTED", "APPROVED"]);

export function guildSettingsRoutes(ctx: DiscordRouteContext): void {
  const { app, store } = ctx;

  const requireGuild = (c: Parameters<Parameters<typeof app.get>[1]>[0]) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return null;
    const ds = getDiscordStore(store);
    return ds.guilds.findOneBy("snowflake", c.req.param("guildId")) ?? null;
  };

  // Widget settings.
  app.get("/api/v:version/guilds/:guildId/widget", (c) => {
    const guild = requireGuild(c);
    if (!getAuth(c, store)) return unauthorized(c);
    if (!guild) return notFound(c);
    return c.json({ enabled: guild.widget_enabled ?? false, channel_id: guild.widget_channel_snowflake ?? null });
  });

  app.patch("/api/v:version/guilds/:guildId/widget", async (c) => {
    const guild = requireGuild(c);
    if (!getAuth(c, store)) return unauthorized(c);
    if (!guild) return notFound(c);
    const ds = getDiscordStore(store);
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean; channel_id?: string | null };
    ds.guilds.update(guild.id, {
      widget_enabled: body.enabled ?? guild.widget_enabled ?? false,
      widget_channel_snowflake: body.channel_id !== undefined ? body.channel_id : (guild.widget_channel_snowflake ?? null),
    });
    const updated = ds.guilds.findOneBy("snowflake", guild.snowflake)!;
    return c.json({ enabled: updated.widget_enabled ?? false, channel_id: updated.widget_channel_snowflake ?? null });
  });

  // Public widget json.
  app.get("/api/v:version/guilds/:guildId/widget.json", (c) => {
    const ds = getDiscordStore(store);
    const guild = ds.guilds.findOneBy("snowflake", c.req.param("guildId"));
    if (!guild) return notFound(c);
    return c.json({
      id: guild.snowflake,
      name: guild.name,
      instant_invite: null,
      channels: ds.channels
        .findBy("guild_snowflake", guild.snowflake)
        .filter((ch) => ch.type === 2 || ch.type === 13)
        .map((ch) => ({ id: ch.snowflake, name: ch.name, position: ch.position })),
      members: [],
      presence_count: guild.member_snowflakes.length,
    });
  });

  // Welcome screen.
  app.get("/api/v:version/guilds/:guildId/welcome-screen", (c) => {
    const guild = requireGuild(c);
    if (!getAuth(c, store)) return unauthorized(c);
    if (!guild) return notFound(c);
    return c.json(guild.welcome_screen ?? { description: null, welcome_channels: [] });
  });

  app.patch("/api/v:version/guilds/:guildId/welcome-screen", async (c) => {
    const guild = requireGuild(c);
    if (!getAuth(c, store)) return unauthorized(c);
    if (!guild) return notFound(c);
    const ds = getDiscordStore(store);
    const body = (await c.req.json().catch(() => ({}))) as { description?: string | null; welcome_channels?: unknown[] };
    const welcome = {
      description: body.description !== undefined ? body.description : (guild.welcome_screen?.description ?? null),
      welcome_channels: body.welcome_channels ?? guild.welcome_screen?.welcome_channels ?? [],
    };
    ds.guilds.update(guild.id, { welcome_screen: welcome });
    return c.json(welcome);
  });

  // Onboarding.
  app.get("/api/v:version/guilds/:guildId/onboarding", (c) => {
    const guild = requireGuild(c);
    if (!getAuth(c, store)) return unauthorized(c);
    if (!guild) return notFound(c);
    const onboarding = guild.onboarding ?? { prompts: [], default_channel_ids: [], enabled: false, mode: 0 };
    return c.json({ guild_id: guild.snowflake, ...onboarding });
  });

  // Guild home / new-member-welcome settings (GuildHomeSettingsResponse).
  app.get("/api/v:version/guilds/:guildId/new-member-welcome", (c) => {
    const guild = requireGuild(c);
    if (!getAuth(c, store)) return unauthorized(c);
    if (!guild) return notFound(c);
    return c.json({ guild_id: guild.snowflake, enabled: false, new_member_actions: [], resource_channels: [] });
  });

  // Guild join requests (GuildJoinRequestsListResponse).
  app.get("/api/v:version/guilds/:guildId/requests", (c) => {
    const guild = requireGuild(c);
    if (!getAuth(c, store)) return unauthorized(c);
    if (!guild) return notFound(c);
    const ds = getDiscordStore(store);
    const requests = ds.guildJoinRequests.findBy("guild_snowflake", guild.snowflake);
    return c.json({ total: requests.length, guild_join_requests: requests.map((r) => toAPIGuildJoinRequest(r, ds)) });
  });

  // Approve or reject a guild join request (action_guild_join_request).
  app.patch("/api/v:version/guilds/:guildId/requests/:requestId", async (c) => {
    const guild = requireGuild(c);
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    if (!guild) return notFound(c);
    const ds = getDiscordStore(store);
    const request = ds.guildJoinRequests.findOneBy("snowflake", c.req.param("requestId"));
    if (!request || request.guild_snowflake !== guild.snowflake) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as { action?: string; rejection_reason?: string | null };
    if (typeof body.action !== "string" || !JOIN_REQUEST_STATUSES.has(body.action)) {
      return invalidFormBody(c, { action: "Value must be one of (STARTED, SUBMITTED, REJECTED, APPROVED)." });
    }
    if (body.action === "REJECTED" && typeof body.rejection_reason === "string" && body.rejection_reason.length > 160) {
      return invalidFormBody(c, { rejection_reason: "Must be 160 or fewer in length." });
    }
    ds.guildJoinRequests.update(request.id, {
      application_status: body.action,
      reviewed_at: new Date().toISOString(),
      rejection_reason: body.action === "REJECTED" ? (body.rejection_reason ?? null) : null,
      actioned_by_user_snowflake: auth.user?.snowflake ?? null,
    });
    return c.json(toAPIGuildJoinRequest(ds.guildJoinRequests.findOneBy("snowflake", request.snowflake)!, ds));
  });

  app.put("/api/v:version/guilds/:guildId/onboarding", async (c) => {
    const guild = requireGuild(c);
    if (!getAuth(c, store)) return unauthorized(c);
    if (!guild) return notFound(c);
    const ds = getDiscordStore(store);
    const body = (await c.req.json().catch(() => ({}))) as Partial<NonNullable<typeof guild.onboarding>>;
    const onboarding = {
      prompts: body.prompts ?? guild.onboarding?.prompts ?? [],
      default_channel_ids: body.default_channel_ids ?? guild.onboarding?.default_channel_ids ?? [],
      enabled: body.enabled ?? guild.onboarding?.enabled ?? false,
      mode: body.mode ?? guild.onboarding?.mode ?? 0,
    };
    ds.guilds.update(guild.id, { onboarding });
    return c.json({ guild_id: guild.snowflake, ...onboarding });
  });
}
