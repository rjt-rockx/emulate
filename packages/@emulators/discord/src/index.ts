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
import { inspectorRoutes } from "./routes/inspector.js";

export const discordPlugin: ServicePlugin = {
  name: "discord",

  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    const runtime = getDiscordRuntime(store, baseUrl);
    const ctx: DiscordRouteContext = { app, store, webhooks, baseUrl, bus: runtime.bus };

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
} from "./helpers.js";
