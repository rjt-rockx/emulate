import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, toAPIUser, snowflake } from "../helpers.js";
import type { DiscordApplication, DiscordApplicationEmoji } from "../entities.js";

function toAPIApplication(application: DiscordApplication, ds: ReturnType<typeof getDiscordStore>): Record<string, unknown> {
  const botUser = ds.users.findOneBy("snowflake", application.bot_user_snowflake);
  const owner =
    (application.owner_snowflake && ds.users.findOneBy("snowflake", application.owner_snowflake)) ||
    ds.users.all().find((u) => !u.bot) ||
    botUser;
  return {
    id: application.snowflake,
    name: application.name,
    description: application.description,
    icon: application.icon,
    rpc_origins: [],
    bot_public: true,
    bot_require_code_grant: false,
    owner: owner ? toAPIUser(owner) : null,
    verify_key: application.verify_key,
    team: null,
    flags: application.flags,
    bot: botUser ? toAPIUser(botUser) : undefined,
  };
}

function toAPIAppEmoji(e: DiscordApplicationEmoji, ds: ReturnType<typeof getDiscordStore>): Record<string, unknown> {
  const creator = e.creator_snowflake ? ds.users.findOneBy("snowflake", e.creator_snowflake) : null;
  return {
    id: e.snowflake,
    name: e.name,
    roles: e.role_snowflakes,
    user: creator ? toAPIUser(creator) : null,
    require_colons: e.require_colons,
    managed: e.managed,
    animated: e.animated,
    available: e.available,
  };
}

export function applicationManagementRoutes(ctx: DiscordRouteContext): void {
  const { app, store } = ctx;

  // GET /api/v:version/applications/@me
  app.get("/api/v:version/applications/@me", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const appRecord = auth.application ?? ds.applications.all()[0];
    if (!appRecord) return unauthorized(c);
    return c.json(toAPIApplication(appRecord, ds));
  });

  // PATCH /api/v:version/applications/@me
  app.patch("/api/v:version/applications/@me", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const appRecord = auth.application ?? ds.applications.all()[0];
    if (!appRecord) return unauthorized(c);

    const body = await c.req.json<Record<string, unknown>>();
    const patch: Partial<DiscordApplication> = {};
    if (body.description !== undefined) patch.description = body.description as string;
    if (body.interactions_endpoint_url !== undefined)
      patch.interactions_endpoint_url = body.interactions_endpoint_url as string | null;
    if (body.icon !== undefined) patch.icon = body.icon as string | null;
    if (body.flags !== undefined) patch.flags = body.flags as number;
    if (body.name !== undefined) patch.name = body.name as string;

    ds.applications.update(appRecord.id, patch);
    const updated = ds.applications.findOneBy("snowflake", appRecord.snowflake)!;
    return c.json(toAPIApplication(updated, ds));
  });

  // GET /api/v:version/applications/:appId/emojis
  app.get("/api/v:version/applications/:appId/emojis", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const appId = c.req.param("appId");
    const emojis = ds.appEmojis.findBy("application_snowflake", appId).map((e) => toAPIAppEmoji(e, ds));
    return c.json({ items: emojis });
  });

  // GET /api/v:version/applications/:appId/emojis/:emojiId
  app.get("/api/v:version/applications/:appId/emojis/:emojiId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const emojiId = c.req.param("emojiId");
    const emoji = ds.appEmojis.findOneBy("snowflake", emojiId);
    if (!emoji) return notFound(c);
    return c.json(toAPIAppEmoji(emoji, ds));
  });

  // POST /api/v:version/applications/:appId/emojis
  app.post("/api/v:version/applications/:appId/emojis", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const appId = c.req.param("appId");
    const body = await c.req.json<{ name: string; image?: string; roles?: string[] }>();

    const appRecord = auth.application ?? ds.applications.all()[0];
    const botUser = appRecord ? ds.users.findOneBy("snowflake", appRecord.bot_user_snowflake) : null;

    const inserted = ds.appEmojis.insert({
      snowflake: snowflake(),
      application_snowflake: appId,
      name: body.name,
      animated: false,
      managed: false,
      available: true,
      require_colons: true,
      creator_snowflake: botUser?.snowflake ?? null,
      role_snowflakes: body.roles ?? [],
    });
    return c.json(toAPIAppEmoji(inserted, ds), 201);
  });

  // PATCH /api/v:version/applications/:appId/emojis/:emojiId
  app.patch("/api/v:version/applications/:appId/emojis/:emojiId", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const emojiId = c.req.param("emojiId");
    const emoji = ds.appEmojis.findOneBy("snowflake", emojiId);
    if (!emoji) return notFound(c);

    const body = await c.req.json<{ name?: string }>();
    if (body.name !== undefined) {
      ds.appEmojis.update(emoji.id, { name: body.name });
    }
    const updated = ds.appEmojis.findOneBy("snowflake", emojiId)!;
    return c.json(toAPIAppEmoji(updated, ds));
  });

  // DELETE /api/v:version/applications/:appId/emojis/:emojiId
  app.delete("/api/v:version/applications/:appId/emojis/:emojiId", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const emojiId = c.req.param("emojiId");
    const emoji = ds.appEmojis.findOneBy("snowflake", emojiId);
    if (!emoji) return notFound(c);
    ds.appEmojis.delete(emoji.id);
    return new Response(null, { status: 204 });
  });
}
