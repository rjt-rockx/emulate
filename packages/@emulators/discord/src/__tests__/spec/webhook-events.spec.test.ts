/**
 * Spec suite for developers/events/webhook-events.mdx.
 *
 * Encodes the documented contract for outgoing application event webhooks:
 * - Payload structure (version, application_id, type, event body)
 * - Webhook Types enum: PING (0) and Event (1)
 * - Event Types enum values (APPLICATION_AUTHORIZED, APPLICATION_DEAUTHORIZED, etc.)
 * - Ed25519 signature headers (X-Signature-Ed25519, X-Signature-Timestamp)
 * - Signature verification using the app public key over timestamp + rawBody
 * - Delivery gating: only fires when status = ENABLED (2) and event type is subscribed
 * - PING handshake via the sendPing helper
 * - Control endpoint POST /__emulate/event-webhook
 *
 * The test stands up a real local HTTP server (capturing server) to receive the
 * signed POSTs, mirroring the pattern used in the interactions HTTP endpoint tests.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createDiscordTestApp, api, botHeaders, startDiscordTestEmulator, json } from "../helpers.js";
import { getDiscordStore } from "../../store.js";
import { verifyInteraction } from "../../interactions/ed25519.js";
import {
  EventWebhookStatus,
  WebhookType,
  WebhookEventType,
} from "../../eventWebhooks.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Captured HTTP request from the remote capturing server. */
interface CapturedRequest {
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: unknown;
}

/**
 * Start a minimal HTTP server that collects incoming POSTs and always
 * responds 204. Returns the server, its base URL, and a drain() function
 * that resolves with the next captured request (or rejects on timeout).
 */
async function startCapturingServer(): Promise<{
  server: Server;
  url: string;
  next(timeoutMs?: number): Promise<CapturedRequest>;
  close(): Promise<void>;
}> {
  const captured: CapturedRequest[] = [];
  const waiters: Array<(r: CapturedRequest) => void> = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      let json: unknown = null;
      try {
        json = JSON.parse(body);
      } catch {
        // not JSON — leave null
      }
      const entry: CapturedRequest = {
        headers: req.headers as Record<string, string | string[] | undefined>,
        body,
        json,
      };
      const waiter = waiters.shift();
      if (waiter) {
        waiter(entry);
      } else {
        captured.push(entry);
      }
      res.writeHead(204);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;

  function next(timeoutMs = 3000): Promise<CapturedRequest> {
    if (captured.length > 0) return Promise.resolve(captured.shift()!);
    return new Promise<CapturedRequest>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(resolve);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new Error("Timed out waiting for a captured webhook request"));
      }, timeoutMs);
      waiters.push((r) => {
        clearTimeout(timer);
        resolve(r);
      });
    });
  }

  function close(): Promise<void> {
    return new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }

  return { server, url, next, close };
}

// ---------------------------------------------------------------------------
// Enum value tests (no network needed)
// ---------------------------------------------------------------------------

describe("webhook-events.mdx — EventWebhookStatus enum values", () => {
  it("DISABLED is 1 (default)", () => {
    expect(EventWebhookStatus.DISABLED).toBe(1);
  });

  it("ENABLED is 2", () => {
    expect(EventWebhookStatus.ENABLED).toBe(2);
  });

  it("DISABLED_BY_DISCORD is 3", () => {
    expect(EventWebhookStatus.DISABLED_BY_DISCORD).toBe(3);
  });
});

describe("webhook-events.mdx — WebhookType enum values", () => {
  it("PING is 0", () => {
    expect(WebhookType.PING).toBe(0);
  });

  it("Event is 1", () => {
    expect(WebhookType.EVENT).toBe(1);
  });
});

