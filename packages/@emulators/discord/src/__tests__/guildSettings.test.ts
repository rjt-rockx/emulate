import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json, seededIds } from "./helpers.js";
import { getDiscordStore } from "../store.js";
import { snowflake } from "../helpers.js";

function guildId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return seededIds(store).guild;
}

describe("discord guild settings", () => {
  it("updates and reads widget settings", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);
    const patched = await json<{ enabled: boolean }>(await app.request(api(`/guilds/${gid}/widget`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ enabled: true }),
    }));
    expect(patched.enabled).toBe(true);
    const got = await json<{ enabled: boolean }>(await app.request(api(`/guilds/${gid}/widget`), { headers: botHeaders() }));
    expect(got.enabled).toBe(true);
  });

  it("updates the welcome screen and onboarding", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);
    const welcome = await json<{ description: string }>(await app.request(api(`/guilds/${gid}/welcome-screen`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ description: "Welcome!" }),
    }));
    expect(welcome.description).toBe("Welcome!");

    const onboarding = await json<{ enabled: boolean; mode: number; guild_id: string }>(await app.request(api(`/guilds/${gid}/onboarding`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify({ enabled: true, mode: 1 }),
    }));
    expect(onboarding.enabled).toBe(true);
    expect(onboarding.mode).toBe(1);
    expect(onboarding.guild_id).toBe(gid);
  });

  it("serves the public widget json", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);
    const res = await app.request(api(`/guilds/${gid}/widget.json`));
    expect(res.status).toBe(200);
    const widget = await json<{ id: string; name: string }>(res);
    expect(widget.id).toBe(gid);
    expect(widget.name).toBe("Emulate Server");
  });

  it("lists and actions guild join requests", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);
    const ds = getDiscordStore(store);
    const user = seededIds(store).developer;
    const req = ds.guildJoinRequests.insert({
      snowflake: snowflake(),
      guild_snowflake: gid,
      user_snowflake: user,
      application_status: "SUBMITTED",
      reviewed_at: null,
      rejection_reason: null,
      actioned_by_user_snowflake: null,
    });

    // List shows the submitted request.
    const list = await json<{ total: number; guild_join_requests: Array<{ id: string; application_status: string }> }>(
      await app.request(api(`/guilds/${gid}/requests`), { headers: botHeaders() }),
    );
    expect(list.total).toBe(1);
    expect(list.guild_join_requests[0].id).toBe(req.snowflake);
    expect(list.guild_join_requests[0].application_status).toBe("SUBMITTED");

    // Reject it with a reason.
    const rejected = await app.request(api(`/guilds/${gid}/requests/${req.snowflake}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ action: "REJECTED", rejection_reason: "spam" }),
    });
    expect(rejected.status).toBe(200);
    const body = await json<{ application_status: string; rejection_reason: string | null; reviewed_at: string | null }>(rejected);
    expect(body.application_status).toBe("REJECTED");
    expect(body.rejection_reason).toBe("spam");
    expect(body.reviewed_at).not.toBeNull();
  });

  it("rejects an invalid join-request action (50035) and 404s an unknown request", async () => {
    const { app, store } = createDiscordTestApp();
    const gid = guildId(store);
    const ds = getDiscordStore(store);
    const req = ds.guildJoinRequests.insert({
      snowflake: snowflake(),
      guild_snowflake: gid,
      user_snowflake: seededIds(store).developer,
      application_status: "SUBMITTED",
      reviewed_at: null,
      rejection_reason: null,
      actioned_by_user_snowflake: null,
    });
    const bad = await app.request(api(`/guilds/${gid}/requests/${req.snowflake}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ action: "NONSENSE" }),
    });
    expect(bad.status).toBe(400);
    expect((await json<{ code: number }>(bad)).code).toBe(50035);

    const missing = await app.request(api(`/guilds/${gid}/requests/999999999999999999`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ action: "APPROVED" }),
    });
    expect(missing.status).toBe(404);
  });
});
