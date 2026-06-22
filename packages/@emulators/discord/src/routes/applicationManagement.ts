import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import { getAuth, unauthorized, notFound, discordError, toAPIUser, snowflake } from "../helpers.js";
import { signInteraction } from "../interactions/ed25519.js";
import type { DiscordApplication, DiscordApplicationEmoji } from "../entities.js";

/**
 * Validate an interactions endpoint by sending a signed PING (type 1) and expecting a PONG
 * (type 1), as Discord does before accepting the URL. Unreachable endpoints are treated
 * leniently (accepted) so configs/tests without a live server still work; a reachable endpoint
 * that fails to PONG is rejected.
 */
async function validateInteractionsEndpoint(url: string, app: DiscordApplication): Promise<{ ok: boolean; reachable: boolean }> {
  const payload = JSON.stringify({ type: 1, application_id: app.snowflake });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signInteraction(timestamp, payload, app.private_key);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature-Ed25519": signature, "X-Signature-Timestamp": timestamp },
      body: payload,
    });
    const data = (await res.json().catch(() => null)) as { type?: number } | null;
    return { ok: res.ok && data?.type === 1, reachable: true };
  } catch {
    return { ok: false, reachable: false };
  }
}

/**
 * Editable application properties documented by the Application Resource page that have no
 * dedicated column on the {@link DiscordApplication} entity. They are kept in the store's
 * key/value side-channel (keyed by application snowflake) so PATCH /applications/@me can
 * round-trip them without touching the shared entity definitions.
 */
interface ApplicationExtras {
  custom_install_url?: string;
  role_connections_verification_url?: string | null;
  install_params?: unknown;
  integration_types_config?: Record<string, unknown>;
  tags?: string[];
  event_webhooks_url?: string | null;
  event_webhooks_status?: number;
  event_webhooks_types?: string[];
}

/**
 * Team Member Membership State enum values (teams.mdx — Membership State Enum).
 *
 * INVITED  (1): the user has been invited but has not yet accepted.
 * ACCEPTED (2): the user has accepted the invitation and is a full member.
 */
export const MembershipState = {
  INVITED: 1,
  ACCEPTED: 2,
} as const;

/**
 * Team Member Role string values (teams.mdx — Team Member Role Types).
 *
 * The owner role is NOT stored in `role`; it is identified via `owner_user_id` on the Team object.
 */
export const TeamMemberRole = {
  ADMIN: "admin",
  DEVELOPER: "developer",
  READ_ONLY: "read_only",
} as const;

/** Partial user shape carried inside a TeamMember (avatar, discriminator, id, username). */
export interface TeamMemberUser {
  id: string;
  username: string;
  discriminator?: string;
  avatar?: string | null;
}

/** Serialisable shape of a single team member (teams.mdx — Team Member Object). */
export interface TeamMember {
  membership_state: 1 | 2;
  team_id: string;
  user: TeamMemberUser;
  role: string;
}

/**
 * Serialisable shape of the Team object that the Application carries (teams.mdx — Team Object).
 * Stored in the store's key/value side-channel keyed by application snowflake so tests can
 * configure a team without touching entities or factories.
 */
export interface TeamData {
  id: string;
  name: string;
  icon: string | null;
  owner_user_id: string;
  members: TeamMember[];
}

/** Store key for a {@link TeamData} value associated with an application snowflake. */
export const APP_TEAM_KEY = (appSnowflake: string): string => `discord.application_team.${appSnowflake}`;

const APP_EXTRAS_KEY = (snowflake: string): string => `discord.application_extras.${snowflake}`;

function getApplicationExtras(application: DiscordApplication, store: DiscordRouteContext["store"]): ApplicationExtras {
  return store.getData<ApplicationExtras>(APP_EXTRAS_KEY(application.snowflake)) ?? {};
}

function setApplicationExtras(application: DiscordApplication, store: DiscordRouteContext["store"], extras: ApplicationExtras): void {
  store.setData<ApplicationExtras>(APP_EXTRAS_KEY(application.snowflake), extras);
}

// Application Event Webhook Status: `1` (default) means disabled.
const EVENT_WEBHOOK_STATUS_DISABLED = 1;

// Application Flags. Only the "limited" intent flags may be updated via the API
// (GATEWAY_PRESENCE_LIMITED, GATEWAY_GUILD_MEMBERS_LIMITED, GATEWAY_MESSAGE_CONTENT_LIMITED).
const GATEWAY_PRESENCE_LIMITED = 1 << 13;
const GATEWAY_GUILD_MEMBERS_LIMITED = 1 << 15;
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;
const EDITABLE_FLAGS_MASK = GATEWAY_PRESENCE_LIMITED | GATEWAY_GUILD_MEMBERS_LIMITED | GATEWAY_MESSAGE_CONTENT_LIMITED;

