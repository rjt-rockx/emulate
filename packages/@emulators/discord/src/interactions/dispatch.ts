import type { DiscordStore } from "../store.js";
import type { DiscordApplication, DiscordInteraction, DiscordPoll } from "../entities.js";
import type { DiscordEventBus } from "../gateway/dispatcher.js";
import { Intents } from "../gateway/intents.js";
import { toAPIMessage, redactMessageContent, isEphemeral, MessageFlags } from "../helpers.js";
import { createMessage } from "../factories.js";
import { signInteraction } from "./ed25519.js";

/** Interaction response (callback) types. */
export const InteractionResponseType = {
  Pong: 1,
  ChannelMessageWithSource: 4,
  DeferredChannelMessageWithSource: 5,
  DeferredMessageUpdate: 6,
  UpdateMessage: 7,
  ApplicationCommandAutocompleteResult: 8,
  Modal: 9,
  PremiumRequired: 10,
  LaunchActivity: 12,
} as const;

/**
 * Flags that clients are allowed to set on an interaction response. Any other flag is rejected.
 * Settable: EPHEMERAL (64), SUPPRESS_EMBEDS (4), SUPPRESS_NOTIFICATIONS (1<<12), IS_COMPONENTS_V2 (1<<15).
 */
const INTERACTION_RESPONSE_SETTABLE_FLAGS =
  MessageFlags.Ephemeral |
  MessageFlags.SuppressEmbeds |
  MessageFlags.SuppressNotifications |
  MessageFlags.IsComponentsV2;

/** Return true if `flags` contains any bit that clients are NOT allowed to set. */
export function hasInvalidResponseFlags(flags: number): boolean {
  return (flags & ~INTERACTION_RESPONSE_SETTABLE_FLAGS) !== 0;
}

export interface InteractionResponse {
  type: number;
  data?: {
    content?: string;
    embeds?: unknown[];
    components?: unknown[];
    flags?: number;
    tts?: boolean;
    choices?: unknown[];
    attachments?: unknown[];
    poll?: unknown;
    [k: string]: unknown;
  };
}

const ORIGINALS_KEY = "discord.interaction.originals";

function originals(store: { getData<V>(k: string): V | undefined; setData<V>(k: string, v: V): void }): Map<string, string> {
  let map = store.getData<Map<string, string>>(ORIGINALS_KEY);
  if (!map) {
    map = new Map();
    store.setData(ORIGINALS_KEY, map);
  }
  return map;
}

/** Record the message that is the original response for an interaction token. */
export function setOriginalResponse(
  store: { getData<V>(k: string): V | undefined; setData<V>(k: string, v: V): void },
  token: string,
  messageSnowflake: string,
): void {
  originals(store).set(token, messageSnowflake);
}

export function getOriginalResponse(
  store: { getData<V>(k: string): V | undefined; setData<V>(k: string, v: V): void },
  token: string,
): string | undefined {
  return originals(store).get(token);
}

export interface ApplyResult {
  /** The message created/updated by this response, if any. */
  message?: { snowflake: string; flags: number } | null;
  /** True when the callback was a DEFERRED type (loading state). */
  isDeferred?: boolean;
  /** True when the callback was a LAUNCH_ACTIVITY type. */
  isLaunchActivity?: boolean;
}

/**
 * Apply an interaction response: for message responses, create/update the message in the
 * interaction's channel (authored by the bot) and dispatch MESSAGE_CREATE/UPDATE.
 */
