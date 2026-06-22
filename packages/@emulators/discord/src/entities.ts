import type { Entity } from "@emulators/core";

/**
 * Discord entities. Each extends the core `Entity` (numeric autoincrement `id`,
 * `created_at`, `updated_at`) and carries its real Discord snowflake as a string in a
 * dedicated `*_snowflake` / `snowflake` field. Lookups in the store use the snowflake
 * fields (indexed); the numeric `id` stays an internal detail.
 */

export interface DiscordUser extends Entity {
  snowflake: string;
  username: string;
  discriminator: string; // "0" for migrated/bot accounts
  global_name: string | null;
  avatar: string | null;
  bot: boolean;
  system: boolean;
  mfa_enabled: boolean;
  email: string | null;
  verified: boolean;
  flags: number;
  public_flags: number;
  premium_type: number;
  accent_color: number | null;
  banner: string | null;
  locale: string;
}

export interface DiscordApplication extends Entity {
  snowflake: string;
  name: string;
  description: string;
  icon: string | null;
  bot_user_snowflake: string;
  owner_snowflake: string | null;
  /** Ed25519 public key as 32-byte hex (what apps paste into their signature verifier). */
  verify_key: string;
  /** Ed25519 private key (PEM) the emulator signs HTTP interaction deliveries with. */
  private_key: string;
  interactions_endpoint_url: string | null;
  flags: number;
  role_connection_metadata?: unknown[];
}

export interface DiscordRoleConnection extends Entity {
  application_snowflake: string;
  user_snowflake: string;
  platform_name: string | null;
  platform_username: string | null;
  metadata: Record<string, string>;
}

export interface DiscordOAuthApp extends Entity {
  client_id: string;
  client_secret: string;
  application_snowflake: string;
  name: string;
  redirect_uris: string[];
  scopes: string[];
}

export interface DiscordGuild extends Entity {
  snowflake: string;
  name: string;
  icon: string | null;
  splash: string | null;
  owner_snowflake: string;
  afk_channel_snowflake: string | null;
  afk_timeout: number;
  verification_level: number;
  default_message_notifications: number;
  explicit_content_filter: number;
  mfa_level: number;
  nsfw_level: number;
  /** Deprecated NSFW boolean (distinct from nsfw_level); required on the wire object. */
  nsfw?: boolean;
  /** Guild home header asset hash (null when unset). */
  home_header?: string | null;
  premium_tier: number;
  premium_subscription_count: number;
  preferred_locale: string;
  description: string | null;
  features: string[];
  system_channel_snowflake: string | null;
  member_snowflakes: string[];
  large: boolean;
  unavailable: boolean;
  banner?: string | null;
  discovery_splash?: string | null;
  system_channel_flags?: number;
  rules_channel_snowflake?: string | null;
  public_updates_channel_snowflake?: string | null;
  safety_alerts_channel_snowflake?: string | null;
  premium_progress_bar_enabled?: boolean;
  vanity_url_code?: string | null;
  /** Security incident actions (invites_disabled_until / dms_disabled_until / ...). */
  incidents_data?: Record<string, unknown> | null;
  widget_enabled?: boolean;
  widget_channel_snowflake?: string | null;
  welcome_screen?: { description: string | null; welcome_channels: unknown[] } | null;
  onboarding?: { prompts: unknown[]; default_channel_ids: string[]; enabled: boolean; mode: number } | null;
}

export interface DiscordRole extends Entity {
  snowflake: string;
  guild_snowflake: string;
  name: string;
  color: number;
  hoist: boolean;
  position: number;
  permissions: string; // bitfield as decimal string
  managed: boolean;
  mentionable: boolean;
  icon: string | null;
  unicode_emoji?: string | null;
  /** Role flags bitfield (IN_PROMPT 1<<0). */
  flags?: number;
  /** Role tags (bot_id, integration_id, premium_subscriber, ...) for managed roles. */
  tags?: Record<string, unknown> | null;
  /** Holographic/gradient role colors (primary + optional secondary/tertiary). */
  colors?: { primary_color: number; secondary_color: number | null; tertiary_color: number | null } | null;
}

export interface DiscordGuildMember extends Entity {
  guild_snowflake: string;
  user_snowflake: string;
  nick: string | null;
  avatar: string | null;
  banner?: string | null;
  role_snowflakes: string[];
  joined_at: string;
  premium_since: string | null;
  deaf: boolean;
  mute: boolean;
  pending: boolean;
  communication_disabled_until: string | null;
  /** Guild member flags (DID_REJOIN 1<<0, COMPLETED_ONBOARDING 1<<1, ...). */
  flags?: number;
}

