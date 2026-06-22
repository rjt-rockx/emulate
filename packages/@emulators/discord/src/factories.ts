import type { DiscordStore } from "./store.js";
import { snowflake } from "./helpers.js";
import { generateEd25519KeyPair } from "./interactions/ed25519.js";
import type {
  DiscordUser,
  DiscordApplication,
  DiscordGuild,
  DiscordRole,
  DiscordChannel,
  DiscordGuildMember,
  DiscordMessage,
  DiscordEmoji,
  DiscordToken,
  DiscordTokenType,
} from "./entities.js";

const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Users & applications
// ---------------------------------------------------------------------------

export interface CreateUserInput {
  username: string;
  snowflake?: string;
  global_name?: string | null;
  discriminator?: string;
  avatar?: string | null;
  bot?: boolean;
  email?: string | null;
}

export function createUser(ds: DiscordStore, input: CreateUserInput): DiscordUser {
  return ds.users.insert({
    snowflake: input.snowflake ?? snowflake(),
    username: input.username,
    discriminator: input.discriminator ?? "0",
    global_name: input.global_name ?? input.username,
    avatar: input.avatar ?? null,
    bot: input.bot ?? false,
    system: false,
    mfa_enabled: false,
    email: input.email ?? null,
    verified: input.email != null,
    flags: 0,
    public_flags: 0,
    premium_type: 0,
    accent_color: null,
    banner: null,
    locale: "en-US",
  });
}

export interface CreateApplicationInput {
  name: string;
  botUsername: string;
  description?: string;
  ownerSnowflake?: string | null;
  publicKey?: string;
  privateKey?: string;
  interactionsEndpointUrl?: string | null;
}

export function createApplication(
  ds: DiscordStore,
  input: CreateApplicationInput,
): { application: DiscordApplication; botUser: DiscordUser } {
  const botUser = createUser(ds, { username: input.botUsername, bot: true, global_name: input.botUsername });
  let publicKey = input.publicKey;
  let privateKey = input.privateKey;
  if (!publicKey || !privateKey) {
    const pair = generateEd25519KeyPair();
    publicKey = publicKey ?? pair.publicKeyHex;
    privateKey = privateKey ?? pair.privateKeyPem;
  }
  const application = ds.applications.insert({
    snowflake: snowflake(),
    name: input.name,
    description: input.description ?? "",
    icon: null,
    bot_user_snowflake: botUser.snowflake,
    owner_snowflake: input.ownerSnowflake ?? null,
    verify_key: publicKey,
    private_key: privateKey,
    interactions_endpoint_url: input.interactionsEndpointUrl ?? null,
    flags: 0,
  });
  return { application, botUser };
}

export function createToken(
  ds: DiscordStore,
  input: {
    token: string;
    type: DiscordTokenType;
    userSnowflake: string;
    applicationSnowflake?: string | null;
    scopes?: string[];
    expiresAt?: string | null;
    refreshToken?: string | null;
  },
): DiscordToken {
  return ds.tokens.insert({
    token: input.token,
    type: input.type,
    user_snowflake: input.userSnowflake,
    application_snowflake: input.applicationSnowflake ?? null,
    scopes: input.scopes ?? [],
    expires_at: input.expiresAt ?? null,
    refresh_token: input.refreshToken ?? null,
  });
}

// ---------------------------------------------------------------------------
// Guilds, roles, members, channels
// ---------------------------------------------------------------------------

export interface CreateGuildInput {
  name: string;
  ownerSnowflake: string;
  snowflake?: string;
  icon?: string | null;
  description?: string | null;
}

