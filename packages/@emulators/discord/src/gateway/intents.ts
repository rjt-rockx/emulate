/** Gateway intent bits (mirror of discord-api-types GatewayIntentBits, v10). */
export const Intents = {
  Guilds: 1 << 0,
  GuildMembers: 1 << 1, // privileged
  GuildModeration: 1 << 2,
  GuildExpressions: 1 << 3,
  GuildIntegrations: 1 << 4,
  GuildWebhooks: 1 << 5,
  GuildInvites: 1 << 6,
  GuildVoiceStates: 1 << 7,
  GuildPresences: 1 << 8, // privileged
  GuildMessages: 1 << 9,
  GuildMessageReactions: 1 << 10,
  GuildMessageTyping: 1 << 11,
  DirectMessages: 1 << 12,
  DirectMessageReactions: 1 << 13,
  DirectMessageTyping: 1 << 14,
  MessageContent: 1 << 15, // privileged
  GuildScheduledEvents: 1 << 16,
  AutoModerationConfiguration: 1 << 20,
  AutoModerationExecution: 1 << 21,
  GuildMessagePolls: 1 << 24,
  DirectMessagePolls: 1 << 25,
} as const;

/** Intents that require dev-portal approval on real Discord. */
export const PRIVILEGED_INTENTS = Intents.GuildMembers | Intents.GuildPresences | Intents.MessageContent;

export function hasIntent(bitfield: number, intent: number): boolean {
  return (bitfield & intent) !== 0;
}

/** True when a session subscribed with `bitfield` should receive an event needing `required`. */
export function intentsAllow(bitfield: number, required: number): boolean {
  // required === 0 means the event is not gated by any intent.
  return required === 0 || (bitfield & required) !== 0;
}