export interface DiscordChannel extends Entity {
  snowflake: string;
  guild_snowflake: string | null;
  type: number; // ChannelType
  name: string | null;
  position: number;
  topic: string | null;
  nsfw: boolean;
  last_message_snowflake: string | null;
  parent_snowflake: string | null;
  rate_limit_per_user: number;
  bitrate: number | null;
  user_limit: number | null;
  permission_overwrites: DiscordPermissionOverwrite[];
  recipient_snowflakes: string[]; // for DM / group DM channels
  /** Channel flags bitfield (PINNED 1<<1, REQUIRE_TAG 1<<4, ...). */
  flags?: number;
  last_pin_timestamp?: string | null;
  default_auto_archive_duration?: number;
  rtc_region?: string | null;
  video_quality_mode?: number;
  // Forum / media (types 15/16) configuration.
  available_tags?: unknown[];
  default_reaction_emoji?: unknown | null;
  default_sort_order?: number | null;
  default_forum_layout?: number;
  default_thread_rate_limit_per_user?: number;
  // Thread-only fields (channel types 10/11/12).
  owner_snowflake?: string | null;
  thread_metadata?: DiscordThreadMetadata | null;
  /** Messages in the thread excluding the initial message. */
  message_count?: number;
  member_count?: number;
  /** Total messages ever sent in the thread (includes the initial message; never decrements). */
  total_message_sent?: number;
  applied_tags?: string[];
}

export interface DiscordThreadMetadata {
  archived: boolean;
  auto_archive_duration: number;
  archive_timestamp: string;
  locked: boolean;
  invitable?: boolean;
  create_timestamp?: string | null;
}

export interface DiscordThreadMember extends Entity {
  thread_snowflake: string;
  user_snowflake: string;
  joined_at: string;
}

export interface DiscordPermissionOverwrite {
  id: string;
  type: number; // 0 = role, 1 = member
  allow: string;
  deny: string;
}

export interface DiscordMessage extends Entity {
  snowflake: string;
  channel_snowflake: string;
  guild_snowflake: string | null;
  author_snowflake: string;
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  tts: boolean;
  mention_everyone: boolean;
  mention_snowflakes: string[];
  mention_role_snowflakes: string[];
  attachments: unknown[];
  embeds: unknown[];
  components: unknown[];
  pinned: boolean;
  webhook_snowflake: string | null;
  /** Per-message webhook author overrides (custom username/avatar on webhook execute). */
  webhook_username?: string | null;
  webhook_avatar?: string | null;
  type: number; // MessageType
  flags: number;
  nonce: string | null;
  message_reference: DiscordMessageReference | null;
  referenced_message_snowflake: string | null;
  /** Stickers attached to the message (Create Message `sticker_ids`). */
  sticker_snowflakes?: string[];
  /** Immutable snapshots captured for a forwarded message (message_reference type 1). */
  message_snapshots?: unknown[];
  poll?: DiscordPoll | null;
  poll_finalized?: boolean;
}

export interface DiscordPoll {
  question: { text: string };
  answers: Array<{ answer_id: number; poll_media: { text?: string; emoji?: unknown } }>;
  expiry?: string | null;
  allow_multiselect?: boolean;
  layout_type?: number;
}

export interface DiscordPollVote extends Entity {
  message_snowflake: string;
  channel_snowflake: string;
  guild_snowflake: string | null;
  answer_id: number;
  user_snowflake: string;
}

export interface DiscordMessageReference {
  type?: number; // 0 = DEFAULT (reply), 1 = FORWARD
  message_id?: string;
  channel_id?: string;
  guild_id?: string;
}

/** One user's reaction with a specific emoji on a message. */
export interface DiscordReaction extends Entity {
  message_snowflake: string;
  channel_snowflake: string;
  guild_snowflake: string | null;
  user_snowflake: string;
  emoji_name: string;
  emoji_snowflake: string | null;
  emoji_animated: boolean;
  /** True for a super-reaction (BURST, reaction type 1). */
  burst?: boolean;
}

export interface DiscordEmoji extends Entity {
  snowflake: string;
  guild_snowflake: string;
  name: string;
  animated: boolean;
  managed: boolean;
  available: boolean;
  require_colons: boolean;
  creator_snowflake: string | null;
  role_snowflakes: string[];
}

export interface DiscordApplicationCommand extends Entity {
  snowflake: string;
  application_snowflake: string;
  guild_snowflake: string | null; // null = global
  type: number; // 1 = CHAT_INPUT, 2 = USER, 3 = MESSAGE
  name: string;
  description: string;
  options: unknown[];
  default_member_permissions: string | null;
  dm_permission: boolean;
  nsfw: boolean;
  version: string;
  /** Installation contexts (0 GUILD_INSTALL, 1 USER_INSTALL); null = default. */
  integration_types?: number[] | null;
  /** Interaction contexts (0 GUILD, 1 BOT_DM, 2 PRIVATE_CHANNEL); null = default. */
  contexts?: number[] | null;
  name_localizations?: Record<string, string> | null;
  description_localizations?: Record<string, string> | null;
  default_permission?: boolean | null;
  /** Entry point handler (1 APP_HANDLER, 2 DISCORD_LAUNCH_ACTIVITY) for PRIMARY_ENTRY_POINT. */
  handler?: number | null;
}

