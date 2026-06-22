import { type Store } from "@emulators/core";
import { snowflake } from "./helpers.js";
import { getDiscordStore, type DiscordStore } from "./store.js";
import {
  createUser,
  createApplication,
  createToken,
  createGuild,
  createRole,
  createChannel,
  createEmoji,
  addGuildMember,
} from "./factories.js";

export interface DiscordSeedApplication {
  name?: string;
  bot_token?: string;
  bot_username?: string;
  public_key?: string;
  private_key?: string;
  interactions_endpoint_url?: string;
}

export interface DiscordSeedOAuthApp {
  client_id: string;
  client_secret: string;
  application?: string;
  name?: string;
  redirect_uris?: string[];
  scopes?: string[] | string;
}

export interface DiscordSeedUser {
  username: string;
  global_name?: string;
  discriminator?: string;
  email?: string;
  avatar?: string;
  bot?: boolean;
}

export interface DiscordSeedGuild {
  name: string;
  owner?: string;
  icon?: string;
  description?: string;
  roles?: Array<{ name: string; color?: number; permissions?: string; hoist?: boolean; mentionable?: boolean }>;
  channels?: Array<{ name: string; type?: number; topic?: string; parent?: string; nsfw?: boolean }>;
  members?: string[];
  emojis?: Array<{ name: string; animated?: boolean }>;
}

export interface DiscordSeedCommand {
  name: string;
  description?: string;
  type?: number;
  guild?: string;
  options?: unknown[];
}

export interface DiscordSeedToken {
  token: string;
  type?: "bot" | "bearer";
  user?: string;
  scopes?: string[] | string;
}

export interface DiscordSeedWebhook {
  channel: string;
  name?: string;
  guild?: string;
}

export interface DiscordSeedConfig {
  baseUrl?: string;
  port?: number;
  application?: DiscordSeedApplication;
  oauth_apps?: DiscordSeedOAuthApp[];
  users?: DiscordSeedUser[];
  guilds?: DiscordSeedGuild[];
  application_commands?: DiscordSeedCommand[];
  tokens?: DiscordSeedToken[];
  webhooks?: DiscordSeedWebhook[];
  strict_scopes?: boolean;
  /** Enforce Discord permissions on mutations (50013 when the bot lacks them). Default off. */
  enforce_permissions?: boolean;
  /** Verify an interactions endpoint with a PING/PONG when it is set. Default off. */
  validate_interactions_endpoint?: boolean;
}

const DEFAULT_BOT_TOKEN = "test_bot_token";

function asArray(v: string[] | string | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : v.split(/[ ,]+/).filter(Boolean);
}

function findUserByName(ds: DiscordStore, name: string) {
  return ds.users.findOneBy("username", name) ?? null;
}

/** Always-on defaults so `npx emulate --service discord` is useful with zero config. */
export function seedDefaults(store: Store, _baseUrl: string): void {
  const ds = getDiscordStore(store);
  if (ds.applications.all().length > 0) return;

  const developer = createUser(ds, { username: "developer", global_name: "Developer", email: "dev@example.com" });
  const { application, botUser } = createApplication(ds, { name: "Emulate App", botUsername: "emulate-bot" });
  createToken(ds, {
    token: DEFAULT_BOT_TOKEN,
    type: "bot",
    userSnowflake: botUser.snowflake,
    applicationSnowflake: application.snowflake,
  });

  const guild = createGuild(ds, { name: "Emulate Server", ownerSnowflake: developer.snowflake });
  addGuildMember(ds, guild.snowflake, botUser.snowflake);
  const category = createChannel(ds, { name: "Text Channels", type: 4, guildSnowflake: guild.snowflake });
  createChannel(ds, {
    name: "general",
    type: 0,
    guildSnowflake: guild.snowflake,
    parentSnowflake: category.snowflake,
    topic: "General discussion",
  });
  createChannel(ds, { name: "random", type: 0, guildSnowflake: guild.snowflake, parentSnowflake: category.snowflake });
  createChannel(ds, { name: "General", type: 2, guildSnowflake: guild.snowflake });

  store.setData("discord.strict_scopes", false);
}

