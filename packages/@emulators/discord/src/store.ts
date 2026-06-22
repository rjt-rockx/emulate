import { Store, type Collection } from "@emulators/core";
import type {
  DiscordUser,
  DiscordApplication,
  DiscordOAuthApp,
  DiscordGuild,
  DiscordRole,
  DiscordGuildMember,
  DiscordChannel,
  DiscordMessage,
  DiscordReaction,
  DiscordEmoji,
  DiscordApplicationCommand,
  DiscordToken,
  DiscordWebhook,
  DiscordInteraction,
  DiscordBan,
  DiscordAuditLogEntry,
  DiscordInvite,
  DiscordSticker,
  DiscordScheduledEvent,
  DiscordScheduledEventUser,
  DiscordThreadMember,
  DiscordStageInstance,
  DiscordAutoModRule,
  DiscordGuildTemplate,
  DiscordPollVote,
  DiscordRoleConnection,
  DiscordSoundboardSound,
  DiscordGatewaySession,
  DiscordApplicationEmoji,
  DiscordCommandPermissions,
  DiscordIntegration,
  DiscordConnection,
  DiscordVoiceState,
  DiscordSKU,
  DiscordEntitlement,
  DiscordSubscription,
  DiscordLobby,
  DiscordLobbyMember,
  DiscordLobbyMessage,
} from "./entities.js";

export interface DiscordStore {
  users: Collection<DiscordUser>;
  applications: Collection<DiscordApplication>;
  oauthApps: Collection<DiscordOAuthApp>;
  guilds: Collection<DiscordGuild>;
  roles: Collection<DiscordRole>;
  members: Collection<DiscordGuildMember>;
  channels: Collection<DiscordChannel>;
  messages: Collection<DiscordMessage>;
  reactions: Collection<DiscordReaction>;
  emojis: Collection<DiscordEmoji>;
  commands: Collection<DiscordApplicationCommand>;
  tokens: Collection<DiscordToken>;
  webhooks: Collection<DiscordWebhook>;
  interactions: Collection<DiscordInteraction>;
  bans: Collection<DiscordBan>;
  auditLog: Collection<DiscordAuditLogEntry>;
  invites: Collection<DiscordInvite>;
  stickers: Collection<DiscordSticker>;
  scheduledEvents: Collection<DiscordScheduledEvent>;
  scheduledEventUsers: Collection<DiscordScheduledEventUser>;
  threadMembers: Collection<DiscordThreadMember>;
  stageInstances: Collection<DiscordStageInstance>;
  autoModRules: Collection<DiscordAutoModRule>;
  guildTemplates: Collection<DiscordGuildTemplate>;
  pollVotes: Collection<DiscordPollVote>;
  roleConnections: Collection<DiscordRoleConnection>;
  soundboardSounds: Collection<DiscordSoundboardSound>;
  gatewaySessions: Collection<DiscordGatewaySession>;
  appEmojis: Collection<DiscordApplicationEmoji>;
  commandPermissions: Collection<DiscordCommandPermissions>;
  integrations: Collection<DiscordIntegration>;
  connections: Collection<DiscordConnection>;
  voiceStates: Collection<DiscordVoiceState>;
  skus: Collection<DiscordSKU>;
  entitlements: Collection<DiscordEntitlement>;
  subscriptions: Collection<DiscordSubscription>;
  lobbies: Collection<DiscordLobby>;
  lobbyMembers: Collection<DiscordLobbyMember>;
  lobbyMessages: Collection<DiscordLobbyMessage>;
}