export type DiscordTokenType = "bot" | "bearer";

export interface DiscordToken extends Entity {
  token: string;
  type: DiscordTokenType;
  user_snowflake: string;
  application_snowflake: string | null;
  scopes: string[];
  expires_at: string | null;
  refresh_token: string | null;
}

export interface DiscordWebhook extends Entity {
  snowflake: string;
  type: number; // 1 = Incoming, 2 = Channel Follower, 3 = Application
  guild_snowflake: string | null;
  channel_snowflake: string;
  user_snowflake: string | null;
  name: string | null;
  avatar: string | null;
  token: string;
  application_snowflake: string | null;
  /** For channel-follower webhooks (type 2): the followed source guild/channel. */
  source_guild_snowflake?: string | null;
  source_channel_snowflake?: string | null;
}

export interface DiscordInteraction extends Entity {
  snowflake: string;
  token: string;
  type: number; // InteractionType: 1 PING, 2 APPLICATION_COMMAND, 3 MESSAGE_COMPONENT, 4 AUTOCOMPLETE, 5 MODAL_SUBMIT
  application_snowflake: string;
  guild_snowflake: string | null;
  channel_snowflake: string | null;
  user_snowflake: string;
  data: unknown;
  message_snowflake: string | null;
  callback_used: boolean;
  expires_at: string;
}

export interface DiscordAuditLogEntry extends Entity {
  snowflake: string;
  guild_snowflake: string;
  user_snowflake: string | null; // the actor
  target_snowflake: string | null;
  action_type: number;
  changes: unknown[];
  reason: string | null;
  options?: Record<string, unknown>;
}

export interface DiscordBan extends Entity {
  guild_snowflake: string;
  user_snowflake: string;
  reason: string | null;
}

export interface DiscordInvite extends Entity {
  code: string;
  guild_snowflake: string | null;
  channel_snowflake: string;
  inviter_snowflake: string | null;
  uses: number;
  max_uses: number;
  max_age: number;
  temporary: boolean;
  expires_at: string | null;
  /** 1 = STREAM, 2 = EMBEDDED_APPLICATION. */
  target_type?: number | null;
  target_user_snowflake?: string | null;
  target_application_snowflake?: string | null;
  flags?: number;
}

export interface DiscordSticker extends Entity {
  snowflake: string;
  guild_snowflake: string;
  name: string;
  description: string | null;
  tags: string;
  type: number; // 1 = standard, 2 = guild
  format_type: number; // 1 PNG, 2 APNG, 3 LOTTIE, 4 GIF
  available: boolean;
  creator_snowflake: string | null;
}

export interface DiscordScheduledEvent extends Entity {
  snowflake: string;
  guild_snowflake: string;
  channel_snowflake: string | null;
  creator_snowflake: string | null;
  name: string;
  description: string | null;
  scheduled_start_time: string;
  scheduled_end_time: string | null;
  privacy_level: number; // 2 = guild only
  status: number; // 1 scheduled, 2 active, 3 completed, 4 canceled
  entity_type: number; // 1 stage, 2 voice, 3 external
  user_count: number;
  entity_snowflake?: string | null;
  entity_metadata?: { location?: string } | null;
  recurrence_rule?: unknown | null;
  image?: string | null;
}

/** A user's subscription to a guild scheduled event. */
export interface DiscordScheduledEventUser extends Entity {
  event_snowflake: string;
  guild_snowflake: string;
  user_snowflake: string;
}

export interface DiscordStageInstance extends Entity {
  snowflake: string;
  guild_snowflake: string;
  channel_snowflake: string;
  topic: string;
  privacy_level: number; // 2 = guild only
  discoverable_disabled: boolean;
  guild_scheduled_event_snowflake?: string | null;
}

export interface DiscordAutoModRule extends Entity {
  snowflake: string;
  guild_snowflake: string;
  creator_snowflake: string | null;
  name: string;
  event_type: number;
  trigger_type: number;
  trigger_metadata: Record<string, unknown>;
  actions: unknown[];
  enabled: boolean;
  exempt_roles: string[];
  exempt_channels: string[];
}

export interface DiscordSoundboardSound extends Entity {
  snowflake: string;
  guild_snowflake: string;
  name: string;
  volume: number;
  emoji_name: string | null;
  emoji_snowflake: string | null;
  available: boolean;
  creator_snowflake: string | null;
}

export interface DiscordGuildTemplate extends Entity {
  code: string;
  source_guild_snowflake: string;
  name: string;
  description: string | null;
  usage_count: number;
  creator_snowflake: string | null;
}

