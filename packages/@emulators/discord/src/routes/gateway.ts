import { getAuth, gatewayUrlFromBaseUrl, unauthorized } from "../helpers.js";
import type { DiscordRouteContext } from "../context.js";

/** Gateway bootstrap: tells a bot which WebSocket URL to connect to. */
export function gatewayRoutes(ctx: DiscordRouteContext): void {
  const { app, store, baseUrl } = ctx;

  app.get("/api/v:version/gateway", (c) => c.json({ url: gatewayUrlFromBaseUrl(baseUrl) }));

  app.get("/api/v:version/gateway/bot", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    return c.json({
      url: gatewayUrlFromBaseUrl(baseUrl),
      shards: 1,
      session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
    });
  });
}
