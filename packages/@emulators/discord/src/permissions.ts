import type { DiscordStore } from "./store.js";

/** Discord permission bit flags (BigInt). */
export const PermissionFlags = {
  CreateInstantInvite: 1n << 0n,
  KickMembers: 1n << 1n,
  BanMembers: 1n << 2n,
  Administrator: 1n << 3n,
  ManageChannels: 1n << 4n,
  ManageGuild: 1n << 5n,
  AddReactions: 1n << 6n,
  ViewAuditLog: 1n << 7n,
  PrioritySpeaker: 1n << 8n,
  Stream: 1n << 9n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  SendTtsMessages: 1n << 12n,
  ManageMessages: 1n << 13n,
  EmbedLinks: 1n << 14n,
  AttachFiles: 1n << 15n,
  ReadMessageHistory: 1n << 16n,
  MentionEveryone: 1n << 17n,
  UseExternalEmojis: 1n << 18n,
  ViewGuildInsights: 1n << 19n,
  Connect: 1n << 20n,
  Speak: 1n << 21n,
  MuteMembers: 1n << 22n,
  DeafenMembers: 1n << 23n,
  MoveMembers: 1n << 24n,
  UseVad: 1n << 25n,
  ChangeNickname: 1n << 26n,
  ManageNicknames: 1n << 27n,
  ManageRoles: 1n << 28n,
  ManageWebhooks: 1n << 29n,
  ManageGuildExpressions: 1n << 30n,
  UseApplicationCommands: 1n << 31n,
  RequestToSpeak: 1n << 32n,
  ManageEvents: 1n << 33n,
  ManageThreads: 1n << 34n,
  CreatePublicThreads: 1n << 35n,
  CreatePrivateThreads: 1n << 36n,
  UseExternalStickers: 1n << 37n,
  SendMessagesInThreads: 1n << 38n,
  UseEmbeddedActivities: 1n << 39n,
  ModerateMembers: 1n << 40n,
  ViewCreatorMonetizationAnalytics: 1n << 41n,
  UseSoundboard: 1n << 42n,
  CreateGuildExpressions: 1n << 43n,
  CreateEvents: 1n << 44n,
  UseExternalSounds: 1n << 45n,
  SendVoiceMessages: 1n << 46n,
  // bit 47 is reserved/unassigned in the Discord documentation
  SetVoiceChannelStatus: 1n << 48n,
  SendPolls: 1n << 49n,
  UseExternalApps: 1n << 50n,
  PinMessages: 1n << 51n,
  BypassSlowmode: 1n << 52n,
} as const;

const ALL = Object.values(PermissionFlags).reduce((acc, bit) => acc | bit, 0n);

function parse(value: string | null | undefined): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/**
 * Compute a member's effective permissions in a channel, following Discord's algorithm:
 * guild owner and ADMINISTRATOR short-circuit to all permissions; otherwise base role
 * permissions are combined, then channel overwrites are applied in order (@everyone, then
 * the union of the member's role overwrites, then the member-specific overwrite).
 */
export function computePermissions(ds: DiscordStore, userSnowflake: string, channelSnowflake: string): bigint {
  const channel = ds.channels.findOneBy("snowflake", channelSnowflake);
  if (!channel || !channel.guild_snowflake) return ALL; // DMs: everything allowed
  const guild = ds.guilds.findOneBy("snowflake", channel.guild_snowflake);
  if (!guild) return 0n;
  if (guild.owner_snowflake === userSnowflake) return ALL;

  const member = ds.members.findBy("guild_snowflake", guild.snowflake).find((m) => m.user_snowflake === userSnowflake);
  const everyoneRole = ds.roles.findOneBy("snowflake", guild.snowflake); // @everyone role id == guild id
  let base = parse(everyoneRole?.permissions);
  const memberRoleIds = new Set(member?.role_snowflakes ?? []);
  for (const role of ds.roles.findBy("guild_snowflake", guild.snowflake)) {
    if (memberRoleIds.has(role.snowflake)) base |= parse(role.permissions);
  }
  if (base & PermissionFlags.Administrator) return ALL;

  const overwrites = channel.permission_overwrites;
  const everyoneOw = overwrites.find((o) => o.id === guild.snowflake);
  if (everyoneOw) base = (base & ~parse(everyoneOw.deny)) | parse(everyoneOw.allow);

  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const ow of overwrites) {
    if (ow.type === 0 && memberRoleIds.has(ow.id)) {
      roleAllow |= parse(ow.allow);
      roleDeny |= parse(ow.deny);
    }
  }
  base = (base & ~roleDeny) | roleAllow;

  const memberOw = overwrites.find((o) => o.type === 1 && o.id === userSnowflake);
  if (memberOw) base = (base & ~parse(memberOw.deny)) | parse(memberOw.allow);

  return base;
}

/**
 * Compute a member's guild-level permissions (no channel overwrites), for guild-wide actions
 * like kick/ban/manage-guild. Owner and ADMINISTRATOR short-circuit to all permissions.
 */
export function computeGuildPermissions(ds: DiscordStore, userSnowflake: string, guildSnowflake: string): bigint {
  const guild = ds.guilds.findOneBy("snowflake", guildSnowflake);
  if (!guild) return 0n;
  if (guild.owner_snowflake === userSnowflake) return ALL;
  const member = ds.members.findBy("guild_snowflake", guildSnowflake).find((m) => m.user_snowflake === userSnowflake);
  const everyoneRole = ds.roles.findOneBy("snowflake", guildSnowflake);
  let base = parse(everyoneRole?.permissions);
  const memberRoleIds = new Set(member?.role_snowflakes ?? []);
  for (const role of ds.roles.findBy("guild_snowflake", guildSnowflake)) {
    if (memberRoleIds.has(role.snowflake)) base |= parse(role.permissions);
  }
  return base & PermissionFlags.Administrator ? ALL : base;
}

export function hasPermission(perms: bigint, flag: bigint): boolean {
  return (perms & PermissionFlags.Administrator) === PermissionFlags.Administrator || (perms & flag) === flag;
}

export const ALL_PERMISSIONS = ALL;