export function createGuild(ds: DiscordStore, input: CreateGuildInput): DiscordGuild {
  const id = input.snowflake ?? snowflake();
  const guild = ds.guilds.insert({
    snowflake: id,
    name: input.name,
    icon: input.icon ?? null,
    splash: null,
    owner_snowflake: input.ownerSnowflake,
    afk_channel_snowflake: null,
    afk_timeout: 300,
    verification_level: 0,
    default_message_notifications: 0,
    explicit_content_filter: 0,
    mfa_level: 0,
    nsfw_level: 0,
    premium_tier: 0,
    premium_subscription_count: 0,
    preferred_locale: "en-US",
    description: input.description ?? null,
    features: [],
    system_channel_snowflake: null,
    member_snowflakes: [],
    large: false,
    unavailable: false,
  });
  // @everyone role: id equals guild id, by Discord convention.
  ds.roles.insert({
    snowflake: id,
    guild_snowflake: id,
    name: "@everyone",
    color: 0,
    hoist: false,
    position: 0,
    permissions: "559623605571137",
    managed: false,
    mentionable: false,
    icon: null,
  });
  addGuildMember(ds, id, input.ownerSnowflake);
  return guild;
}

export interface CreateRoleInput {
  name?: string;
  color?: number;
  hoist?: boolean;
  permissions?: string;
  mentionable?: boolean;
  position?: number;
  icon?: string | null;
  unicodeEmoji?: string | null;
  flags?: number;
  managed?: boolean;
  tags?: Record<string, unknown> | null;
}

export function createRole(ds: DiscordStore, guildSnowflake: string, input: CreateRoleInput): DiscordRole {
  const existing = ds.roles.findBy("guild_snowflake", guildSnowflake);
  return ds.roles.insert({
    snowflake: snowflake(),
    guild_snowflake: guildSnowflake,
    name: input.name ?? "new role",
    color: input.color ?? 0,
    hoist: input.hoist ?? false,
    position: input.position ?? existing.length,
    permissions: input.permissions ?? "0",
    managed: input.managed ?? false,
    mentionable: input.mentionable ?? false,
    icon: input.icon ?? null,
    unicode_emoji: input.unicodeEmoji ?? null,
    flags: input.flags ?? 0,
    tags: input.tags ?? null,
  });
}

export function addGuildMember(
  ds: DiscordStore,
  guildSnowflake: string,
  userSnowflake: string,
  input: { nick?: string | null; roles?: string[] } = {},
): DiscordGuildMember | null {
  const existing = ds.members.findBy("guild_snowflake", guildSnowflake).find((m) => m.user_snowflake === userSnowflake);
  if (existing) return existing;
  const member = ds.members.insert({
    guild_snowflake: guildSnowflake,
    user_snowflake: userSnowflake,
    nick: input.nick ?? null,
    avatar: null,
    role_snowflakes: input.roles ?? [],
    joined_at: now(),
    premium_since: null,
    deaf: false,
    mute: false,
    pending: false,
    communication_disabled_until: null,
  });
  const guild = ds.guilds.findOneBy("snowflake", guildSnowflake);
  if (guild && !guild.member_snowflakes.includes(userSnowflake)) {
    ds.guilds.update(guild.id, { member_snowflakes: [...guild.member_snowflakes, userSnowflake] });
  }
  return member;
}

export interface CreateChannelInput {
  name: string;
  type?: number;
  guildSnowflake?: string | null;
  topic?: string | null;
  parentSnowflake?: string | null;
  nsfw?: boolean;
  position?: number;
  bitrate?: number | null;
  userLimit?: number | null;
  rateLimitPerUser?: number;
  permissionOverwrites?: DiscordChannel["permission_overwrites"];
  rtcRegion?: string | null;
  videoQualityMode?: number;
  defaultAutoArchiveDuration?: number;
  availableTags?: unknown[];
  defaultReactionEmoji?: unknown | null;
  defaultSortOrder?: number | null;
  defaultForumLayout?: number;
  defaultThreadRateLimitPerUser?: number;
}

