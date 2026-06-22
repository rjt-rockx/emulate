import { type Context, type AppEnv, type ContentfulStatusCode, type Store } from "@emulators/core";
import { getDiscordStore, type DiscordStore } from "./store.js";
import { computePermissions, computeGuildPermissions, hasPermission } from "./permissions.js";
import { Intents } from "./gateway/intents.js";
import type { DiscordEventBus } from "./gateway/dispatcher.js";
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
  DiscordVoiceState,
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

// Resource-specific 404s (Discord JSON error codes) so clients can branch on the cause.
export const unknownGuild = (c: Context<AppEnv>): Response => discordError(c, 404, "Unknown Guild", 10004);
export const unknownChannel = (c: Context<AppEnv>): Response => discordError(c, 404, "Unknown Channel", 10003);
export const unknownMember = (c: Context<AppEnv>): Response => discordError(c, 404, "Unknown Member", 10007);
export const unknownRole = (c: Context<AppEnv>): Response => discordError(c, 404, "Unknown Role", 10011);
export const unknownMessage = (c: Context<AppEnv>): Response => discordError(c, 404, "Unknown Message", 10008);
export const unknownUser = (c: Context<AppEnv>): Response => discordError(c, 404, "Unknown User", 10013);
export const unknownBan = (c: Context<AppEnv>): Response => discordError(c, 404, "Unknown Ban", 10026);
export const unknownInvite = (c: Context<AppEnv>): Response => discordError(c, 404, "Unknown Invite", 10006);
export const unknownEmoji = (c: Context<AppEnv>): Response => discordError(c, 404, "Unknown Emoji", 10014);
export const unknownWebhook = (c: Context<AppEnv>): Response => discordError(c, 404, "Unknown Webhook", 10015);

// ---------------------------------------------------------------------------
// Permission enforcement (opt-in)
// ---------------------------------------------------------------------------

/** Whether permission checks are enforced (off by default; enable via seed `enforce_permissions`). */
export function permissionsEnforced(store: Store): boolean {
  return store.getData<boolean>("discord.enforce_permissions") === true;
}

/**
 * When enforcement is enabled, verify the acting bot holds `flag` (channel-scoped if a
 * channelId is given, otherwise guild-scoped) and return a 403 "Missing Permissions" (50013)
 * if not. Returns null (proceed) when enforcement is off or the permission is held — so it is
 * a no-op by default and every existing caller stays lenient.
 */
export function requirePermission(
  c: Context<AppEnv>,
  store: Store,
  userSnowflake: string | undefined,
  flag: bigint,
  scope: { channelId?: string; guildId?: string },
): Response | null {
  if (!permissionsEnforced(store)) return null;
  if (!userSnowflake) return discordError(c, 403, "Missing Permissions", 50013);
  const ds = getDiscordStore(store);
  const perms = scope.channelId
    ? computePermissions(ds, userSnowflake, scope.channelId)
    : computeGuildPermissions(ds, userSnowflake, scope.guildId ?? "");
  if (hasPermission(perms, flag)) return null;
  return discordError(c, 403, "Missing Permissions", 50013);
}

// ---------------------------------------------------------------------------
// Multipart-aware body parsing (file uploads)
// ---------------------------------------------------------------------------

export interface ParsedMessageBody {
  body: Record<string, unknown>;
  attachments: Array<Record<string, unknown>>;
}

/**
 * Read a message-create body that may be plain JSON or `multipart/form-data`. For multipart,
 * the JSON payload is taken from the `payload_json` part and each `files[n]`/`file` part is
 * turned into a synthesized attachment object (the emulator does not persist the bytes, but
 * surfaces a faithful attachment object so clients that send files get a real attachment back).
 */
