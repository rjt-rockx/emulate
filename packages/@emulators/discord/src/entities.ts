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
  premium_tier: number;
  premium_subscription_count: number;
  preferred_locale: string;
  description: string | null;
  features: string[];
  system_channel_snowflake: string | null;
  member_snowflakes: string[];
  large: boolean;
  unavailable: boolean;
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
}

export interface DiscordGuildMember extends Entity {
  guild_snowflake: string;
  user_snowflake: string;
  nick: string | null;
  avatar: string | null;
  role_snowflakes: string[];
  joined_at: string;
  premium_since: string | null;
  deaf: boolean;
  mute: boolean;
  pending: boolean;
  communication_disabled_until: string | null;
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
  type: number; // MessageType
  flags: number;
  nonce: string | null;
  message_reference: DiscordMessageReference | null;
  referenced_message_snowflake: string | null;
}

export interface DiscordMessageReference {
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

/** Lightweight mirror of a live gateway connection, for the inspector. */
export interface DiscordGatewaySession extends Entity {
  session_id: string;
  bot_user_snowflake: string;
  application_snowflake: string | null;
  intents: number;
  connected_at: string;
}
