// Standalone Discord emulator on a fixed port, for running real open-source bots/clients against it
// (real-client acceptance testing). Build first (`pnpm --filter @emulators/discord build`), then:
//   PORT=38080 node launch-emulator.mjs
// It prints the seeded ids + bot token (test_bot_token) and keeps listening. Point a client's REST
// base at <baseUrl>/api and let it resolve the gateway via GET /gateway(/bot).
import { Hono, Store, WebhookDispatcher, serve } from "@emulators/core";
import { discordPlugin, getDiscordStore } from "@emulators/discord";

const PORT = Number(process.env.PORT || 38080);
const store = new Store();
const webhooks = new WebhookDispatcher();
const app = new Hono();
const server = serve({ fetch: app.fetch, port: PORT });
await new Promise((r) => server.once("listening", r));
const baseUrl = `http://localhost:${PORT}`;

discordPlugin.register(app, store, webhooks, baseUrl);
discordPlugin.seed?.(store, baseUrl);
discordPlugin.attach?.(server, store, baseUrl);

const ds = getDiscordStore(store);
const app0 = ds.applications.all()[0];
const guild = ds.guilds.findOneBy("name", "Emulate Server");
console.log(JSON.stringify({
  baseUrl,
  gateway: baseUrl.replace("http", "ws"),
  bot_token: "test_bot_token",
  application_id: app0.snowflake,
  bot_user_id: app0.bot_user_snowflake,
  guild_id: guild.snowflake,
  general_channel_id: ds.channels.findOneBy("name", "general").snowflake,
}, null, 2));
console.log("emulator listening on", baseUrl);
