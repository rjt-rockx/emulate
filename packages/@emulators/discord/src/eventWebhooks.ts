/**
 * Event Webhooks module.
 *
 * Implements the outgoing webhook-events flow documented at
 * developers/events/webhook-events.mdx.
 *
 * Delivery contract:
 *   POST <event_webhooks_url>
 *   Headers: X-Signature-Ed25519, X-Signature-Timestamp
 *   Body (JSON, type 1 — Event):
 *     { version: 1, application_id, type: 1, event: { type, timestamp, data } }
 *   Body (JSON, type 0 — PING):
 *     { version: 1, application_id, type: 0 }
 *
 * Signatures are produced identically to the interactions endpoint: the private key
 * signs the concatenation of the timestamp string and the raw JSON body bytes.
 *
 * Event webhook status values (Application Event Webhook Status enum):
 *   1 — DISABLED (default)
 *   2 — ENABLED
 *   3 — DISABLED_BY_DISCORD
 */

import type { DiscordRouteContext } from "./context.js";
import { getDiscordStore } from "./store.js";
import { getAuth, unauthorized } from "./helpers.js";
import { signInteraction } from "./interactions/ed25519.js";

/** Application Event Webhook Status numeric values. */
export const EventWebhookStatus = {
  DISABLED: 1,
  ENABLED: 2,
  DISABLED_BY_DISCORD: 3,
} as const;

/** Webhook type values: 0 = PING, 1 = Event. */
export const WebhookType = {
  PING: 0,
  EVENT: 1,
} as const;

/** All recognised event type strings (webhook-events.mdx — Event Types). */
export const WebhookEventType = {
  APPLICATION_AUTHORIZED: "APPLICATION_AUTHORIZED",
  APPLICATION_DEAUTHORIZED: "APPLICATION_DEAUTHORIZED",
  ENTITLEMENT_CREATE: "ENTITLEMENT_CREATE",
  ENTITLEMENT_UPDATE: "ENTITLEMENT_UPDATE",
  ENTITLEMENT_DELETE: "ENTITLEMENT_DELETE",
  QUEST_USER_ENROLLMENT: "QUEST_USER_ENROLLMENT",
  LOBBY_MESSAGE_CREATE: "LOBBY_MESSAGE_CREATE",
  LOBBY_MESSAGE_UPDATE: "LOBBY_MESSAGE_UPDATE",
  LOBBY_MESSAGE_DELETE: "LOBBY_MESSAGE_DELETE",
  GAME_DIRECT_MESSAGE_CREATE: "GAME_DIRECT_MESSAGE_CREATE",
  GAME_DIRECT_MESSAGE_UPDATE: "GAME_DIRECT_MESSAGE_UPDATE",
  GAME_DIRECT_MESSAGE_DELETE: "GAME_DIRECT_MESSAGE_DELETE",
} as const;

export type WebhookEventTypeValue = (typeof WebhookEventType)[keyof typeof WebhookEventType];

/** Outer webhook payload (type 1 — Event). */
export interface WebhookEventPayload {
  version: 1;
  application_id: string;
  type: 1;
  event: {
    type: string;
    timestamp: string;
    data?: unknown;
  };
}

/** Outer webhook payload (type 0 — PING). */
export interface WebhookPingPayload {
  version: 1;
  application_id: string;
  type: 0;
}

/** Key used in the store side-channel for ApplicationExtras (mirrors applicationManagement.ts). */
const APP_EXTRAS_KEY = (appSnowflake: string): string => `discord.application_extras.${appSnowflake}`;

interface ApplicationExtras {
  event_webhooks_url?: string | null;
  event_webhooks_status?: number;
  event_webhooks_types?: string[];
}

function getApplicationExtras(appSnowflake: string, store: DiscordRouteContext["store"]): ApplicationExtras {
  return store.getData<ApplicationExtras>(APP_EXTRAS_KEY(appSnowflake)) ?? {};
}

