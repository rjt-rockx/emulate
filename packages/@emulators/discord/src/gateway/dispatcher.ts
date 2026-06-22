/**
 * In-package event bus bridging REST mutations to connected Gateway sockets.
 * REST handlers `publish` domain events; the Gateway server subscribes once and fans
 * each event out to sessions, filtered by intents + guild membership.
 *
 * This lives entirely in the Discord package; core has no knowledge of it.
 */
export interface GatewayEvent {
  /** Dispatch event name, e.g. "MESSAGE_CREATE", "GUILD_CREATE". */
  t: string;
  /** Event payload (already serialized to the Discord wire shape). */
  d: unknown;
  /** Guild scope used for fan-out filtering; null/undefined = not guild-scoped (e.g. DMs). */
  guildId?: string | null;
  /** Intent bitfield gating delivery. 0 = ungated. */
  requiredIntents: number;
  /** When set, only deliver to sessions whose bot belongs to this application (e.g. INTERACTION_CREATE). */
  applicationId?: string;
  /**
   * When set, deliver only to sessions whose bot is this user, bypassing the guild-membership
   * filter. Used for membership transitions: a GUILD_CREATE when a bot is added to a guild
   * mid-session (the session is not yet "in" the guild), or a GUILD_DELETE when it leaves.
   */
  targetUserId?: string;
  /**
   * Optional alternate payload delivered to sessions that lack the MESSAGE_CONTENT
   * intent (used by MESSAGE_CREATE/UPDATE to strip content/embeds/components/attachments).
   * Discord still sends full content to a bot for its own messages, DMs, and messages
   * that mention it, so redaction is decided per-session using the fields below.
   */
  redactedData?: unknown;
  /** Author of the message (a bot always sees content for its own messages). */
  messageAuthorId?: string;
  /** Users mentioned in the message (a bot always sees content when mentioned). */
  messageMentionIds?: string[];
}

export type GatewayEventListener = (event: GatewayEvent) => void;

export class DiscordEventBus {
  private listeners = new Set<GatewayEventListener>();

  publish(event: GatewayEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a misbehaving listener must not break the publisher
      }
    }
  }

  subscribe(listener: GatewayEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.listeners.clear();
  }
}