export async function parseMessageBody(c: Context<AppEnv>, baseUrl: string, channelId: string): Promise<ParsedMessageBody> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return { body, attachments: [] };
  }
  const form = await c.req.raw.formData();
  let body: Record<string, unknown> = {};
  const payloadJson = form.get("payload_json");
  if (typeof payloadJson === "string") {
    try {
      body = JSON.parse(payloadJson) as Record<string, unknown>;
    } catch {
      body = {};
    }
  }
  // The client may pass attachment metadata (id -> filename/description) in payload_json.
  const meta = new Map<string, Record<string, unknown>>();
  for (const a of (body.attachments as Array<Record<string, unknown>> | undefined) ?? []) {
    if (a && a.id != null) meta.set(String(a.id), a);
  }
  const attachments: Array<Record<string, unknown>> = [];
  let idx = 0;
  for (const [key, value] of form.entries()) {
    if (key !== "file" && !key.startsWith("files[")) continue;
    const file = value as { name?: string; size?: number; type?: string };
    const id = key.startsWith("files[") ? key.slice(6, -1) : String(idx);
    const m = meta.get(id) ?? {};
    const filename = (m.filename as string | undefined) ?? file.name ?? `file_${idx}`;
    attachments.push({
      id,
      filename,
      size: file.size ?? 0,
      url: `${baseUrl}/attachments/${channelId}/${snowflake()}/${encodeURIComponent(filename)}`,
      proxy_url: `${baseUrl}/attachments/${channelId}/${snowflake()}/${encodeURIComponent(filename)}`,
      content_type: file.type || "application/octet-stream",
      ...(m.description !== undefined ? { description: m.description } : {}),
    });
    idx++;
  }
  return { body, attachments };
}

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
// Message flags
// ---------------------------------------------------------------------------

export const MessageFlags = {
  /** Only the user that triggered the interaction can see the message. */
  Ephemeral: 1 << 6, // 64
  /** Do not include any embeds when serializing this message. */
  SuppressEmbeds: 1 << 2,
  /** This message will not trigger push and desktop notifications. */
  SuppressNotifications: 1 << 12,
} as const;