export function applyInteractionResponse(
  ds: DiscordStore,
  bus: DiscordEventBus,
  store: { getData<V>(k: string): V | undefined; setData<V>(k: string, v: V): void },
  interaction: DiscordInteraction,
  response: InteractionResponse,
): ApplyResult {
  const application = ds.applications.findOneBy("snowflake", interaction.application_snowflake);
  const botSnowflake = application?.bot_user_snowflake;
  if (!botSnowflake) {
    ds.interactions.update(interaction.id, { callback_used: true });
    return {};
  }

  if (
    response.type === InteractionResponseType.ChannelMessageWithSource &&
    interaction.channel_snowflake
  ) {
    const data = response.data ?? {};
    const flags = typeof data.flags === "number" ? data.flags : 0;
    const message = createMessage(ds, {
      channelSnowflake: interaction.channel_snowflake,
      guildSnowflake: interaction.guild_snowflake,
      authorSnowflake: botSnowflake,
      content: typeof data.content === "string" ? data.content : "",
      embeds: (data.embeds as unknown[]) ?? [],
      components: (data.components as unknown[]) ?? [],
      attachments: (data.attachments as unknown[]) ?? [],
      poll: (data.poll as DiscordPoll | null | undefined) ?? undefined,
      flags,
      type: 20, // CHAT_INPUT_COMMAND reply
    });
    setOriginalResponse(store, interaction.token, message.snowflake);
    // Ephemeral responses are visible only to the invoking user: they are retrievable via
    // the interaction token (@original) but never broadcast to gateway listeners.
    if (!isEphemeral(flags)) {
      const payload = toAPIMessage(message, ds);
      bus.publish({
        t: "MESSAGE_CREATE",
        guildId: interaction.guild_snowflake,
        requiredIntents: interaction.guild_snowflake ? Intents.GuildMessages : Intents.DirectMessages,
        d: payload,
        redactedData: redactMessageContent(payload),
        messageAuthorId: botSnowflake,
      });
    }
    ds.interactions.update(interaction.id, { callback_used: true });
    return { message: { snowflake: message.snowflake, flags: message.flags } };
  } else if (
    response.type === InteractionResponseType.DeferredChannelMessageWithSource &&
    interaction.channel_snowflake
  ) {
    // Create a "thinking" placeholder message so @original resolves immediately.
    const data = response.data ?? {};
    const flags = (typeof data.flags === "number" ? data.flags : 0) | MessageFlags.Loading;
    const message = createMessage(ds, {
      channelSnowflake: interaction.channel_snowflake,
      guildSnowflake: interaction.guild_snowflake,
      authorSnowflake: botSnowflake,
      content: "",
      embeds: [],
      components: [],
      attachments: [],
      flags,
      type: 20,
    });
    setOriginalResponse(store, interaction.token, message.snowflake);
    if (!isEphemeral(flags)) {
      const payload = toAPIMessage(message, ds);
      bus.publish({
        t: "MESSAGE_CREATE",
        guildId: interaction.guild_snowflake,
        requiredIntents: interaction.guild_snowflake ? Intents.GuildMessages : Intents.DirectMessages,
        d: payload,
        redactedData: redactMessageContent(payload),
        messageAuthorId: botSnowflake,
      });
    }
    ds.interactions.update(interaction.id, { callback_used: true });
    return { message: { snowflake: message.snowflake, flags: message.flags }, isDeferred: true };
  } else if (response.type === InteractionResponseType.UpdateMessage && interaction.message_snowflake) {
    const target = ds.messages.findOneBy("snowflake", interaction.message_snowflake);
    if (target) {
      const data = response.data ?? {};
      const patch: Record<string, unknown> = { edited_timestamp: new Date().toISOString() };
      if (typeof data.content === "string") patch.content = data.content;
      if (data.components !== undefined) patch.components = data.components;
      if (data.embeds !== undefined) patch.embeds = data.embeds;
      ds.messages.update(target.id, patch);
      const updated = ds.messages.findOneBy("snowflake", target.snowflake)!;
      const payload = toAPIMessage(updated, ds);
      bus.publish({
        t: "MESSAGE_UPDATE",
        guildId: updated.guild_snowflake,
        requiredIntents: updated.guild_snowflake ? Intents.GuildMessages : Intents.DirectMessages,
        d: payload,
        redactedData: redactMessageContent(payload),
        messageAuthorId: updated.author_snowflake,
      });
    }
    ds.interactions.update(interaction.id, { callback_used: true });
    return {};
  }

  // Deferred update (type 6) — ACK for a component, edits original later, no loading state.
  if (response.type === InteractionResponseType.DeferredMessageUpdate) {
    ds.interactions.update(interaction.id, { callback_used: true });
    return { isDeferred: true };
  }

  // LAUNCH_ACTIVITY (type 12) — no message, but signals an activity was launched.
  if (response.type === InteractionResponseType.LaunchActivity) {
    ds.interactions.update(interaction.id, { callback_used: true });
    return { isLaunchActivity: true };
  }

  // Pong / autocomplete / modal / premium — no immediate message mutation.
  ds.interactions.update(interaction.id, { callback_used: true });
  return {};
}

/**
 * Route an interaction to the app: always dispatch INTERACTION_CREATE over the Gateway, and
 * (if configured) deliver an Ed25519-signed POST to the app's HTTP interactions endpoint.
 * Returns the app's HTTP response body when the HTTP path is used.
 */
export async function routeInteraction(
  bus: DiscordEventBus,
  application: DiscordApplication,
  payload: Record<string, unknown>,
): Promise<{ httpResponse?: InteractionResponse | null; delivered: "gateway" | "http" }> {
  // Discord delivers an interaction EITHER over the configured HTTP endpoint OR the Gateway,
  // never both. An app with an interactions_endpoint_url receives the signed HTTP POST only.
  if (application.interactions_endpoint_url) {
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signInteraction(timestamp, body, application.private_key);
    try {
      const res = await fetch(application.interactions_endpoint_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature-Ed25519": signature,
          "X-Signature-Timestamp": timestamp,
        },
        body,
      });
      const httpResponse = (await res.json().catch(() => null)) as InteractionResponse | null;
      return { httpResponse, delivered: "http" };
    } catch {
      return { delivered: "http" };
    }
  }

  bus.publish({
    t: "INTERACTION_CREATE",
    d: payload,
    guildId: (payload.guild_id as string | undefined) ?? null,
    requiredIntents: 0,
    applicationId: application.snowflake,
  });
  return { delivered: "gateway" };
}
