import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createDiscordTestApp, api, botHeaders } from "./helpers.js";

function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}/interactions`, close: () => server.close() });
    });
  });
}

describe("interactions endpoint PING validation (opt-in)", () => {
  const servers: Array<{ close: () => void }> = [];
  afterEach(() => {
    for (const s of servers) s.close();
    servers.length = 0;
  });

  it("accepts an endpoint that replies with a PONG", async () => {
    const pong = await startServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ type: 1 }));
    });
    servers.push(pong);

    const { app } = createDiscordTestApp({ validate_interactions_endpoint: true });
    const res = await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ interactions_endpoint_url: pong.url }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects a reachable endpoint that does not PONG with 50035", async () => {
    const bad = await startServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ hello: "world" }));
    });
    servers.push(bad);

    const { app } = createDiscordTestApp({ validate_interactions_endpoint: true });
    const res = await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ interactions_endpoint_url: bad.url }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(50035);
  });

  it("is lenient when validation is disabled (default)", async () => {
    const { app } = createDiscordTestApp();
    const res = await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ interactions_endpoint_url: "https://example.com/unreachable-but-accepted" }),
    });
    expect(res.status).toBe(200);
  });
});
