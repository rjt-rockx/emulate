import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "./helpers.js";
import { getDiscordStore } from "../store.js";

function appId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return getDiscordStore(store).applications.all()[0].snowflake;
}

describe("discord application role connections", () => {
  it("sets and reads application role-connection metadata", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const metadata = [{ type: 2, key: "level", name: "Level", description: "Account level" }];

    const put = await app.request(api(`/applications/${aid}/role-connections/metadata`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify(metadata),
    });
    expect(put.status).toBe(200);

    const got = (await (
      await app.request(api(`/applications/${aid}/role-connections/metadata`), { headers: botHeaders() })
    ).json()) as Array<{ key: string }>;
    expect(got.some((m) => m.key === "level")).toBe(true);
  });

  it("updates and reads the user's role connection", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const put = await app.request(api(`/users/@me/applications/${aid}/role-connection`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ platform_name: "Steam", platform_username: "gamer", metadata: { level: "42" } }),
    });
    expect(put.status).toBe(200);
    const conn = (await (
      await app.request(api(`/users/@me/applications/${aid}/role-connection`), { headers: botHeaders() })
    ).json()) as { platform_name: string; metadata: Record<string, string> };
    expect(conn.platform_name).toBe("Steam");
    expect(conn.metadata.level).toBe("42");
  });
});