/** Lightweight mirror of a live gateway connection, for the inspector. */
export interface DiscordGatewaySession extends Entity {
  session_id: string;
  bot_user_snowflake: string;
  application_snowflake: string | null;
  intents: number;
  connected_at: string;
}

/** An emoji owned by an application (separate from guild emojis). */
export interface DiscordApplicationEmoji extends Entity {
  snowflake: string;
  application_snowflake: string;
  name: string;
  animated: boolean;
  managed: boolean;
  available: boolean;
  require_colons: boolean;
  creator_snowflake: string | null;
  role_snowflakes: string[];
}

/** Application-command permission overrides for a guild. */
export interface DiscordCommandPermissions extends Entity {
  application_snowflake: string;
  guild_snowflake: string;
  /** command id, or the application id as a guild-wide constant. */
  command_snowflake: string;
  permissions: Array<{ id: string; type: number; permission: boolean }>;
}

/** A guild integration (bot/webhook/twitch/youtube/discord-application). */
export interface DiscordIntegration extends Entity {
  snowflake: string;
  guild_snowflake: string;
  name: string;
  type: string; // "twitch" | "youtube" | "discord" | "guild_subscription"
  enabled: boolean;
  syncing?: boolean;
  role_snowflake?: string | null;
  enable_emoticons?: boolean;
  expire_behavior?: number;
  expire_grace_period?: number;
  user_snowflake?: string | null;
  account: { id: string; name: string };
  synced_at?: string | null;
  subscriber_count?: number;
  revoked?: boolean;
  application_snowflake?: string | null;
  scopes?: string[];
}

/** A third-party account connection on a user (oauth `connections` scope). */
export interface DiscordConnection extends Entity {
  user_snowflake: string;
  connection_id: string; // id on the external platform
  name: string;
  type: string; // "github" | "twitch" | "steam" | ...
  revoked?: boolean;
  verified: boolean;
  friend_sync: boolean;
  show_activity: boolean;
  two_way_link: boolean;
  visibility: number; // 0 none, 1 everyone
}

/** A user's voice connection state within a guild. */
export interface DiscordVoiceState extends Entity {
  guild_snowflake: string | null;
  channel_snowflake: string | null;
  user_snowflake: string;
  session_id: string;
  deaf: boolean;
  mute: boolean;
  self_deaf: boolean;
  self_mute: boolean;
  self_stream?: boolean;
  self_video: boolean;
  suppress: boolean;
  request_to_speak_timestamp: string | null;
}

/** A monetization SKU (premium offering) for an application. */
export interface DiscordSKU extends Entity {
  snowflake: string;
  application_snowflake: string;
  type: number; // 2 DURABLE, 3 CONSUMABLE, 5 SUBSCRIPTION, 6 SUBSCRIPTION_GROUP
  name: string;
  slug: string;
  flags: number;
}

/** A user's/guild's entitlement to a SKU. */
export interface DiscordEntitlement extends Entity {
  snowflake: string;
  sku_snowflake: string;
  application_snowflake: string;
  user_snowflake: string | null;
  guild_snowflake: string | null;
  type: number; // 8 APPLICATION_SUBSCRIPTION, 1 PURCHASE, ...
  deleted: boolean;
  starts_at: string | null;
  ends_at: string | null;
  consumed?: boolean;
  subscription_snowflake?: string | null;
}

/** A recurring subscription to one or more SKUs. */
export interface DiscordSubscription extends Entity {
  snowflake: string;
  user_snowflake: string;
  sku_snowflakes: string[];
  entitlement_snowflakes: string[];
  current_period_start: string;
  current_period_end: string;
  status: number; // 0 ACTIVE, 1 INACTIVE, 2 ENDING (per subscription.mdx)
  canceled_at: string | null;
  renewal_sku_snowflakes?: string[] | null;
}

/** A Social SDK lobby. */
export interface DiscordLobby extends Entity {
  snowflake: string;
  application_snowflake: string;
  metadata: Record<string, string> | null;
  linked_channel_snowflake: string | null;
  flags?: number;
}

/** Membership of a user in a lobby. */
export interface DiscordLobbyMember extends Entity {
  lobby_snowflake: string;
  user_snowflake: string;
  metadata: Record<string, string> | null;
  flags: number;
}

/** A message sent inside a lobby. */
export interface DiscordLobbyMessage extends Entity {
  snowflake: string;
  lobby_snowflake: string;
  channel_snowflake: string | null;
  author_snowflake: string;
  content: string;
  metadata: Record<string, string> | null;
  /** Bot-settable message flags carried on the create body. */
  flags?: number;
  /** App-scoped moderation metadata set via the moderation-metadata endpoint. */
  moderation_metadata?: Record<string, string> | null;
}