export function createChannel(ds: DiscordStore, input: CreateChannelInput): DiscordChannel {
  const type = input.type ?? 0;
  const isVoice = type === 2 || type === 13;
  const isForum = type === 15 || type === 16;
  const guildChannels = input.guildSnowflake ? ds.channels.findBy("guild_snowflake", input.guildSnowflake) : [];
  return ds.channels.insert({
    snowflake: snowflake(),
    guild_snowflake: input.guildSnowflake ?? null,
    type,
    name: input.name,
    position: input.position ?? guildChannels.length,
    topic: input.topic ?? null,
    nsfw: input.nsfw ?? false,
    last_message_snowflake: null,
    parent_snowflake: input.parentSnowflake ?? null,
    rate_limit_per_user: input.rateLimitPerUser ?? 0,
    bitrate: isVoice ? (input.bitrate ?? 64000) : null,
    user_limit: isVoice ? (input.userLimit ?? 0) : null,
    permission_overwrites: input.permissionOverwrites ?? [],
    recipient_snowflakes: [],
    flags: 0,
    ...(isVoice ? { rtc_region: input.rtcRegion ?? null, video_quality_mode: input.videoQualityMode ?? 1 } : {}),
    ...(input.defaultAutoArchiveDuration != null
      ? { default_auto_archive_duration: input.defaultAutoArchiveDuration }
      : {}),
    ...(isForum
      ? {
          available_tags: input.availableTags ?? [],
          default_reaction_emoji: input.defaultReactionEmoji ?? null,
          default_sort_order: input.defaultSortOrder ?? null,
          default_forum_layout: input.defaultForumLayout ?? 0,
          default_thread_rate_limit_per_user: input.defaultThreadRateLimitPerUser ?? 0,
        }
      : {}),
  });
}

export interface CreateMessageInput {
  channelSnowflake: string;
  guildSnowflake?: string | null;
  authorSnowflake: string;
  content?: string;
  tts?: boolean;
  type?: number;
  flags?: number;
  nonce?: string | null;
  embeds?: unknown[];
  components?: unknown[];
  attachments?: unknown[];
  webhookSnowflake?: string | null;
  webhookUsername?: string | null;
  webhookAvatar?: string | null;
  mentionSnowflakes?: string[];
  mentionRoleSnowflakes?: string[];
  mentionEveryone?: boolean;
  messageReference?: DiscordMessage["message_reference"];
  referencedMessageSnowflake?: string | null;
  stickerSnowflakes?: string[];
  messageSnapshots?: unknown[];
  poll?: DiscordMessage["poll"];
}

export function createMessage(ds: DiscordStore, input: CreateMessageInput): DiscordMessage {
  const message = ds.messages.insert({
    snowflake: snowflake(),
    channel_snowflake: input.channelSnowflake,
    guild_snowflake: input.guildSnowflake ?? null,
    author_snowflake: input.authorSnowflake,
    content: input.content ?? "",
    timestamp: now(),
    edited_timestamp: null,
    tts: input.tts ?? false,
    mention_everyone: input.mentionEveryone ?? false,
    mention_snowflakes: input.mentionSnowflakes ?? [],
    mention_role_snowflakes: input.mentionRoleSnowflakes ?? [],
    attachments: input.attachments ?? [],
    embeds: input.embeds ?? [],
    components: input.components ?? [],
    pinned: false,
    webhook_snowflake: input.webhookSnowflake ?? null,
    webhook_username: input.webhookUsername ?? null,
    webhook_avatar: input.webhookAvatar ?? null,
    type: input.type ?? 0,
    flags: input.flags ?? 0,
    nonce: input.nonce ?? null,
    message_reference: input.messageReference ?? null,
    referenced_message_snowflake: input.referencedMessageSnowflake ?? null,
    sticker_snowflakes: input.stickerSnowflakes ?? [],
    message_snapshots: input.messageSnapshots,
    poll: input.poll ?? null,
    poll_finalized: false,
  });
  const channel = ds.channels.findOneBy("snowflake", input.channelSnowflake);
  if (channel) ds.channels.update(channel.id, { last_message_snowflake: message.snowflake });
  return message;
}

export function createEmoji(
  ds: DiscordStore,
  guildSnowflake: string,
  input: { name: string; animated?: boolean; creatorSnowflake?: string | null; roles?: string[] },
): DiscordEmoji {
  return ds.emojis.insert({
    snowflake: snowflake(),
    guild_snowflake: guildSnowflake,
    name: input.name,
    animated: input.animated ?? false,
    managed: false,
    available: true,
    require_colons: true,
    creator_snowflake: input.creatorSnowflake ?? null,
    role_snowflakes: input.roles ?? [],
  });
}