/**
 * Deliver a signed PING payload (type 0) to the given URL.
 * Returns true if the endpoint acknowledged with 204, false otherwise.
 * Network errors are swallowed and return false.
 */
export async function sendPing(url: string, applicationId: string, privateKeyPem: string): Promise<boolean> {
  const payload: WebhookPingPayload = {
    version: 1,
    application_id: applicationId,
    type: WebhookType.PING,
  };
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signInteraction(timestamp, body, privateKeyPem);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature-Ed25519": signature,
        "X-Signature-Timestamp": timestamp,
      },
      body,
    });
    return res.status === 204;
  } catch {
    return false;
  }
}

/**
 * Deliver a signed event webhook (type 1) to the configured URL for an application.
 *
 * Delivery is skipped (silently) when:
 * - the application has no event_webhooks_url, or
 * - event_webhooks_status is not ENABLED (2), or
 * - event_webhooks_types does not include the supplied event type.
 *
 * On success (remote 204) the promise resolves. Network errors are swallowed.
 */
export async function dispatchEventWebhook(
  store: DiscordRouteContext["store"],
  applicationSnowflake: string,
  privateKeyPem: string,
  eventType: string,
  data: unknown,
  timestamp?: string,
): Promise<void> {
  const extras = getApplicationExtras(applicationSnowflake, store);
  const url = extras.event_webhooks_url;
  if (!url) return;
  if (extras.event_webhooks_status !== EventWebhookStatus.ENABLED) return;
  const subscribedTypes = extras.event_webhooks_types ?? [];
  if (!subscribedTypes.includes(eventType)) return;

  const eventTimestamp = timestamp ?? new Date().toISOString();
  const payload: WebhookEventPayload = {
    version: 1,
    application_id: applicationSnowflake,
    type: WebhookType.EVENT,
    event: {
      type: eventType,
      timestamp: eventTimestamp,
      data,
    },
  };
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000).toString();
  const signature = signInteraction(ts, body, privateKeyPem);
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature-Ed25519": signature,
        "X-Signature-Timestamp": ts,
      },
      body,
    });
  } catch {
    // Fire-and-forget; silently discard network errors.
  }
}

/**
 * Register the emulator control route for triggering event webhooks manually.
 *
 * POST /__emulate/event-webhook
 * Authorization: Bot <token>
 * Body: { type: string, data?: unknown }
 *
 * Triggers delivery of a signed event webhook to the configured URL.
 * Returns { delivered: true } when the delivery attempt was made (i.e. the app
 * has an enabled URL subscribed to this event type), { delivered: false } otherwise.
 */
export function eventWebhookRoutes(ctx: DiscordRouteContext): void {
  const { app, store } = ctx;

  app.post("/__emulate/event-webhook", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);

    const ds = getDiscordStore(store);
    const appRecord = auth.application ?? ds.applications.all()[0];
    if (!appRecord) return unauthorized(c);

    const body = (await c.req.json().catch(() => ({}))) as { type?: string; data?: unknown; timestamp?: string };
    const eventType = body.type;
    if (typeof eventType !== "string" || eventType.length === 0) {
      return c.json({ error: "type is required" }, 400);
    }

    const extras = getApplicationExtras(appRecord.snowflake, store);
    const url = extras.event_webhooks_url;
    const status = extras.event_webhooks_status;
    const subscribedTypes = extras.event_webhooks_types ?? [];

    const shouldDeliver =
      typeof url === "string" &&
      url.length > 0 &&
      status === EventWebhookStatus.ENABLED &&
      subscribedTypes.includes(eventType);

    if (!shouldDeliver) {
      return c.json({ delivered: false });
    }

    await dispatchEventWebhook(store, appRecord.snowflake, appRecord.private_key, eventType, body.data ?? null, body.timestamp);
    return c.json({ delivered: true });
  });
}
