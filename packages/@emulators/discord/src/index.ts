import type { Server } from "node:http";
import {
  type Hono,
  type AppEnv,
  type Store,
  type WebhookDispatcher,
  type TokenMap,
  type ServicePlugin,
  type PluginDisposer,
} from "@emulators/core";
import { getDiscordRuntime, clearDiscordRuntime } from "./runtime.js";
import { getRateLimiter } from "./rateLimiter.js";
import { GatewayServer } from "./gateway/server.js";
import { type DiscordRouteContext } from "./context.js";
import { seedDefaults } from "./seed.js";

import { usersRoutes } from "./routes/users.js";
import { guildsRoutes } from "./routes/guilds.js";
import { channelsRoutes } from "./routes/channels.js";
import { messagesRoutes } from "./routes/messages.js";
import { reactionsRoutes } from "./routes/reactions.js";
import { gatewayRoutes } from "./routes/gateway.js";
import { oauthRoutes } from "./routes/oauth.js";
import { applicationCommandsRoutes } from "./routes/applicationCommands.js";
import { interactionsRoutes } from "./routes/interactions.js";
import { webhooksRoutes } from "./routes/webhooks.js";
import { extrasRoutes } from "./routes/extras.js";
import { guildResourcesRoutes } from "./routes/guildResources.js";
import { threadsRoutes } from "./routes/threads.js";
import { guildMiscRoutes } from "./routes/guildMisc.js";
import { moderationRoutes } from "./routes/moderation.js";
import { templatesRoutes } from "./routes/templates.js";
import { pollsRoutes } from "./routes/polls.js";
import { roleConnectionsRoutes } from "./routes/roleConnections.js";
import { guildSettingsRoutes } from "./routes/guildSettings.js";
import { soundboardRoutes } from "./routes/soundboard.js";
import { inspectorRoutes } from "./routes/inspector.js";
import { monetizationRoutes } from "./routes/monetization.js";
import { integrationsRoutes } from "./routes/integrations.js";
import { applicationManagementRoutes } from "./routes/applicationManagement.js";
import { commandPermissionsRoutes } from "./routes/commandPermissions.js";
import { lobbiesRoutes } from "./routes/lobbies.js";
import { voiceRoutes } from "./routes/voice.js";
import { miscRoutes } from "./routes/misc.js";
import { eventWebhookRoutes } from "./eventWebhooks.js";

export const discordPlugin: ServicePlugin = {
  name: "discord",

  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    const runtime = getDiscordRuntime(store, baseUrl);
    const ctx: DiscordRouteContext = { app, store, webhooks, baseUrl, bus: runtime.bus };

    // Discord-style rate limiting: real per-route buckets + a global budget. Every REST
    // response carries the X-RateLimit-* headers; an exhausted bucket returns a 429 with a
    // Retry-After. Limits are generous by default (see DEFAULT_RATE_LIMIT) so normal usage
    // never trips — a client testing its 429 handling can tighten them via setRateLimitConfig.
    app.use("*", async (c, next) => {
      if (!c.req.path.startsWith("/api/")) {
        await next();
        return;
      }
      const limiter = getRateLimiter(store);
      if (!limiter.enabled) {
        await next();
        return;
      }
      const decision = limiter.check(c.req.method, c.req.path);
      const resetAfter = (decision.resetAfterMs / 1000).toFixed(3);
      c.header("X-RateLimit-Limit", String(decision.limit));
      c.header("X-RateLimit-Remaining", String(decision.remaining));
      c.header("X-RateLimit-Reset", String((Date.now() + decision.resetAfterMs) / 1000));
      c.header("X-RateLimit-Reset-After", resetAfter);
      c.header("X-RateLimit-Bucket", decision.bucket);
      if (!decision.allowed) {
        c.header("Retry-After", resetAfter);
        c.header("X-RateLimit-Scope", decision.global ? "global" : "user");
        if (decision.global) c.header("X-RateLimit-Global", "true");
        return c.json(
          { message: "You are being rate limited.", retry_after: decision.resetAfterMs / 1000, global: decision.global, code: 0 },
          429,
        );
      }
      await next();
    });

    gatewayRoutes(ctx);
    oauthRoutes(ctx);
    usersRoutes(ctx);
    guildsRoutes(ctx);
    channelsRoutes(ctx);
    messagesRoutes(ctx);
    reactionsRoutes(ctx);
    applicationCommandsRoutes(ctx);
    interactionsRoutes(ctx);
    webhooksRoutes(ctx);
    extrasRoutes(ctx);
    guildResourcesRoutes(ctx);
    threadsRoutes(ctx);
    guildMiscRoutes(ctx);
    moderationRoutes(ctx);
    templatesRoutes(ctx);
    pollsRoutes(ctx);
    roleConnectionsRoutes(ctx);
    guildSettingsRoutes(ctx);
    soundboardRoutes(ctx);
    monetizationRoutes(ctx);
    integrationsRoutes(ctx);
    applicationManagementRoutes(ctx);
    commandPermissionsRoutes(ctx);
    lobbiesRoutes(ctx);
    voiceRoutes(ctx);
    miscRoutes(ctx);
    eventWebhookRoutes(ctx);
    inspectorRoutes(ctx);
  },

  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },

  attach(server: Server, store: Store, baseUrl: string): PluginDisposer {
    const runtime = getDiscordRuntime(store, baseUrl);
    const gateway = new GatewayServer(server, store, baseUrl, runtime.bus);
    return async () => {
      await gateway.close();
      clearDiscordRuntime(store);
    };
  },
};

export default discordPlugin;

export { type DiscordRouteContext } from "./context.js";
export { seedFromConfig, seedDefaults, type DiscordSeedConfig } from "./seed.js";
export { getDiscordStore, type DiscordStore } from "./store.js";
export * from "./entities.js";
export { Intents } from "./gateway/intents.js";
export { GatewayOpcodes, GatewayCloseCodes } from "./gateway/opcodes.js";
export { type GatewayEvent } from "./gateway/dispatcher.js";
export { verifyInteraction, signInteraction, generateEd25519KeyPair } from "./interactions/ed25519.js";
export { computePermissions, hasPermission, PermissionFlags, ALL_PERMISSIONS } from "./permissions.js";
export {
  snowflake,
  gatewayUrlFromBaseUrl,
  getAuth,
  toAPIUser,
  toAPIGuild,
  toAPIChannel,
  toAPIMessage,
  toAPIRole,
  toAPIMember,
  toAPIEmoji,
  MessageFlags,
  isEphemeral,
  AuditLogEvent,
  recordAudit,
} from "./helpers.js";
export { packETF, unpackETF } from "./gateway/etf.js";
export { setRateLimitConfig, getRateLimiter, DEFAULT_RATE_LIMIT, type RateLimitConfig } from "./rateLimiter.js";
export {
  EventWebhookStatus,
  WebhookType,
  WebhookEventType,
  dispatchEventWebhook,
  sendPing,
  type WebhookEventPayload,
  type WebhookPingPayload,
  type WebhookEventTypeValue,
} from "./eventWebhooks.js";