export function getDiscordStore(store: Store): DiscordStore {
  return {
    users: store.collection<DiscordUser>("discord.users", ["snowflake", "username", "email"]),
    applications: store.collection<DiscordApplication>("discord.applications", [
      "snowflake",
      "bot_user_snowflake",
    ]),
    oauthApps: store.collection<DiscordOAuthApp>("discord.oauth_apps", ["client_id", "application_snowflake"]),
    guilds: store.collection<DiscordGuild>("discord.guilds", ["snowflake", "name"]),
    roles: store.collection<DiscordRole>("discord.roles", ["snowflake", "guild_snowflake"]),
    members: store.collection<DiscordGuildMember>("discord.members", ["guild_snowflake", "user_snowflake"]),
    channels: store.collection<DiscordChannel>("discord.channels", ["snowflake", "guild_snowflake", "parent_snowflake"]),
    messages: store.collection<DiscordMessage>("discord.messages", ["snowflake", "channel_snowflake", "guild_snowflake"]),
    reactions: store.collection<DiscordReaction>("discord.reactions", ["message_snowflake", "channel_snowflake"]),
    emojis: store.collection<DiscordEmoji>("discord.emojis", ["snowflake", "guild_snowflake"]),
    commands: store.collection<DiscordApplicationCommand>("discord.commands", [
      "snowflake",
      "application_snowflake",
      "guild_snowflake",
    ]),
    tokens: store.collection<DiscordToken>("discord.tokens", ["token", "user_snowflake", "application_snowflake"]),
    webhooks: store.collection<DiscordWebhook>("discord.webhooks", ["snowflake", "channel_snowflake", "token"]),
    interactions: store.collection<DiscordInteraction>("discord.interactions", [
      "snowflake",
      "token",
      "application_snowflake",
    ]),
    bans: store.collection<DiscordBan>("discord.bans", ["guild_snowflake", "user_snowflake"]),
    auditLog: store.collection<DiscordAuditLogEntry>("discord.audit_log", ["guild_snowflake"]),
    invites: store.collection<DiscordInvite>("discord.invites", ["code", "guild_snowflake", "channel_snowflake"]),
    stickers: store.collection<DiscordSticker>("discord.stickers", ["snowflake", "guild_snowflake"]),
    scheduledEvents: store.collection<DiscordScheduledEvent>("discord.scheduled_events", ["snowflake", "guild_snowflake"]),
    scheduledEventUsers: store.collection<DiscordScheduledEventUser>("discord.scheduled_event_users", [
      "event_snowflake",
      "guild_snowflake",
      "user_snowflake",
    ]),
    threadMembers: store.collection<DiscordThreadMember>("discord.thread_members", ["thread_snowflake", "user_snowflake"]),
    stageInstances: store.collection<DiscordStageInstance>("discord.stage_instances", [
      "snowflake",
      "channel_snowflake",
      "guild_snowflake",
    ]),
    autoModRules: store.collection<DiscordAutoModRule>("discord.automod_rules", ["snowflake", "guild_snowflake"]),
    guildTemplates: store.collection<DiscordGuildTemplate>("discord.guild_templates", ["code", "source_guild_snowflake"]),
    pollVotes: store.collection<DiscordPollVote>("discord.poll_votes", ["message_snowflake", "user_snowflake"]),
    roleConnections: store.collection<DiscordRoleConnection>("discord.role_connections", ["application_snowflake", "user_snowflake"]),
    soundboardSounds: store.collection<DiscordSoundboardSound>("discord.soundboard_sounds", ["snowflake", "guild_snowflake"]),
    gatewaySessions: store.collection<DiscordGatewaySession>("discord.gateway_sessions", ["session_id"]),
    appEmojis: store.collection<DiscordApplicationEmoji>("discord.app_emojis", ["snowflake", "application_snowflake"]),
    commandPermissions: store.collection<DiscordCommandPermissions>("discord.command_permissions", [
      "application_snowflake",
      "guild_snowflake",
      "command_snowflake",
    ]),
    integrations: store.collection<DiscordIntegration>("discord.integrations", ["snowflake", "guild_snowflake"]),
    connections: store.collection<DiscordConnection>("discord.connections", ["user_snowflake", "connection_id"]),
    voiceStates: store.collection<DiscordVoiceState>("discord.voice_states", ["guild_snowflake", "user_snowflake", "channel_snowflake"]),
    skus: store.collection<DiscordSKU>("discord.skus", ["snowflake", "application_snowflake"]),
    entitlements: store.collection<DiscordEntitlement>("discord.entitlements", [
      "snowflake",
      "application_snowflake",
      "user_snowflake",
      "guild_snowflake",
      "sku_snowflake",
    ]),
    subscriptions: store.collection<DiscordSubscription>("discord.subscriptions", ["snowflake", "user_snowflake"]),
    lobbies: store.collection<DiscordLobby>("discord.lobbies", ["snowflake", "application_snowflake"]),
    lobbyMembers: store.collection<DiscordLobbyMember>("discord.lobby_members", ["lobby_snowflake", "user_snowflake"]),
    lobbyMessages: store.collection<DiscordLobbyMessage>("discord.lobby_messages", ["snowflake", "lobby_snowflake"]),
  };
}
