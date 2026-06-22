import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound } from "../helpers.js";

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
        .filter((ch) => ch.type === 2)
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
