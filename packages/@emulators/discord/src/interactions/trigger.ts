import { randomBytes } from "node:crypto";
import type { DiscordStore } from "../store.js";
import type { DiscordApplication, DiscordInteraction } from "../entities.js";
import { snowflake, toAPIUser, toAPIMember, toAPIChannel, toAPIMessage } from "../helpers.js";

/** Interaction types. */
export const InteractionType = {
  Ping: 1,
  ApplicationCommand: 2,
  MessageComponent: 3,
  ApplicationCommandAutocomplete: 4,
  ModalSubmit: 5,
} as const;

export interface TriggerInput {
  type: number;
  applicationSnowflake?: string;
  channelSnowflake?: string;
  guildSnowflake?: string | null;
  userSnowflake?: string;
  /** For ApplicationCommand: command name. */
  commandName?: string;
  commandOptions?: unknown[];
  /** For MessageComponent / ModalSubmit. */
  customId?: string;
  componentType?: number;
  values?: string[];
  modalComponents?: unknown[];
  /** For MessageComponent: the message the component is on. */
  messageSnowflake?: string;
}

export interface BuiltInteraction {
  record: DiscordInteraction;
  payload: Record<string, unknown>;
  application: DiscordApplication;
}

/** Build (and persist) an interaction object as Discord would when a user triggers it. */
export function buildInteraction(ds: DiscordStore, input: TriggerInput): BuiltInteraction | null {
  const application = input.applicationSnowflake
    ? ds.applications.findOneBy("snowflake", input.applicationSnowflake)
    : ds.applications.all()[0];
  if (!application) return null;

  const channel = input.channelSnowflake
    ? ds.channels.findOneBy("snowflake", input.channelSnowflake)
    : ds.channels.all().find((c) => c.type === 0);
  const guildSnowflake = input.guildSnowflake ?? channel?.guild_snowflake ?? null;
  const user =
    (input.userSnowflake && ds.users.findOneBy("snowflake", input.userSnowflake)) ||
    ds.users.all().find((u) => !u.bot) ||
    ds.users.all()[0];
  if (!user) return null;

  const id = snowflake();
  const token = `disc_int_${randomBytes(24).toString("hex")}`;

  let data: Record<string, unknown> | undefined;
  if (input.type === InteractionType.ApplicationCommand || input.type === InteractionType.ApplicationCommandAutocomplete) {
    const command = input.commandName
      ? ds.commands.all().find((cmd) => cmd.name === input.commandName)
      : undefined;
    data = {
      id: command?.snowflake ?? snowflake(),
      name: input.commandName ?? command?.name ?? "command",
      type: command?.type ?? 1,
      options: input.commandOptions ?? [],
    };
  } else if (input.type === InteractionType.MessageComponent) {
    data = { custom_id: input.customId ?? "", component_type: input.componentType ?? 2 };
    // Select menus carry resolved values; buttons do not.
    if (input.values !== undefined) (data as Record<string, unknown>).values = input.values;
  } else if (input.type === InteractionType.ModalSubmit) {
    data = { custom_id: input.customId ?? "", components: input.modalComponents ?? [] };
  }

  const record = ds.interactions.insert({
    snowflake: id,
    token,
    type: input.type,
    application_snowflake: application.snowflake,
    guild_snowflake: guildSnowflake,
    channel_snowflake: channel?.snowflake ?? null,
    user_snowflake: user.snowflake,
    data,
    message_snowflake: input.messageSnowflake ?? null,
    callback_used: false,
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  });

  const member = guildSnowflake
    ? ds.members.findBy("guild_snowflake", guildSnowflake).find((m) => m.user_snowflake === user.snowflake)
    : undefined;
  const message = input.messageSnowflake ? ds.messages.findOneBy("snowflake", input.messageSnowflake) : undefined;

  const payload: Record<string, unknown> = {
    id,
    application_id: application.snowflake,
    type: input.type,
    token,
    version: 1,
    channel_id: channel?.snowflake,
    channel: channel ? toAPIChannel(channel) : undefined,
    guild_id: guildSnowflake ?? undefined,
    data,
    locale: "en-US",
    app_permissions: "0",
    entitlements: [],
    ...(guildSnowflake
      ? { member: member ? { ...toAPIMember(member, ds), user: toAPIUser(user) } : { user: toAPIUser(user) } }
      : { user: toAPIUser(user) }),
    ...(message ? { message: toAPIMessage(message, ds) } : {}),
  };

  return { record, payload, application };
}