export function seedFromConfig(store: Store, _baseUrl: string, config: DiscordSeedConfig): void {
  const ds = getDiscordStore(store);

  if (typeof config.enforce_permissions === "boolean") {
    store.setData("discord.enforce_permissions", config.enforce_permissions);
  }
  if (typeof config.validate_interactions_endpoint === "boolean") {
    store.setData("discord.validate_interactions_endpoint", config.validate_interactions_endpoint);
  }
  if (typeof config.strict_scopes === "boolean") {
    store.setData("discord.strict_scopes", config.strict_scopes);
  }

  // Application: reconfigure the default app created by seedDefaults.
  if (config.application) {
    const app = ds.applications.all()[0];
    if (app) {
      const patch: Record<string, unknown> = {};
      if (config.application.name) patch.name = config.application.name;
      if (config.application.public_key) patch.verify_key = config.application.public_key;
      if (config.application.private_key) patch.private_key = config.application.private_key;
      if (config.application.interactions_endpoint_url !== undefined)
        patch.interactions_endpoint_url = config.application.interactions_endpoint_url;
      ds.applications.update(app.id, patch);
      if (config.application.bot_username) {
        const bot = ds.users.findOneBy("snowflake", app.bot_user_snowflake);
        if (bot) ds.users.update(bot.id, { username: config.application.bot_username, global_name: config.application.bot_username });
      }
      if (config.application.bot_token) {
        const existing = ds.tokens.findOneBy("token", config.application.bot_token);
        if (!existing) {
          createToken(ds, {
            token: config.application.bot_token,
            type: "bot",
            userSnowflake: app.bot_user_snowflake,
            applicationSnowflake: app.snowflake,
          });
        }
      }
    }
  }

  // Users.
  for (const u of config.users ?? []) {
    if (findUserByName(ds, u.username)) continue;
    createUser(ds, {
      username: u.username,
      global_name: u.global_name ?? u.username,
      discriminator: u.discriminator,
      email: u.email ?? null,
      avatar: u.avatar ?? null,
      bot: u.bot ?? false,
    });
  }

  // OAuth apps.
  const defaultApp = ds.applications.all()[0];
  for (const o of config.oauth_apps ?? []) {
    if (ds.oauthApps.findOneBy("client_id", o.client_id)) continue;
    const linkedApp = o.application
      ? (ds.applications.findOneBy("name", o.application) ?? defaultApp)
      : defaultApp;
    ds.oauthApps.insert({
      client_id: o.client_id,
      client_secret: o.client_secret,
      application_snowflake: linkedApp?.snowflake ?? "",
      name: o.name ?? linkedApp?.name ?? "Discord App",
      redirect_uris: o.redirect_uris ?? [],
      scopes: asArray(o.scopes),
    });
  }

  // Guilds (the bot is auto-added so it appears in READY/GUILD_CREATE).
  const botUser = defaultApp ? ds.users.findOneBy("snowflake", defaultApp.bot_user_snowflake) : null;
  for (const g of config.guilds ?? []) {
    const owner = (g.owner && findUserByName(ds, g.owner)) || ds.users.all()[0];
    if (!owner) continue;
    const guild = createGuild(ds, {
      name: g.name,
      ownerSnowflake: owner.snowflake,
      icon: g.icon ?? null,
      description: g.description ?? null,
    });
    for (const r of g.roles ?? []) {
      createRole(ds, guild.snowflake, {
        name: r.name,
        color: r.color,
        permissions: r.permissions,
        hoist: r.hoist,
        mentionable: r.mentionable,
      });
    }
    const categories = new Map<string, string>();
    for (const ch of g.channels ?? []) {
      const parent = ch.parent ? categories.get(ch.parent) : undefined;
      const created = createChannel(ds, {
        name: ch.name,
        type: ch.type ?? 0,
        guildSnowflake: guild.snowflake,
        topic: ch.topic ?? null,
        nsfw: ch.nsfw ?? false,
        parentSnowflake: parent ?? null,
      });
      if ((ch.type ?? 0) === 4) categories.set(ch.name, created.snowflake);
    }
    for (const name of g.members ?? []) {
      const member = findUserByName(ds, name);
      if (member) addGuildMember(ds, guild.snowflake, member.snowflake);
    }
    for (const e of g.emojis ?? []) {
      createEmoji(ds, guild.snowflake, { name: e.name, animated: e.animated, creatorSnowflake: owner.snowflake });
    }
    if (botUser) addGuildMember(ds, guild.snowflake, botUser.snowflake);
  }

  // Application commands.
  for (const cmd of config.application_commands ?? []) {
    if (!defaultApp) break;
    const guild = cmd.guild ? ds.guilds.findOneBy("name", cmd.guild) : null;
    ds.commands.insert({
      snowflake: snowflake(),
      application_snowflake: defaultApp.snowflake,
      guild_snowflake: guild?.snowflake ?? null,
      type: cmd.type ?? 1,
      name: cmd.name,
      description: cmd.description ?? "",
      options: cmd.options ?? [],
      default_member_permissions: null,
      dm_permission: true,
      nsfw: false,
      version: snowflake(),
    });
  }

  // Tokens.
  for (const t of config.tokens ?? []) {
    if (ds.tokens.findOneBy("token", t.token)) continue;
    const user = t.user ? findUserByName(ds, t.user) : botUser;
    if (!user) continue;
    createToken(ds, {
      token: t.token,
      type: t.type ?? "bot",
      userSnowflake: user.snowflake,
      applicationSnowflake: defaultApp?.snowflake ?? null,
      scopes: asArray(t.scopes),
    });
  }

  // Webhooks.
  for (const w of config.webhooks ?? []) {
    const channel = ds.channels.all().find((c) => c.name === w.channel);
    if (!channel) continue;
    ds.webhooks.insert({
      snowflake: snowflake(),
      type: 1,
      guild_snowflake: channel.guild_snowflake,
      channel_snowflake: channel.snowflake,
      user_snowflake: botUser?.snowflake ?? null,
      name: w.name ?? "Webhook",
      avatar: null,
      token: `whk_${Math.random().toString(36).slice(2)}`,
      application_snowflake: defaultApp?.snowflake ?? null,
    });
  }
}
