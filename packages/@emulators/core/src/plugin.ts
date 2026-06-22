import type { Server } from "node:http";
import type { Hono } from "./http.js";
import type { Store } from "./store.js";
import type { WebhookDispatcher } from "./webhooks.js";
import type { TokenMap, AppEnv } from "./middleware/auth.js";

export interface RouteContext {
  app: Hono<AppEnv>;
  store: Store;
  webhooks: WebhookDispatcher;
  baseUrl: string;
  tokenMap?: TokenMap;
}

/**
 * A disposer returned by `ServicePlugin.attach`. Invoked on emulator shutdown to
 * release any resources the plugin acquired on the raw HTTP server (sockets, timers,
 * child processes, etc.).
 */
export type PluginDisposer = () => void | Promise<void>;

export interface ServicePlugin {
  name: string;
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void;
  seed?(store: Store, baseUrl: string): void;
  /**
   * Optional realtime/raw-server seam. Called once, after the HTTP server starts
   * listening, with the underlying Node `http.Server`. A plugin may attach an
   * `upgrade` handler (e.g. a WebSocket server) or other server-level behavior.
   * The returned disposer (if any) is invoked on `close()`/shutdown.
   *
   * Generic by design: any future realtime service can reuse this without core
   * needing to know about the specific protocol.
   */
  attach?(server: Server, store: Store, baseUrl: string): PluginDisposer | void;
}
