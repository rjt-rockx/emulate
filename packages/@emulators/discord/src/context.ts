import type { Hono, AppEnv, Store, WebhookDispatcher } from "@emulators/core";
import type { DiscordEventBus } from "./gateway/dispatcher.js";

/** Context handed to every Discord route module. */
export interface DiscordRouteContext {
  app: Hono<AppEnv>;
  store: Store;
  webhooks: WebhookDispatcher;
  baseUrl: string;
  /** In-package event bus: REST mutations publish gateway events here. */
  bus: DiscordEventBus;
}
