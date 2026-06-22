import { type Context, type AppEnv, type ContentfulStatusCode, type Store } from "@emulators/core";
import { getDiscordStore, type DiscordStore } from "./store.js";
import type {
  DiscordUser,
  DiscordRole,
  DiscordGuildMember,
  DiscordChannel,
  DiscordMessage,
  DiscordEmoji,
  DiscordGuild,
  DiscordApplication,
  DiscordApplicationCommand,
  DiscordTokenType,
} from "./entities.js";

// ---------------------------------------------------------------------------
// Snowflakes
// ---------------------------------------------------------------------------

const DISCORD_EPOCH = 1420070400000n;
let increment = 0n;

/** Generate a Discord-plausible snowflake id (as a decimal string). */
export function snowflake(date: number = Date.now()): string {
  const ts = (BigInt(date) - DISCORD_EPOCH) << 22n;
  const inc = increment++ & 0xfffn;
  return (ts | inc).toString();
}

/** Extract the millisecond timestamp encoded in a snowflake. */
export function snowflakeTimestamp(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

// ---------------------------------------------------------------------------
// Gateway URL
// ---------------------------------------------------------------------------

/** Derive the same-host WebSocket URL the bot should connect to from the REST base URL. */
export function gatewayUrlFromBaseUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    const proto = u.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${u.host}/`;
  } catch {
    return "ws://localhost/";
  }
}

// ---------------------------------------------------------------------------
// Errors (Discord envelope: { message, code })
// ---------------------------------------------------------------------------

export function discordError(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  message: string,
  code = 0,
  extra?: Record<string, unknown>,
): Response {
  return c.json({ message, code, ...(extra ?? {}) }, status);
}

export const unauthorized = (c: Context<AppEnv>): Response => discordError(c, 401, "401: Unauthorized", 0);
export const forbidden = (c: Context<AppEnv>): Response => discordError(c, 403, "Missing Access", 50001);
export const notFound = (c: Context<AppEnv>): Response => discordError(c, 404, "404: Not Found", 0);

// ---------------------------------------------------------------------------
// Auth (Bot <token> and Bearer <token>)
// ---------------------------------------------------------------------------

export interface DiscordAuth {
  token: string;
  scheme: "Bot" | "Bearer" | null;
  type: DiscordTokenType;
  user: DiscordUser | null;
  application: DiscordApplication | null;
  scopes: string[];
}

/** Resolve the caller's auth from the Authorization header against seeded/issued tokens. */
export function getAuth(c: Context<AppEnv>, store: Store): DiscordAuth | null {
  const header = c.req.header("authorization") ?? c.req.header("Authorization");
  if (!header) return null;
  const match = /^(Bot|Bearer)\s+(.+)$/i.exec(header.trim());
  let token: string;
  let scheme: "Bot" | "Bearer" | null = null;
  if (match) {
    scheme = (match[1][0].toUpperCase() + match[1].slice(1).toLowerCase()) as "Bot" | "Bearer";
    token = match[2].trim();
  } else {
    token = header.trim();
  }
  const ds = getDiscordStore(store);
  const rec = ds.tokens.findOneBy("token", token);
  if (!rec) return null;
  const user = rec.user_snowflake ? (ds.users.findOneBy("snowflake", rec.user_snowflake) ?? null) : null;
  const application = rec.application_snowflake
    ? (ds.applications.findOneBy("snowflake", rec.application_snowflake) ?? null)
    : null;
  return { token, scheme, type: rec.type, user, application, scopes: rec.scopes };
}

/** Resolve the bot user implied by a Bot token (or the single seeded application's bot). */
export function resolveBotUser(ds: DiscordStore, auth: DiscordAuth | null): DiscordUser | null {
  if (auth?.user) return auth.user;
  const app = ds.applications.all()[0];
  if (app) return ds.users.findOneBy("snowflake", app.bot_user_snowflake) ?? null;
  return null;
}

// ---------------------------------------------------------------------------
// Serializers (store entity -> Discord wire object)
// ---------------------------------------------------------------------------

export function toAPIUser(u: DiscordUser, self = false): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: u.snowflake,
    username: u.username,
    discriminator: u.discriminator,
    global_name: u.global_name,
    avatar: u.avatar,
    bot: u.bot,
    system: u.system,
    banner: u.banner,
    accent_color: u.accent_color,
    public_flags: u.public_flags,
  };
  if (self) {
    base.mfa_enabled = u.mfa_enabled;
    base.locale = u.locale;
    base.verified = u.verified;
    base.email = u.email;
    base.flags = u.flags;
    base.premium_type = u.premium_type;
  }
  return base;
}

export function toAPIRole(r: DiscordRole): Record<string, unknown> {
  return {
    id: r.snowflake,
    name: r.name,
    color: r.color,
    hoist: r.hoist,
    icon: r.icon,
    unicode_emoji: null,
    position: r.position,
    permissions: r.permissions,
    managed: r.managed,
    mentionable: r.mentionable,
    flags: 0,
  };
}

export function toAPIMember(
  m: DiscordGuildMember,
  ds: DiscordStore,
  opts: { withUser?: boolean } = {},
): Record<string, unknown> {
  const member: Record<string, unknown> = {
    nick: m.nick,
    avatar: m.avatar,
    roles: m.role_snowflakes,
    joined_at: m.joined_at,
    premium_since: m.premium_since,
    deaf: m.deaf,
    mute: m.mute,
    pending: m.pending,
    communication_disabled_until: m.communication_disabled_until,
    flags: 0,
  };
  if (opts.withUser !== false) {
    const user = ds.users.findOneBy("snowflake", m.user_snowflake);
    if (user) member.user = toAPIUser(user);
  }
  return member;
}

export function toAPIChannel(c: DiscordChannel): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: c.snowflake,
    type: c.type,
    guild_id: c.guild_snowflake ?? undefined,
    name: c.name,
    position: c.position,
    topic: c.topic,
    nsfw: c.nsfw,
    last_message_id: c.last_message_snowflake,
    parent_id: c.parent_snowflake,
    rate_limit_per_user: c.rate_limit_per_user,
    permission_overwrites: c.permission_overwrites,
  };
  if (c.bitrate != null) base.bitrate = c.bitrate;
  if (c.user_limit != null) base.user_limit = c.user_limit;
  if (c.recipient_snowflakes.length > 0) base.recipients = c.recipient_snowflakes;
  if (c.type === 10 || c.type === 11 || c.type === 12) {
    base.owner_id = c.owner_snowflake ?? null;
    base.thread_metadata = c.thread_metadata ?? null;
    base.message_count = c.message_count ?? 0;
    base.member_count = c.member_count ?? 0;
  }
  return base;
}

export function toAPIEmoji(e: DiscordEmoji, ds: DiscordStore): Record<string, unknown> {
  const creator = e.creator_snowflake ? ds.users.findOneBy("snowflake", e.creator_snowflake) : null;
  return {
    id: e.snowflake,
    name: e.name,
    roles: e.role_snowflakes,
    user: creator ? toAPIUser(creator) : undefined,
    require_colons: e.require_colons,
    managed: e.managed,
    animated: e.animated,
    available: e.available,
  };
}

/** Aggregate per-user reaction rows into Discord's reaction summary array. */
export function aggregateReactions(
  ds: DiscordStore,
  messageSnowflake: string,
  meSnowflake?: string,
): Array<Record<string, unknown>> {
  const rows = ds.reactions.findBy("message_snowflake", messageSnowflake);
  const map = new Map<string, { count: number; me: boolean; emoji: Record<string, unknown> }>();
  for (const r of rows) {
    const key = r.emoji_snowflake ? `${r.emoji_name}:${r.emoji_snowflake}` : r.emoji_name;
    let agg = map.get(key);
    if (!agg) {
      agg = {
        count: 0,
        me: false,
        emoji: { id: r.emoji_snowflake, name: r.emoji_name, animated: r.emoji_animated || undefined },
      };
      map.set(key, agg);
    }
    agg.count++;
    if (meSnowflake && r.user_snowflake === meSnowflake) agg.me = true;
  }
  return [...map.values()].map((a) => ({ count: a.count, me: a.me, emoji: a.emoji }));
}

export function toAPIMessage(m: DiscordMessage, ds: DiscordStore, meSnowflake?: string): Record<string, unknown> {
  const author = ds.users.findOneBy("snowflake", m.author_snowflake);
  const mentions = m.mention_snowflakes
    .map((s) => ds.users.findOneBy("snowflake", s))
    .filter((u): u is DiscordUser => !!u)
    .map((u) => toAPIUser(u));
  return {
    id: m.snowflake,
    channel_id: m.channel_snowflake,
    guild_id: m.guild_snowflake ?? undefined,
    author: author ? toAPIUser(author) : undefined,
    content: m.content,
    timestamp: m.timestamp,
    edited_timestamp: m.edited_timestamp,
    tts: m.tts,
    mention_everyone: m.mention_everyone,
    mentions,
    mention_roles: m.mention_role_snowflakes,
    attachments: m.attachments,
    embeds: m.embeds,
    components: m.components,
    reactions: aggregateReactions(ds, m.snowflake, meSnowflake),
    pinned: m.pinned,
    webhook_id: m.webhook_snowflake ?? undefined,
    type: m.type,
    flags: m.flags,
    nonce: m.nonce ?? undefined,
    message_reference: m.message_reference ?? undefined,
    referenced_message: m.referenced_message_snowflake
      ? (() => {
          const ref = ds.messages.findOneBy("snowflake", m.referenced_message_snowflake!);
          return ref ? toAPIMessage(ref, ds) : null;
        })()
      : undefined,
  };
}

/** A message payload with content-bearing fields stripped (for sessions lacking MESSAGE_CONTENT). */
export function redactMessageContent(message: Record<string, unknown>): Record<string, unknown> {
  return { ...message, content: "", embeds: [], components: [], attachments: [] };
}

export interface GuildSerializeOptions {
  /** Include channels, members, and member_count (used by GUILD_CREATE). */
  full?: boolean;
  withCounts?: boolean;
}

export function toAPIGuild(g: DiscordGuild, ds: DiscordStore, opts: GuildSerializeOptions = {}): Record<string, unknown> {
  const roles = ds.roles.findBy("guild_snowflake", g.snowflake).map(toAPIRole);
  const emojis = ds.emojis.findBy("guild_snowflake", g.snowflake).map((e) => toAPIEmoji(e, ds));
  const base: Record<string, unknown> = {
    id: g.snowflake,
    name: g.name,
    icon: g.icon,
    splash: g.splash,
    owner_id: g.owner_snowflake,
    afk_channel_id: g.afk_channel_snowflake,
    afk_timeout: g.afk_timeout,
    verification_level: g.verification_level,
    default_message_notifications: g.default_message_notifications,
    explicit_content_filter: g.explicit_content_filter,
    roles,
    emojis,
    features: g.features,
    mfa_level: g.mfa_level,
    system_channel_id: g.system_channel_snowflake,
    nsfw_level: g.nsfw_level,
    premium_tier: g.premium_tier,
    premium_subscription_count: g.premium_subscription_count,
    preferred_locale: g.preferred_locale,
    description: g.description,
  };
  if (opts.withCounts || opts.full) {
    base.approximate_member_count = g.member_snowflakes.length;
    base.approximate_presence_count = g.member_snowflakes.length;
  }
  if (opts.full) {
    const members = ds.members.findBy("guild_snowflake", g.snowflake).map((m) => toAPIMember(m, ds));
    const channels = ds.channels.findBy("guild_snowflake", g.snowflake).map(toAPIChannel);
    base.channels = channels;
    base.members = members;
    base.member_count = members.length;
    base.large = g.large;
    base.unavailable = false;
    base.joined_at = g.created_at;
    // discord.js hydrates these caches from GUILD_CREATE; always present (possibly empty).
    base.threads = [];
    base.voice_states = [];
    base.presences = [];
    base.stage_instances = [];
    base.guild_scheduled_events = [];
    base.soundboard_sounds = [];
  }
  return base;
}

export function toAPIApplicationCommand(cmd: DiscordApplicationCommand): Record<string, unknown> {
  return {
    id: cmd.snowflake,
    type: cmd.type,
    application_id: cmd.application_snowflake,
    guild_id: cmd.guild_snowflake ?? undefined,
    name: cmd.name,
    description: cmd.description,
    options: cmd.options,
    default_member_permissions: cmd.default_member_permissions,
    dm_permission: cmd.dm_permission,
    nsfw: cmd.nsfw,
    version: cmd.version,
  };
}
