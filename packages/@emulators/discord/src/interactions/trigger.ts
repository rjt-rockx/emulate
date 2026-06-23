import { randomBytes } from "node:crypto";
import type { DiscordStore } from "../store.js";
import type { DiscordApplication, DiscordInteraction } from "../entities.js";
import { snowflake, toAPIUser, toAPIMember, toAPIChannel, toAPIMessage, toAPIRole } from "../helpers.js";
import { ALL_PERMISSIONS, computePermissions, computeGuildPermissions } from "../permissions.js";

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
  /** For USER (type 2) / MESSAGE (type 3) context-menu commands: the targeted entity. */
  targetSnowflake?: string;
}

/**
 * Build the `resolved` object for an interaction: hydrate the entities referenced by a
 * context-menu target and by USER/CHANNEL/ROLE/MENTIONABLE command options, exactly as
 * Discord does so the receiving app does not have to re-fetch them.
 */
function buildResolved(
  ds: DiscordStore,
  guildSnowflake: string | null,
  options: unknown[] | undefined,
  targetSnowflake: string | undefined,
  commandType: number,
): Record<string, Record<string, unknown>> | undefined {
  const resolved: Record<string, Record<string, unknown>> = { users: {}, members: {}, roles: {}, channels: {}, messages: {} };
  const addUser = (uid: string): void => {
    const u = ds.users.findOneBy("snowflake", uid);
    if (!u) return;
    resolved.users[uid] = toAPIUser(u);
    if (guildSnowflake) {
      const m = ds.members.findBy("guild_snowflake", guildSnowflake).find((x) => x.user_snowflake === uid);
      if (m) resolved.members[uid] = toAPIMember(m, ds, { withUser: false });
    }
  };

  if (targetSnowflake) {
    if (commandType === 2) addUser(targetSnowflake);
    else if (commandType === 3) {
      const msg = ds.messages.findOneBy("snowflake", targetSnowflake);
      if (msg) resolved.messages[targetSnowflake] = toAPIMessage(msg, ds);
    }
  }

  for (const opt of (options ?? []) as Array<{ type?: number; value?: unknown }>) {
    if (!opt || typeof opt.value !== "string") continue;
    if (opt.type === 6) addUser(opt.value);
    else if (opt.type === 7) {
      const ch = ds.channels.findOneBy("snowflake", opt.value);
      if (ch) resolved.channels[opt.value] = toAPIChannel(ch, ds);
    } else if (opt.type === 8) {
      const r = ds.roles.findOneBy("snowflake", opt.value);
      if (r) resolved.roles[opt.value] = toAPIRole(r);
    } else if (opt.type === 9) {
      addUser(opt.value);
      const r = ds.roles.findOneBy("snowflake", opt.value);
      if (r) resolved.roles[opt.value] = toAPIRole(r);
    }
  }

  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(resolved)) if (Object.keys(v).length > 0) out[k] = v;
  return Object.keys(out).length > 0 ? out : undefined;
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
  const guild = guildSnowflake ? ds.guilds.findOneBy("snowflake", guildSnowflake) : null;
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
    const commandType = command?.type ?? 1;
    data = {
      id: command?.snowflake ?? snowflake(),
      name: input.commandName ?? command?.name ?? "command",
      type: commandType,
      options: input.commandOptions ?? [],
    };
    if (input.targetSnowflake) data.target_id = input.targetSnowflake;
    const resolved = buildResolved(ds, guildSnowflake, input.commandOptions, input.targetSnowflake, commandType);
    if (resolved) data.resolved = resolved;
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
  // Real Discord resolves the invoking member's permissions on every guild interaction (channel-level
  // when a channel is in context). discord.py's `has_permissions` checks read ONLY this field — without
  // it, every permission-gated command is rejected, even for the guild owner.
  const memberPermissions = guildSnowflake
    ? (channel ? computePermissions(ds, user.snowflake, channel.snowflake) : computeGuildPermissions(ds, user.snowflake, guildSnowflake)).toString()
    : undefined;
  const message = input.messageSnowflake ? ds.messages.findOneBy("snowflake", input.messageSnowflake) : undefined;

  const payload: Record<string, unknown> = {
    id,
    application_id: application.snowflake,
    type: input.type,
    token,
    version: 1,
    channel_id: channel?.snowflake,
    channel: channel ? toAPIChannel(channel, ds) : undefined,
    guild_id: guildSnowflake ?? undefined,
    // Partial guild ({ id, locale, features }) — real Discord includes it on guild interactions, and
    // JDA resolves the guild from it (falling back to a channel-type switch that rejects TEXT, and
    // throwing, when it is absent).
    ...(guildSnowflake && guild
      ? { guild: { id: guildSnowflake, locale: guild.preferred_locale ?? "en-US", features: guild.features ?? [] } }
      : {}),
    data,
    locale: "en-US",
    app_permissions: ALL_PERMISSIONS.toString(),
    entitlements: [],
    // GUILD context (0) when in a guild, otherwise a bot DM (1).
    context: guildSnowflake ? 0 : 1,
    // Guild install (integration type "0") owner is the guild; user install ("1") is the user.
    authorizing_integration_owners: guildSnowflake ? { "0": guildSnowflake } : { "1": user.snowflake },
    attachment_size_limit: 26_214_400,
    ...(guildSnowflake ? { guild_locale: "en-US" } : {}),
    ...(guildSnowflake
      ? { member: member ? { ...toAPIMember(member, ds), user: toAPIUser(user), permissions: memberPermissions } : { user: toAPIUser(user) } }
      : { user: toAPIUser(user) }),
    ...(message ? { message: toAPIMessage(message, ds) } : {}),
  };

  return { record, payload, application };
}
