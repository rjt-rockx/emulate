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
  DiscordInvite,
  DiscordSticker,
  DiscordScheduledEvent,
  DiscordThreadMember,
  DiscordStageInstance,
  DiscordAutoModRule,
  DiscordGuildTemplate,
  DiscordPollVote,
  DiscordGatewaySession,
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
  invites: Collection<DiscordInvite>;
  stickers: Collection<DiscordSticker>;
  scheduledEvents: Collection<DiscordScheduledEvent>;
  threadMembers: Collection<DiscordThreadMember>;
  stageInstances: Collection<DiscordStageInstance>;
  autoModRules: Collection<DiscordAutoModRule>;
  guildTemplates: Collection<DiscordGuildTemplate>;
  pollVotes: Collection<DiscordPollVote>;
  gatewaySessions: Collection<DiscordGatewaySession>;
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
    invites: store.collection<DiscordInvite>("discord.invites", ["code", "guild_snowflake", "channel_snowflake"]),
    stickers: store.collection<DiscordSticker>("discord.stickers", ["snowflake", "guild_snowflake"]),
    scheduledEvents: store.collection<DiscordScheduledEvent>("discord.scheduled_events", ["snowflake", "guild_snowflake"]),
    threadMembers: store.collection<DiscordThreadMember>("discord.thread_members", ["thread_snowflake", "user_snowflake"]),
    stageInstances: store.collection<DiscordStageInstance>("discord.stage_instances", ["snowflake", "channel_snowflake"]),
    autoModRules: store.collection<DiscordAutoModRule>("discord.automod_rules", ["snowflake", "guild_snowflake"]),
    guildTemplates: store.collection<DiscordGuildTemplate>("discord.guild_templates", ["code", "source_guild_snowflake"]),
    pollVotes: store.collection<DiscordPollVote>("discord.poll_votes", ["message_snowflake", "user_snowflake"]),
    gatewaySessions: store.collection<DiscordGatewaySession>("discord.gateway_sessions", ["session_id"]),
  };
}