describe("webhook-events.mdx — WebhookEventType enum values", () => {
  it("APPLICATION_AUTHORIZED value string", () => {
    expect(WebhookEventType.APPLICATION_AUTHORIZED).toBe("APPLICATION_AUTHORIZED");
  });

  it("APPLICATION_DEAUTHORIZED value string", () => {
    expect(WebhookEventType.APPLICATION_DEAUTHORIZED).toBe("APPLICATION_DEAUTHORIZED");
  });

  it("ENTITLEMENT_CREATE value string", () => {
    expect(WebhookEventType.ENTITLEMENT_CREATE).toBe("ENTITLEMENT_CREATE");
  });

  it("ENTITLEMENT_UPDATE value string", () => {
    expect(WebhookEventType.ENTITLEMENT_UPDATE).toBe("ENTITLEMENT_UPDATE");
  });

  it("ENTITLEMENT_DELETE value string", () => {
    expect(WebhookEventType.ENTITLEMENT_DELETE).toBe("ENTITLEMENT_DELETE");
  });

  it("QUEST_USER_ENROLLMENT value string", () => {
    expect(WebhookEventType.QUEST_USER_ENROLLMENT).toBe("QUEST_USER_ENROLLMENT");
  });

  it("LOBBY_MESSAGE_CREATE value string", () => {
    expect(WebhookEventType.LOBBY_MESSAGE_CREATE).toBe("LOBBY_MESSAGE_CREATE");
  });

  it("LOBBY_MESSAGE_UPDATE value string", () => {
    expect(WebhookEventType.LOBBY_MESSAGE_UPDATE).toBe("LOBBY_MESSAGE_UPDATE");
  });

  it("LOBBY_MESSAGE_DELETE value string", () => {
    expect(WebhookEventType.LOBBY_MESSAGE_DELETE).toBe("LOBBY_MESSAGE_DELETE");
  });

  it("GAME_DIRECT_MESSAGE_CREATE value string", () => {
    expect(WebhookEventType.GAME_DIRECT_MESSAGE_CREATE).toBe("GAME_DIRECT_MESSAGE_CREATE");
  });

  it("GAME_DIRECT_MESSAGE_UPDATE value string", () => {
    expect(WebhookEventType.GAME_DIRECT_MESSAGE_UPDATE).toBe("GAME_DIRECT_MESSAGE_UPDATE");
  });

  it("GAME_DIRECT_MESSAGE_DELETE value string", () => {
    expect(WebhookEventType.GAME_DIRECT_MESSAGE_DELETE).toBe("GAME_DIRECT_MESSAGE_DELETE");
  });
});

// ---------------------------------------------------------------------------
// Payload structure tests (via control endpoint + capturing server)
// ---------------------------------------------------------------------------

describe("webhook-events.mdx — Payload structure (outer)", () => {
  let capture: Awaited<ReturnType<typeof startCapturingServer>>;

  beforeAll(async () => {
    capture = await startCapturingServer();
  });

  afterAll(async () => {
    await capture.close();
  });

  it("outer payload has version=1, application_id, type=1, event", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const appRecord = ds.applications.all()[0]!;

    // Configure event webhooks on this app.
    await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({
        event_webhooks_url: `${capture.url}/hook`,
        event_webhooks_status: EventWebhookStatus.ENABLED,
        event_webhooks_types: [WebhookEventType.APPLICATION_AUTHORIZED],
      }),
    });

    const triggerRes = await app.request("/__emulate/event-webhook", {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: WebhookEventType.APPLICATION_AUTHORIZED, data: { scopes: ["identify"] } }),
    });
    expect(triggerRes.status).toBe(200);
    const triggerBody = (await triggerRes.json()) as { delivered: boolean };
    expect(triggerBody.delivered).toBe(true);

    const req = await capture.next();
    const payload = req.json as Record<string, unknown>;
    expect(payload.version).toBe(1);
    expect(payload.application_id).toBe(appRecord.snowflake);
    expect(payload.type).toBe(1);
    expect(typeof payload.event).toBe("object");
    expect(payload.event).not.toBeNull();
  });

  it("event body has type, timestamp (ISO8601 string), and data", async () => {
    const { app } = createDiscordTestApp();

    await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({
        event_webhooks_url: `${capture.url}/hook`,
        event_webhooks_status: EventWebhookStatus.ENABLED,
        event_webhooks_types: [WebhookEventType.APPLICATION_DEAUTHORIZED],
      }),
    });

    await app.request("/__emulate/event-webhook", {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: WebhookEventType.APPLICATION_DEAUTHORIZED, data: { user: { id: "111" } } }),
    });

    const req = await capture.next();
    const payload = req.json as { event: { type: string; timestamp: string; data: unknown } };
    expect(payload.event.type).toBe(WebhookEventType.APPLICATION_DEAUTHORIZED);
    expect(typeof payload.event.timestamp).toBe("string");
    expect(payload.event.timestamp.length).toBeGreaterThan(0);
    expect(payload.event.data).toEqual({ user: { id: "111" } });
  });
});