function toAPIApplication(
  application: DiscordApplication,
  ds: ReturnType<typeof getDiscordStore>,
  store: DiscordRouteContext["store"],
): Record<string, unknown> {
  const botUser = ds.users.findOneBy("snowflake", application.bot_user_snowflake);
  const owner =
    (application.owner_snowflake && ds.users.findOneBy("snowflake", application.owner_snowflake)) ||
    ds.users.all().find((u) => !u.bot) ||
    botUser;
  const extras = getApplicationExtras(application, store);
  // Approximate count of guilds the bot user is a member of.
  const approximateGuildCount = botUser
    ? ds.members.findBy("user_snowflake", botUser.snowflake).length
    : 0;
  // Team is null when the application is not owned by a team. A team can be configured for
  // testing by writing a TeamData value to the store side-channel via APP_TEAM_KEY.
  const team = store.getData<TeamData>(APP_TEAM_KEY(application.snowflake)) ?? null;
  return {
    id: application.snowflake,
    name: application.name,
    icon: application.icon,
    description: application.description,
    rpc_origins: [],
    bot_public: true,
    bot_require_code_grant: false,
    bot: botUser ? toAPIUser(botUser) : undefined,
    terms_of_service_url: undefined,
    privacy_policy_url: undefined,
    owner: owner ? toAPIUser(owner) : null,
    verify_key: application.verify_key,
    team,
    flags: application.flags,
    approximate_guild_count: approximateGuildCount,
    redirect_uris: [],
    interactions_endpoint_url: application.interactions_endpoint_url ?? null,
    role_connections_verification_url: extras.role_connections_verification_url ?? null,
    event_webhooks_url: extras.event_webhooks_url ?? null,
    event_webhooks_status: extras.event_webhooks_status ?? EVENT_WEBHOOK_STATUS_DISABLED,
    event_webhooks_types: extras.event_webhooks_types ?? [],
    tags: extras.tags ?? [],
    install_params: extras.install_params,
    integration_types_config: extras.integration_types_config ?? { "0": {} },
    custom_install_url: extras.custom_install_url,
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
    return c.json(toAPIApplication(appRecord, ds, store));
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
    if (body.interactions_endpoint_url !== undefined) {
      const url = body.interactions_endpoint_url as string | null;
      // Setting a non-empty URL triggers Discord's PING/PONG verification, gated behind a flag
      // (default off) so it stays deterministic regardless of the sandbox's network policy.
      if (url && store.getData<boolean>("discord.validate_interactions_endpoint") === true) {
        const result = await validateInteractionsEndpoint(url, appRecord);
        if (result.reachable && !result.ok) {
          return discordError(c, 400, "Invalid Form Body", 50035, {
            errors: {
              interactions_endpoint_url: {
                _errors: [{ code: "INTERACTIONS_ENDPOINT_URL_VALIDATION", message: "The specified interactions endpoint URL could not be verified." }],
              },
            },
          });
        }
      }
      patch.interactions_endpoint_url = url;
    }
    if (body.icon !== undefined) patch.icon = body.icon as string | null;
    if (body.flags !== undefined) {
      // Only the limited intent flags can be updated via the API; mask out everything else.
      patch.flags = (body.flags as number) & EDITABLE_FLAGS_MASK;
    }
    if (body.name !== undefined) patch.name = body.name as string;

    // Editable properties without a dedicated entity column live in the store side-channel.
    const extras = getApplicationExtras(appRecord, store);
    if (body.custom_install_url !== undefined) extras.custom_install_url = body.custom_install_url as string;
    if (body.role_connections_verification_url !== undefined)
      extras.role_connections_verification_url = body.role_connections_verification_url as string | null;
    if (body.install_params !== undefined) extras.install_params = body.install_params;
    if (body.integration_types_config !== undefined)
      extras.integration_types_config = body.integration_types_config as Record<string, unknown>;
    if (body.tags !== undefined) extras.tags = body.tags as string[];
    if (body.event_webhooks_url !== undefined) extras.event_webhooks_url = body.event_webhooks_url as string | null;
    if (body.event_webhooks_status !== undefined) extras.event_webhooks_status = body.event_webhooks_status as number;
    if (body.event_webhooks_types !== undefined) extras.event_webhooks_types = body.event_webhooks_types as string[];
    setApplicationExtras(appRecord, store, extras);

    ds.applications.update(appRecord.id, patch);
    const updated = ds.applications.findOneBy("snowflake", appRecord.snowflake)!;
    return c.json(toAPIApplication(updated, ds, store));
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
