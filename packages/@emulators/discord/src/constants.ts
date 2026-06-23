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
