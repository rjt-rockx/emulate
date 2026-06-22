import { Hono, Store, WebhookDispatcher, serve, type AppEnv } from "@emulators/core";
import type { AddressInfo } from "node:net";
import { discordPlugin } from "../index.js";
import { seedFromConfig, type DiscordSeedConfig } from "../seed.js";
import { gatewayUrlFromBaseUrl } from "../helpers.js";
import { getDiscordStore } from "../store.js";

export const TEST_BASE_URL = "http://localhost:4099";
export const BOT_TOKEN = "test_bot_token";

/** Build a REST path under the versioned Discord API base. */
export function api(path: string, baseUrl: string = TEST_BASE_URL): string {
  return `${baseUrl}/api/v10${path}`;
}

export function botHeaders(token: string = BOT_TOKEN): Record<string, string> {
  return { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
}

export function bearerHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

export interface DiscordTestApp {
  app: Hono<AppEnv>;
  store: Store;
  webhooks: WebhookDispatcher;
  baseUrl: string;
}

/** The snowflakes of the entities the default seed creates — so specs stop re-deriving them. */
export interface SeededIds {
  app: string;
  bot: string;
  guild: string;
  general: string;
  random: string;
  voice: string;
  developer: string;
}

/** Resolve the default-seed entity ids (Emulate App/bot, Emulate Server, general/random/General). */
export function seededIds(store: Store): SeededIds {
  const ds = getDiscordStore(store);
  const app = ds.applications.all()[0]!;
  return {
    app: app.snowflake,
    bot: app.bot_user_snowflake,
    guild: ds.guilds.findOneBy("name", "Emulate Server")!.snowflake,
    general: ds.channels.findOneBy("name", "general")!.snowflake,
    random: ds.channels.findOneBy("name", "random")!.snowflake,
    voice: ds.channels.findOneBy("name", "General")!.snowflake,
    developer: ds.users.findOneBy("username", "developer")!.snowflake,
  };
}

/** Typed `res.json()` — trims the `(await res.json()) as T` cast repeated across specs. */
export async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** In-process app + store (no real listening). Use for REST route tests. */
export function createDiscordTestApp(seed?: DiscordSeedConfig): DiscordTestApp {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const app = new Hono<AppEnv>();
  discordPlugin.register(app, store, webhooks, TEST_BASE_URL);
  discordPlugin.seed?.(store, TEST_BASE_URL);
  if (seed) seedFromConfig(store, TEST_BASE_URL, seed);
  return { app, store, webhooks, baseUrl: TEST_BASE_URL };
}

export interface RunningDiscordEmulator {
  baseUrl: string;
  gatewayUrl: string;
  store: Store;
  webhooks: WebhookDispatcher;
  close(): Promise<void>;
}

/**
 * Start a real listening emulator on an ephemeral port, with the Gateway WebSocket
 * attached. Use for gateway / discord.js integration tests.
 */
export async function startDiscordTestEmulator(seed?: DiscordSeedConfig): Promise<RunningDiscordEmulator> {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const app = new Hono<AppEnv>();
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://localhost:${port}`;

  discordPlugin.register(app, store, webhooks, baseUrl);
  discordPlugin.seed?.(store, baseUrl);
  if (seed) seedFromConfig(store, baseUrl, seed);
  const dispose = discordPlugin.attach?.(server, store, baseUrl);

  return {
    baseUrl,
    gatewayUrl: gatewayUrlFromBaseUrl(baseUrl),
    store,
    webhooks,
    async close() {
      await dispose?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