// ---------------------------------------------------------------------------
// Signature header tests
// ---------------------------------------------------------------------------

describe("webhook-events.mdx — Signature headers (X-Signature-Ed25519, X-Signature-Timestamp)", () => {
  let capture: Awaited<ReturnType<typeof startCapturingServer>>;

  beforeAll(async () => {
    capture = await startCapturingServer();
  });

  afterAll(async () => {
    await capture.close();
  });

  it("delivery includes X-Signature-Ed25519 and X-Signature-Timestamp headers", async () => {
    const { app } = createDiscordTestApp();

    await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({
        event_webhooks_url: `${capture.url}/hook`,
        event_webhooks_status: EventWebhookStatus.ENABLED,
        event_webhooks_types: [WebhookEventType.ENTITLEMENT_CREATE],
      }),
    });

    await app.request("/__emulate/event-webhook", {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: WebhookEventType.ENTITLEMENT_CREATE, data: { id: "ent1" } }),
    });

    const req = await capture.next();
    expect(typeof req.headers["x-signature-ed25519"]).toBe("string");
    expect(typeof req.headers["x-signature-timestamp"]).toBe("string");
    expect((req.headers["x-signature-ed25519"] as string).length).toBeGreaterThan(0);
    expect((req.headers["x-signature-timestamp"] as string).length).toBeGreaterThan(0);
  });

  it("the signature verifies correctly with the app public key over timestamp + body", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const appRecord = ds.applications.all()[0]!;
    const publicKeyHex = appRecord.verify_key;

    await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({
        event_webhooks_url: `${capture.url}/hook`,
        event_webhooks_status: EventWebhookStatus.ENABLED,
        event_webhooks_types: [WebhookEventType.ENTITLEMENT_UPDATE],
      }),
    });

    await app.request("/__emulate/event-webhook", {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: WebhookEventType.ENTITLEMENT_UPDATE, data: { id: "ent2" } }),
    });

    const req = await capture.next();
    const sigHex = req.headers["x-signature-ed25519"] as string;
    const timestamp = req.headers["x-signature-timestamp"] as string;
    const rawBody = req.body;

    const valid = verifyInteraction(timestamp, rawBody, sigHex, publicKeyHex);
    expect(valid).toBe(true);
  });

  it("a tampered body fails signature verification", async () => {
    const { app, store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const appRecord = ds.applications.all()[0]!;
    const publicKeyHex = appRecord.verify_key;

    await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({
        event_webhooks_url: `${capture.url}/hook`,
        event_webhooks_status: EventWebhookStatus.ENABLED,
        event_webhooks_types: [WebhookEventType.ENTITLEMENT_DELETE],
      }),
    });

    await app.request("/__emulate/event-webhook", {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: WebhookEventType.ENTITLEMENT_DELETE, data: { id: "ent3" } }),
    });

    const req = await capture.next();
    const sigHex = req.headers["x-signature-ed25519"] as string;
    const timestamp = req.headers["x-signature-timestamp"] as string;

    const valid = verifyInteraction(timestamp, req.body + "tampered", sigHex, publicKeyHex);
    expect(valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Delivery gating tests
// ---------------------------------------------------------------------------

describe("webhook-events.mdx — Delivery gating (status + subscribed types)", () => {
  it("does not deliver when event_webhooks_status is DISABLED (1)", async () => {
    const { app } = createDiscordTestApp();

    await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({
        event_webhooks_url: "http://127.0.0.1:19999/unused",
        event_webhooks_status: EventWebhookStatus.DISABLED,
        event_webhooks_types: [WebhookEventType.APPLICATION_AUTHORIZED],
      }),
    });

    const res = await app.request("/__emulate/event-webhook", {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: WebhookEventType.APPLICATION_AUTHORIZED, data: {} }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ delivered: boolean }>(res);
    expect(body.delivered).toBe(false);
  });

  it("does not deliver when event_webhooks_status is DISABLED_BY_DISCORD (3)", async () => {
    const { app } = createDiscordTestApp();

    await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({
        event_webhooks_url: "http://127.0.0.1:19999/unused",
        event_webhooks_status: EventWebhookStatus.DISABLED_BY_DISCORD,
        event_webhooks_types: [WebhookEventType.APPLICATION_AUTHORIZED],
      }),
    });

    const res = await app.request("/__emulate/event-webhook", {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: WebhookEventType.APPLICATION_AUTHORIZED, data: {} }),
    });
    const body = await json<{ delivered: boolean }>(res);
    expect(body.delivered).toBe(false);
  });

  it("does not deliver when the event type is not in event_webhooks_types", async () => {
    const { app } = createDiscordTestApp();

    await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({
        event_webhooks_url: "http://127.0.0.1:19999/unused",
        event_webhooks_status: EventWebhookStatus.ENABLED,
        event_webhooks_types: [WebhookEventType.ENTITLEMENT_CREATE],
      }),
    });

    // Trigger a type NOT in the subscription list.
    const res = await app.request("/__emulate/event-webhook", {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: WebhookEventType.APPLICATION_AUTHORIZED, data: {} }),
    });
    const body = await json<{ delivered: boolean }>(res);
    expect(body.delivered).toBe(false);
  });

  it("does not deliver when event_webhooks_url is absent", async () => {
    const { app } = createDiscordTestApp();
    // Do not configure a URL at all; default extras have no URL.

    const res = await app.request("/__emulate/event-webhook", {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ type: WebhookEventType.APPLICATION_AUTHORIZED, data: {} }),
    });
    const body = await json<{ delivered: boolean }>(res);
    expect(body.delivered).toBe(false);
  });

  it("delivers when ENABLED and event type is subscribed", async () => {
    // Use an in-process emulator — start a capturing server so we don't need a live host.
    const capture = await startCapturingServer();
    const { app } = createDiscordTestApp();

    try {
      await app.request(api("/applications/@me"), {
        method: "PATCH",
        headers: botHeaders(),
        body: JSON.stringify({
          event_webhooks_url: `${capture.url}/hook`,
          event_webhooks_status: EventWebhookStatus.ENABLED,
          event_webhooks_types: [WebhookEventType.APPLICATION_AUTHORIZED, WebhookEventType.ENTITLEMENT_CREATE],
        }),
      });

      const res = await app.request("/__emulate/event-webhook", {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ type: WebhookEventType.APPLICATION_AUTHORIZED, data: { scopes: ["bot"] } }),
      });
      const body = await json<{ delivered: boolean }>(res);
      expect(body.delivered).toBe(true);
      // Confirm the capturing server received something.
      const captured = await capture.next();
      expect(captured.body.length).toBeGreaterThan(0);
    } finally {
      await capture.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Control endpoint validation
// ---------------------------------------------------------------------------

describe("webhook-events.mdx — Control endpoint /__emulate/event-webhook", () => {
  it("returns 400 when type is missing from the request body", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request("/__emulate/event-webhook", {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ data: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 401 without authorization", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request("/__emulate/event-webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: WebhookEventType.APPLICATION_AUTHORIZED, data: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("returns { delivered: true } on successful delivery", async () => {
    const capture = await startCapturingServer();
    const { app } = createDiscordTestApp();

    try {
      await app.request(api("/applications/@me"), {
        method: "PATCH",
        headers: botHeaders(),
        body: JSON.stringify({
          event_webhooks_url: `${capture.url}/hook`,
          event_webhooks_status: EventWebhookStatus.ENABLED,
          event_webhooks_types: [WebhookEventType.APPLICATION_DEAUTHORIZED],
        }),
      });

      const res = await app.request("/__emulate/event-webhook", {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ type: WebhookEventType.APPLICATION_DEAUTHORIZED, data: { user: { id: "999" } } }),
      });
      expect(res.status).toBe(200);
      const body = await json<{ delivered: boolean }>(res);
      expect(body.delivered).toBe(true);
      await capture.next(); // drain
    } finally {
      await capture.close();
    }
  });
});

// ---------------------------------------------------------------------------
// PING handshake (type 0)
// ---------------------------------------------------------------------------

describe("webhook-events.mdx — PING handshake (type 0)", () => {
  it("sendPing delivers a signed payload with type=0 and no event field", async () => {
    const capture = await startCapturingServer();

    // Import here so we test the exported helper.
    const { sendPing } = await import("../../eventWebhooks.js");

    const { store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const appRecord = ds.applications.all()[0]!;

    try {
      const ok = await sendPing(`${capture.url}/ping`, appRecord.snowflake, appRecord.private_key);
      // The capturing server always responds 204, so sendPing should return true.
      expect(ok).toBe(true);

      const req = await capture.next();
      const payload = req.json as Record<string, unknown>;
      expect(payload.version).toBe(1);
      expect(payload.application_id).toBe(appRecord.snowflake);
      expect(payload.type).toBe(0);
      // PING payloads must NOT include an event field.
      expect("event" in payload).toBe(false);
    } finally {
      await capture.close();
    }
  });

  it("sendPing signs the request with X-Signature-Ed25519 verifiable by the app public key", async () => {
    const capture = await startCapturingServer();
    const { sendPing } = await import("../../eventWebhooks.js");
    const { store } = createDiscordTestApp();
    const ds = getDiscordStore(store);
    const appRecord = ds.applications.all()[0]!;

    try {
      await sendPing(`${capture.url}/ping`, appRecord.snowflake, appRecord.private_key);
      const req = await capture.next();
      const sigHex = req.headers["x-signature-ed25519"] as string;
      const timestamp = req.headers["x-signature-timestamp"] as string;
      expect(verifyInteraction(timestamp, req.body, sigHex, appRecord.verify_key)).toBe(true);
    } finally {
      await capture.close();
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end with a real listening emulator server
// ---------------------------------------------------------------------------

describe("webhook-events.mdx — end-to-end delivery via real emulator server", () => {
  it("delivery round-trip: configure, trigger, capture, verify signature", async () => {
    const emulator = await startDiscordTestEmulator();
    const capture = await startCapturingServer();

    try {
      const ds = getDiscordStore(emulator.store);
      const appRecord = ds.applications.all()[0]!;
      const publicKeyHex = appRecord.verify_key;

      // Patch the application to enable event webhooks.
      const patchRes = await fetch(`${emulator.baseUrl}/api/v10/applications/@me`, {
        method: "PATCH",
        headers: { Authorization: "Bot test_bot_token", "Content-Type": "application/json" },
        body: JSON.stringify({
          event_webhooks_url: `${capture.url}/hook`,
          event_webhooks_status: EventWebhookStatus.ENABLED,
          event_webhooks_types: [WebhookEventType.APPLICATION_AUTHORIZED],
        }),
      });
      expect(patchRes.status).toBe(200);

      // Trigger via the control endpoint.
      const triggerRes = await fetch(`${emulator.baseUrl}/__emulate/event-webhook`, {
        method: "POST",
        headers: { Authorization: "Bot test_bot_token", "Content-Type": "application/json" },
        body: JSON.stringify({
          type: WebhookEventType.APPLICATION_AUTHORIZED,
          data: { integration_type: 0, scopes: ["bot"], user: { id: "12345" } },
        }),
      });
      expect(triggerRes.status).toBe(200);
      const triggerBody = (await triggerRes.json()) as { delivered: boolean };
      expect(triggerBody.delivered).toBe(true);

      // Capture and verify.
      const req = await capture.next(5000);
      const payload = req.json as Record<string, unknown>;
      expect(payload.version).toBe(1);
      expect(payload.application_id).toBe(appRecord.snowflake);
      expect(payload.type).toBe(1);

      const event = payload.event as { type: string; timestamp: string; data: unknown };
      expect(event.type).toBe(WebhookEventType.APPLICATION_AUTHORIZED);
      expect(typeof event.timestamp).toBe("string");
      expect((event.data as Record<string, unknown>).scopes).toEqual(["bot"]);

      const sigHex = req.headers["x-signature-ed25519"] as string;
      const timestamp = req.headers["x-signature-timestamp"] as string;
      expect(verifyInteraction(timestamp, req.body, sigHex, publicKeyHex)).toBe(true);
    } finally {
      await capture.close();
      await emulator.close();
    }
  });
});
