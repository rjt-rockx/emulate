/** Discord channel types (mirror of discord-api-types ChannelType, v10). */
export const ChannelType = {
  GuildText: 0,
  DM: 1,
  GuildVoice: 2,
  GroupDM: 3,
  GuildCategory: 4,
  GuildAnnouncement: 5,
  AnnouncementThread: 10,
  PublicThread: 11,
  PrivateThread: 12,
  GuildStageVoice: 13,
  GuildDirectory: 14,
  GuildForum: 15,
  GuildMedia: 16,
} as const;

/** True for the three thread channel types (announcement, public, private). */
export const isThreadType = (type: number): boolean =>
  type === ChannelType.AnnouncementThread ||
  type === ChannelType.PublicThread ||
  type === ChannelType.PrivateThread;

/** True for forum-like parents that hold threads as posts (forum, media). */
export const isForumType = (type: number): boolean =>
  type === ChannelType.GuildForum || type === ChannelType.GuildMedia;

/** True for the two voice channel types (voice, stage). */
export const isVoiceType = (type: number): boolean =>
  type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice;

/** Valid thread `auto_archive_duration` values (minutes), per the Discord docs. */
export const AUTO_ARCHIVE_DURATIONS = new Set([60, 1440, 4320, 10080]);

/** Discord message component types (mirror of discord-api-types ComponentType, v10). */
export const ComponentType = {
  ActionRow: 1,
  Button: 2,
  StringSelect: 3,
  TextInput: 4,
  UserSelect: 5,
  RoleSelect: 6,
  MentionableSelect: 7,
  ChannelSelect: 8,
} as const;

/** True for the five select-menu component types (string, user, role, mentionable, channel). */
export const isSelectType = (type: number): boolean =>
  type === ComponentType.StringSelect ||
  type === ComponentType.UserSelect ||
  type === ComponentType.RoleSelect ||
  type === ComponentType.MentionableSelect ||
  type === ComponentType.ChannelSelect;

/** Button styles (mirror of discord-api-types ButtonStyle, v10). */
export const ButtonStyle = {
  Primary: 1,
  Secondary: 2,
  Success: 3,
  Danger: 4,
  Link: 5,
  Premium: 6,
} as const;