/** True when the message flags carry the EPHEMERAL bit. */
export function isEphemeral(flags: number | undefined): boolean {
  return ((flags ?? 0) & MessageFlags.Ephemeral) !== 0;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export const AuditLogEvent = {
  GuildUpdate: 1,
  ChannelCreate: 10,
  ChannelUpdate: 11,
  ChannelDelete: 12,
  ChannelOverwriteCreate: 13,
  ChannelOverwriteUpdate: 14,
  ChannelOverwriteDelete: 15,
  MemberKick: 20,
  MemberPrune: 21,
  MemberBanAdd: 22,
  MemberBanRemove: 23,
  MemberUpdate: 24,
  MemberRoleUpdate: 25,
  MemberMove: 26,
  MemberDisconnect: 27,
  BotAdd: 28,
  RoleCreate: 30,
  RoleUpdate: 31,
  RoleDelete: 32,
  InviteCreate: 40,
  InviteUpdate: 41,
  InviteDelete: 42,
  WebhookCreate: 50,
  WebhookUpdate: 51,
  WebhookDelete: 52,
  EmojiCreate: 60,
  EmojiUpdate: 61,
  EmojiDelete: 62,
  MessageDelete: 72,
  MessageBulkDelete: 73,
  MessagePin: 74,
  MessageUnpin: 75,
  IntegrationCreate: 80,
  IntegrationUpdate: 81,
  IntegrationDelete: 82,
  StageInstanceCreate: 83,
  StageInstanceUpdate: 84,
  StageInstanceDelete: 85,
  StickerCreate: 90,
  StickerUpdate: 91,
  StickerDelete: 92,
  GuildScheduledEventCreate: 100,
  GuildScheduledEventUpdate: 101,
  GuildScheduledEventDelete: 102,
  ThreadCreate: 110,
  ThreadUpdate: 111,
  ThreadDelete: 112,
  ApplicationCommandPermissionUpdate: 121,
  SoundboardSoundCreate: 130,
  SoundboardSoundUpdate: 131,
  SoundboardSoundDelete: 132,
  AutoModerationRuleCreate: 140,
  AutoModerationRuleUpdate: 141,
  AutoModerationRuleDelete: 142,
} as const;

/**
 * Read the moderation reason from the `X-Audit-Log-Reason` header (Discord's documented way
 * to attach a reason to ban/kick/role/channel mutations — it is NOT a body field). The header
 * is percent-encoded; decode it leniently.
 */
export function auditReason(c: Context<AppEnv>): string | null {
  const raw = c.req.header("x-audit-log-reason") ?? c.req.header("X-Audit-Log-Reason");
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function recordAudit(
  ds: DiscordStore,
  bus: DiscordEventBus,
  input: {
    guildSnowflake: string | null;
    actionType: number;
    actorSnowflake?: string | null;
    targetSnowflake?: string | null;
    changes?: unknown[];
    reason?: string | null;
  },
): void {
  if (!input.guildSnowflake) return;
  const entry = ds.auditLog.insert({
    snowflake: snowflake(),
    guild_snowflake: input.guildSnowflake,
    user_snowflake: input.actorSnowflake ?? null,
    target_snowflake: input.targetSnowflake ?? null,
    action_type: input.actionType,
    changes: input.changes ?? [],
    reason: input.reason ?? null,
  });
  bus.publish({
    t: "GUILD_AUDIT_LOG_ENTRY_CREATE",
    guildId: input.guildSnowflake,
    requiredIntents: Intents.GuildModeration,
    d: {
      id: entry.snowflake,
      target_id: entry.target_snowflake,
      user_id: entry.user_snowflake,
      action_type: entry.action_type,
      changes: entry.changes,
      reason: entry.reason ?? undefined,
      guild_id: input.guildSnowflake,
    },
  });
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

export function toAPIVoiceState(v: DiscordVoiceState, ds: DiscordStore): Record<string, unknown> {
  const member = v.guild_snowflake
    ? ds.members.findBy("guild_snowflake", v.guild_snowflake).find((m) => m.user_snowflake === v.user_snowflake)
    : undefined;
  return {
    guild_id: v.guild_snowflake ?? undefined,
    channel_id: v.channel_snowflake,
    user_id: v.user_snowflake,
    member: member ? toAPIMember(member, ds) : undefined,
    session_id: v.session_id,
    deaf: v.deaf,
    mute: v.mute,
    self_deaf: v.self_deaf,
    self_mute: v.self_mute,
    self_stream: v.self_stream ?? undefined,
    self_video: v.self_video,
    suppress: v.suppress,
    request_to_speak_timestamp: v.request_to_speak_timestamp,
  };
}

export function toAPIChannel(c: DiscordChannel): Record<string, unknown> {
  const isThread = c.type === 10 || c.type === 11 || c.type === 12;
  const isDM = c.type === 1 || c.type === 3;
  const base: Record<string, unknown> = {
    id: c.snowflake,
    type: c.type,
    flags: 0,
    last_message_id: c.last_message_snowflake,
  };

  // DM (1) and group DM (3) channels carry no guild-scoped fields.
  if (isDM) {
    if (c.recipient_snowflakes.length > 0) base.recipients = c.recipient_snowflakes;
    if (c.type === 3) {
      base.name = c.name;
      base.owner_id = c.owner_snowflake ?? null;
      base.icon = null;
    }
    return base;
  }

  base.guild_id = c.guild_snowflake ?? undefined;
  base.name = c.name;
  base.position = c.position;
  base.parent_id = c.parent_snowflake;
  base.permission_overwrites = c.permission_overwrites;
  base.nsfw = c.nsfw;
  base.topic = c.topic;
  base.rate_limit_per_user = c.rate_limit_per_user;
  if (c.bitrate != null) base.bitrate = c.bitrate;
  if (c.user_limit != null) base.user_limit = c.user_limit;
  // Voice (2) and stage (13) extras.
  if (c.type === 2 || c.type === 13) {
    base.rtc_region = null;
    base.video_quality_mode = 1;
  }
  // Forum (15) and media (16) extras.
  if (c.type === 15 || c.type === 16) {
    base.available_tags = [];
    base.default_reaction_emoji = null;
    base.default_sort_order = null;
    base.default_forum_layout = 0;
    base.default_thread_rate_limit_per_user = 0;
  }
  if (isThread) {
    base.owner_id = c.owner_snowflake ?? null;
    base.thread_metadata = c.thread_metadata ?? null;
    base.message_count = c.message_count ?? 0;
    base.member_count = c.member_count ?? 0;
    base.total_message_sent = c.message_count ?? 0;
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
  return [...map.values()].map((a) => ({
    count: a.count,
    count_details: { burst: 0, normal: a.count },
    me: a.me,
    me_burst: false,
    emoji: a.emoji,
    burst_colors: [],
  }));
}

export function toAPIMessage(m: DiscordMessage, ds: DiscordStore, meSnowflake?: string): Record<string, unknown> {
  // Webhook messages with a custom username/avatar present a webhook-shaped author.
  const author =
    m.webhook_snowflake && m.webhook_username
      ? {
          id: m.webhook_snowflake,
          username: m.webhook_username,
          global_name: null,
          avatar: m.webhook_avatar ?? null,
          discriminator: "0000",
          bot: true,
          public_flags: 0,
        }
      : (() => {
          const user = ds.users.findOneBy("snowflake", m.author_snowflake);
          return user ? toAPIUser(user) : undefined;
        })();
  const mentions = m.mention_snowflakes
    .map((s) => ds.users.findOneBy("snowflake", s))
    .filter((u): u is DiscordUser => !!u)
    .map((u) => toAPIUser(u));
  return {
    id: m.snowflake,
    channel_id: m.channel_snowflake,
    guild_id: m.guild_snowflake ?? undefined,
    author,
    content: m.content,
    timestamp: m.timestamp,
    edited_timestamp: m.edited_timestamp,
    tts: m.tts,
    mention_everyone: m.mention_everyone,
    mentions,
    mention_roles: m.mention_role_snowflakes,
    mention_channels: [],
    attachments: m.attachments,
    embeds: m.embeds,
    components: m.components,
    sticker_items: [],
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
    poll: m.poll ? toAPIPoll(m, ds, meSnowflake) : undefined,
  };
}

export function toAPIPoll(m: DiscordMessage, ds: DiscordStore, meSnowflake?: string): Record<string, unknown> {
  const poll = m.poll!;
  const votes = ds.pollVotes.findBy("message_snowflake", m.snowflake);
  const counts = new Map<number, { count: number; me: boolean }>();
  for (const v of votes) {
    const agg = counts.get(v.answer_id) ?? { count: 0, me: false };
    agg.count += 1;
    if (meSnowflake && v.user_snowflake === meSnowflake) agg.me = true;
    counts.set(v.answer_id, agg);
  }
  return {
    question: poll.question,
    answers: poll.answers,
    expiry: poll.expiry ?? null,
    allow_multiselect: poll.allow_multiselect ?? false,
    layout_type: poll.layout_type ?? 1,
    results: {
      is_finalized: !!m.poll_finalized,
      answer_counts: [...counts.entries()].map(([id, a]) => ({ id, count: a.count, me_voted: a.me })),
    },
  };
}

/** A message payload with content-bearing fields stripped (for sessions lacking MESSAGE_CONTENT). */
export function redactMessageContent(message: Record<string, unknown>): Record<string, unknown> {
  return { ...message, content: "", embeds: [], components: [], attachments: [], poll: undefined };
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
    // Documented fields emitted with stable defaults (read fidelity); the ones backed by
    // optional entity columns reflect stored state.
    icon_hash: null,
    discovery_splash: null,
    banner: null,
    owner: false,
    region: null,
    widget_enabled: g.widget_enabled ?? false,
    widget_channel_id: g.widget_channel_snowflake ?? null,
    system_channel_flags: 0,
    rules_channel_id: null,
    public_updates_channel_id: null,
    safety_alerts_channel_id: null,
    max_presences: null,
    max_members: 500_000,
    max_video_channel_users: 25,
    max_stage_video_channel_users: 50,
    vanity_url_code: null,
    application_id: null,
    premium_progress_bar_enabled: false,
    stickers: ds.stickers.findBy("guild_snowflake", g.snowflake).map((s) => ({
      id: s.snowflake,
      name: s.name,
      tags: s.tags,
      type: s.type,
      format_type: s.format_type,
      available: s.available,
      guild_id: s.guild_snowflake,
    })),
    welcome_screen: g.welcome_screen ?? undefined,
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
