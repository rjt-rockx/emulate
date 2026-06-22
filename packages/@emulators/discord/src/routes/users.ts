import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, toAPIUser, toAPIChannel } from "../helpers.js";
import { createChannel } from "../factories.js";

export function usersRoutes(ctx: DiscordRouteContext): void {
  const { app, store } = ctx;

  // Register @me literal routes before the :userId param route so "@me" is not
  // captured as a user id.
  app.get("/api/v:version/users/@me", (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    return c.json(toAPIUser(auth.user, true));
  });

  app.patch("/api/v:version/users/@me", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    const ds = getDiscordStore(store);
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // empty body allowed
    }
    const patch: Record<string, unknown> = {};
    if (typeof body.username === "string") patch.username = body.username;
    if (body.global_name !== undefined) patch.global_name = body.global_name;
    if (body.avatar !== undefined) patch.avatar = body.avatar;
    if (Object.keys(patch).length > 0) ds.users.update(auth.user.id, patch);
    const updated = ds.users.findOneBy("snowflake", auth.user.snowflake) ?? auth.user;
    return c.json(toAPIUser(updated, true));
  });

  app.get("/api/v:version/users/@me/guilds", (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    const ds = getDiscordStore(store);
    const withCounts = c.req.query("with_counts") === "true";
    const memberships = ds.members.findBy("user_snowflake", auth.user.snowflake);
    const guilds = memberships
      .map((m) => ds.guilds.findOneBy("snowflake", m.guild_snowflake))
      .filter((g): g is NonNullable<typeof g> => !!g)
      .map((g) => {
        const partial: Record<string, unknown> = {
          id: g.snowflake,
          name: g.name,
          icon: g.icon,
          banner: g.splash,
          owner: g.owner_snowflake === auth.user!.snowflake,
          permissions: "0",
          features: g.features,
        };
        if (withCounts) {
          partial.approximate_member_count = g.member_snowflakes.length;
          partial.approximate_presence_count = g.member_snowflakes.length;
        }
        return partial;
      });
    return c.json(guilds);
  });

  app.post("/api/v:version/users/@me/channels", async (c) => {
    const auth = getAuth(c, store);
    if (!auth || !auth.user) return unauthorized(c);
    const ds = getDiscordStore(store);
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // no-op
    }
    const recipientId = typeof body.recipient_id === "string" ? body.recipient_id : "";
    const recipient = ds.users.findOneBy("snowflake", recipientId);
    if (!recipient) return notFound(c);

    // Reuse an existing DM with the same recipient pair if present.
    const existing = ds.channels
      .all()
      .find(
        (ch) =>
          ch.type === 1 &&
          ch.recipient_snowflakes.includes(auth.user!.snowflake) &&
          ch.recipient_snowflakes.includes(recipient.snowflake),
      );
    if (existing) return c.json(toAPIChannel(existing));

    const dm = createChannel(ds, { name: "", type: 1, guildSnowflake: null });
    ds.channels.update(dm.id, { recipient_snowflakes: [auth.user.snowflake, recipient.snowflake] });
    const created = ds.channels.findOneBy("snowflake", dm.snowflake)!;
    return c.json(toAPIChannel(created));
  });

  app.get("/api/v:version/users/:userId", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const user = ds.users.findOneBy("snowflake", c.req.param("userId"));
    if (!user) return notFound(c);
    return c.json(toAPIUser(user));
  });
}
