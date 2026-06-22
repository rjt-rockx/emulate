import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders } from "./helpers.js";
import { getDiscordStore } from "../store.js";

function ids(store: ReturnType<typeof createDiscordTestApp>["store"]) {
  const ds = getDiscordStore(store);
  return {
    guild: ds.guilds.findOneBy("name", "Emulate Server")!.snowflake,
    bot: ds.users.findOneBy("username", "emulate-bot")!.snowflake,
    developer: ds.users.findOneBy("username", "developer")!.snowflake,
    voice: ds.channels.findBy("guild_snowflake", ds.guilds.findOneBy("name", "Emulate Server")!.snowflake).find((c) => c.type === 2)!.snowflake,
  };
}

describe("serializer fidelity", () => {
  it("guild object includes the documented extended fields", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild } = ids(store);
    const g = (await (await app.request(api(`/guilds/${guild}`), { headers: botHeaders() })).json()) as Record<string, unknown>;
    for (const key of [
      "premium_progress_bar_enabled",
      "max_members",
      "max_video_channel_users",
      "vanity_url_code",
      "system_channel_flags",
      "banner",
      "stickers",
      "widget_enabled",
    ]) {
      expect(key in g).toBe(true);
    }
    expect(Array.isArray(g.stickers)).toBe(true);
    expect(g.max_members).toBe(500_000);
  });

  it("voice channel carries voice-specific fields", async () => {
    const { app, store } = createDiscordTestApp();
    const { voice } = ids(store);
    const c = (await (await app.request(api(`/channels/${voice}`), { headers: botHeaders() })).json()) as Record<string, unknown>;
    expect(c.video_quality_mode).toBe(1);
    expect("rtc_region" in c).toBe(true);
    expect(c.flags).toBe(0);
  });

  it("DM channel does not leak guild-only fields", async () => {
    const { app, store } = createDiscordTestApp();
    const { developer } = ids(store);
    const dm = (await (await app.request(api("/users/@me/channels"), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ recipient_id: developer }),
    })).json()) as Record<string, unknown>;
    expect(dm.type).toBe(1);
    expect("permission_overwrites" in dm).toBe(false);
    expect("position" in dm).toBe(false);
    expect("nsfw" in dm).toBe(false);
  });

  it("member timeout is settable and serialized", async () => {
    const { app, store } = createDiscordTestApp();
    const { guild, bot } = ids(store);
    const until = new Date(Date.now() + 60_000).toISOString();
    const res = await app.request(api(`/guilds/${guild}/members/${bot}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ communication_disabled_until: until }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { communication_disabled_until: string }).communication_disabled_until).toBe(until);
  });
});
