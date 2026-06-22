import { randomBytes } from "node:crypto";
import {
  renderCardPage,
  renderErrorPage,
  renderUserButton,
  matchesRedirectUri,
  constantTimeSecretEqual,
  bodyStr,
  type Store,
  type Context,
  type AppEnv,
} from "@emulators/core";
import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";
import { getAuth, unauthorized, toAPIUser, toAPIGuild } from "../helpers.js";
import { createToken } from "../factories.js";

const CODE_TTL_MS = 10 * 60 * 1000;
const SERVICE = "Discord";

interface PendingCode {
  userId: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  createdAt: number;
}

function getPendingCodes(store: Store): Map<string, PendingCode> {
  let codes = store.getData<Map<string, PendingCode>>("discord.oauth.pendingCodes");
  if (!codes) {
    codes = new Map();
    store.setData("discord.oauth.pendingCodes", codes);
  }
  return codes;
}

export function oauthRoutes(ctx: DiscordRouteContext): void {
  const { app, store } = ctx;

  app.get("/oauth2/authorize", (c) => {
    const ds = getDiscordStore(store);
    const clientId = c.req.query("client_id") ?? "";
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const scope = c.req.query("scope") ?? "";
    const state = c.req.query("state") ?? "";

    const apps = ds.oauthApps.all();
    const oauthApp = clientId ? ds.oauthApps.findOneBy("client_id", clientId) : undefined;
    if (apps.length > 0 && !oauthApp) {
      return c.html(renderErrorPage("Invalid client", "Unknown client_id.", SERVICE), 400);
    }
    if (oauthApp && redirectUri && oauthApp.redirect_uris.length > 0 && !matchesRedirectUri(redirectUri, oauthApp.redirect_uris)) {
      return c.html(renderErrorPage("Invalid redirect", "redirect_uri mismatch.", SERVICE), 400);
    }

    const users = ds.users.all().filter((u) => !u.bot);
    const buttons = users
      .map((u) =>
        renderUserButton({
          letter: (u.username[0] ?? "?").toUpperCase(),
          login: u.username,
          name: u.global_name ?? u.username,
          email: u.email ?? undefined,
          formAction: "/oauth2/authorize/callback",
          hiddenFields: { client_id: clientId, redirect_uri: redirectUri, scope, state, user_id: u.snowflake },
        }),
      )
      .join("\n");
    return c.html(renderCardPage("Authorize with Discord", `Scopes: ${scope || "identify"}`, buttons, SERVICE));
  });

  app.post("/oauth2/authorize/callback", async (c) => {
    const form = await c.req.parseBody();
    const userId = bodyStr(form.user_id);
    const clientId = bodyStr(form.client_id);
    const redirectUri = bodyStr(form.redirect_uri);
    const scope = bodyStr(form.scope);
    const state = bodyStr(form.state);
    if (!redirectUri) return c.html(renderErrorPage("Missing redirect", "No redirect_uri.", SERVICE), 400);

    const code = randomBytes(20).toString("hex");
    getPendingCodes(store).set(code, { userId, clientId, redirectUri, scope, createdAt: Date.now() });
    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    return c.redirect(url.toString(), 302);
  });

  const tokenHandler = async (c: Context<AppEnv>): Promise<Response> => {
    const ds = getDiscordStore(store);
    const form = await c.req.parseBody();
    const grantType = bodyStr(form.grant_type);
    const clientId = bodyStr(form.client_id);
    const clientSecret = bodyStr(form.client_secret);
    const oauthApp = clientId ? ds.oauthApps.findOneBy("client_id", clientId) : undefined;

    if (oauthApp && clientSecret && !constantTimeSecretEqual(clientSecret, oauthApp.client_secret)) {
      return c.json({ error: "invalid_client" }, 401);
    }

    const application = oauthApp ? ds.applications.findOneBy("snowflake", oauthApp.application_snowflake) : ds.applications.all()[0];
    const issue = (userSnowflake: string, scope: string, opts: { refresh?: boolean } = {}) => {
      const withRefresh = opts.refresh !== false;
      const accessToken = `disc_at_${randomBytes(16).toString("hex")}`;
      const refreshToken = withRefresh ? `disc_rt_${randomBytes(16).toString("hex")}` : null;
      const scopes = scope.split(/[ ,]+/).filter(Boolean);
      createToken(ds, {
        token: accessToken,
        type: "bearer",
        userSnowflake,
        applicationSnowflake: application?.snowflake ?? null,
        scopes,
        expiresAt: new Date(Date.now() + 604800 * 1000).toISOString(),
        refreshToken,
      });
      const result: Record<string, unknown> = {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 604800,
        scope: scopes.join(" "),
      };
      // client_credentials does not issue a refresh token.
      if (withRefresh) result.refresh_token = refreshToken;
      if (scopes.includes("bot")) {
        const guild = ds.guilds.all()[0];
        if (guild) result.guild = toAPIGuild(guild, ds);
      }
      return c.json(result);
    };

    if (grantType === "authorization_code") {
      const code = bodyStr(form.code);
      const redirectUri = bodyStr(form.redirect_uri);
      const pending = getPendingCodes(store).get(code);
      if (!pending || Date.now() - pending.createdAt > CODE_TTL_MS) return c.json({ error: "invalid_grant" }, 400);
      if (clientId && pending.clientId && clientId !== pending.clientId) return c.json({ error: "invalid_client" }, 401);
      if (redirectUri && pending.redirectUri && redirectUri !== pending.redirectUri)
        return c.json({ error: "invalid_grant" }, 400);
      getPendingCodes(store).delete(code);
      return issue(pending.userId, pending.scope);
    }

    if (grantType === "client_credentials") {
      const botUser = application ? ds.users.findOneBy("snowflake", application.bot_user_snowflake) : ds.users.all()[0];
      return issue(botUser?.snowflake ?? "", bodyStr(form.scope), { refresh: false });
    }

    if (grantType === "refresh_token") {
      const refreshToken = bodyStr(form.refresh_token);
      const existing = ds.tokens.all().find((t) => t.type === "bearer" && t.refresh_token === refreshToken);
      if (!existing) return c.json({ error: "invalid_grant" }, 400);
      // Rotate: invalidate the old token pair and issue a fresh one with the same grant.
      ds.tokens.delete(existing.id);
      return issue(existing.user_snowflake, existing.scopes.join(" "));
    }

    return c.json({ error: "unsupported_grant_type" }, 400);
  };

  app.post("/api/oauth2/token", tokenHandler);
  app.post("/api/v:version/oauth2/token", tokenHandler);

  // Token revocation (RFC 7009): revoke an access or refresh token.
  const revokeHandler = async (c: Context<AppEnv>): Promise<Response> => {
    const ds = getDiscordStore(store);
    const form = await c.req.parseBody();
    const token = bodyStr(form.token);
    const rec = ds.tokens.findOneBy("token", token) ?? ds.tokens.all().find((t) => t.refresh_token === token);
    if (rec) ds.tokens.delete(rec.id);
    return c.json({});
  };
  app.post("/api/oauth2/token/revoke", revokeHandler);
  app.post("/api/v:version/oauth2/token/revoke", revokeHandler);

  app.get("/api/v:version/oauth2/@me", (c) => {
    const auth = getAuth(c, store);
    if (!auth) return unauthorized(c);
    const ds = getDiscordStore(store);
    const app0 = auth.application ?? ds.applications.all()[0];
    const tokenRecord = ds.tokens.findOneBy("token", auth.token);
    const result: Record<string, unknown> = {
      application: app0 ? { id: app0.snowflake, name: app0.name, verify_key: app0.verify_key, bot_public: true } : undefined,
      scopes: auth.scopes,
      expires: tokenRecord?.expires_at ?? new Date(Date.now() + 604800 * 1000).toISOString(),
    };
    // The user object is only included when the token was granted the `identify` scope.
    if (auth.user && auth.scopes.includes("identify")) {
      result.user = toAPIUser(auth.user, auth.scopes.includes("email"));
    }
    return c.json(result);
  });

  app.get("/api/v:version/oauth2/applications/@me", (c) => {
    const auth = getAuth(c, store);
    if (!auth || auth.type !== "bot") return unauthorized(c);
    const ds = getDiscordStore(store);
    const application = auth.application ?? ds.applications.all()[0];
    if (!application) return unauthorized(c);
    const botUser = ds.users.findOneBy("snowflake", application.bot_user_snowflake);
    const owner =
      (application.owner_snowflake && ds.users.findOneBy("snowflake", application.owner_snowflake)) ||
      ds.users.all().find((u) => !u.bot) ||
      botUser;
    return c.json({
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
    });
  });
}
