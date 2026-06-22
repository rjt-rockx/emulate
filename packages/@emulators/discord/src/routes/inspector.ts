import type { InspectorTab } from "@emulators/core";
import { escapeAttr, escapeHtml, renderInspectorPage } from "@emulators/core";
import type { DiscordRouteContext } from "../context.js";
import { getDiscordStore } from "../store.js";

const SERVICE_LABEL = "Discord";

const INSPECTOR_TABS: InspectorTab[] = [
  { id: "guilds", label: "Guilds", href: "/?tab=guilds" },
  { id: "channels", label: "Channels", href: "/?tab=channels" },
  { id: "messages", label: "Messages", href: "/?tab=messages" },
  { id: "members", label: "Members", href: "/?tab=members" },
  { id: "tokens", label: "Application & Tokens", href: "/?tab=tokens" },
  { id: "gateway", label: "Gateway Sessions", href: "/?tab=gateway" },
];

type InspectorTabId = (typeof INSPECTOR_TABS)[number]["id"];

function renderSection(title: string, body: string): string {
  return `<section class="inspector-section">
  <h2>${escapeHtml(title)}</h2>
  ${body}
</section>`;
}

function renderTable(headers: string[], rows: string[][], empty: string): string {
  if (rows.length === 0) {
    return `<p class="inspector-empty">${escapeHtml(empty)}</p>`;
  }
  const headerHtml = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const rowsHtml = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("\n");
  return `<table class="inspector-table">
  <thead><tr>${headerHtml}</tr></thead>
  <tbody>
${rowsHtml}
  </tbody>
</table>`;
}

function badge(label: string, tone: "granted" | "requested" | "denied" = "requested"): string {
  return `<span class="badge badge-${tone}">${escapeHtml(label)}</span>`;
}

function channelTypeName(type: number): string {
  switch (type) {
    case 0: return "Text";
    case 1: return "DM";
    case 2: return "Voice";
    case 3: return "Group DM";
    case 4: return "Category";
    case 5: return "Announcement";
    case 10:
    case 11:
    case 12: return "Thread";
    case 13: return "Stage";
    case 15: return "Forum";
    default: return String(type);
  }
}

function intentsLabel(intents: number): string {
  if (intents === 0) return "none";
  const names: string[] = [];
  const map: [number, string][] = [
    [1 << 0, "Guilds"],
    [1 << 1, "GuildMembers"],
    [1 << 2, "GuildBans"],
    [1 << 3, "GuildEmojis"],
    [1 << 4, "GuildIntegrations"],
    [1 << 5, "GuildWebhooks"],
    [1 << 6, "GuildInvites"],
    [1 << 7, "GuildVoiceStates"],
    [1 << 8, "GuildPresences"],
    [1 << 9, "GuildMessages"],
    [1 << 10, "GuildMessageReactions"],
    [1 << 11, "GuildMessageTyping"],
    [1 << 12, "DirectMessages"],
    [1 << 13, "DirectMessageReactions"],
    [1 << 14, "DirectMessageTyping"],
    [1 << 15, "MessageContent"],
    [1 << 16, "GuildScheduledEvents"],
    [1 << 20, "AutoModerationConfig"],
    [1 << 21, "AutoModerationExec"],
  ];
  for (const [bit, name] of map) {
    if ((intents & bit) !== 0) names.push(name);
  }
  return names.length > 0 ? names.join(", ") : String(intents);
}

export function inspectorRoutes(ctx: DiscordRouteContext): void {
  const { app, store } = ctx;
  const ds = () => getDiscordStore(store);

  app.get("/", (c) => {
    const requestedTab = c.req.query("tab") ?? "guilds";
    const activeTab: InspectorTabId = INSPECTOR_TABS.some((t) => t.id === requestedTab)
      ? (requestedTab as InspectorTabId)
      : "guilds";

    const firstGuild = ds().guilds.all()[0];
    const title = firstGuild
      ? `${firstGuild.name} - Discord Inspector`
      : "Discord Inspector";

    const body =
      activeTab === "channels"
        ? renderChannelsTab()
        : activeTab === "messages"
          ? renderMessagesTab(c.req.query("channel") ?? "")
          : activeTab === "members"
            ? renderMembersTab()
            : activeTab === "tokens"
              ? renderTokensTab()
              : activeTab === "gateway"
                ? renderGatewayTab()
                : renderGuildsTab();

    return c.html(
      renderInspectorPage(title, INSPECTOR_TABS, activeTab, body, SERVICE_LABEL),
    );
  });

  function renderGuildsTab(): string {
    const guilds = ds().guilds.all();
    const rows = guilds.map((g) => {
      const owner = ds().users.findOneBy("snowflake", g.owner_snowflake);
      const ownerName = owner ? owner.username : g.owner_snowflake;
      const memberCount = g.member_snowflakes.length;
      const channelCount = ds().channels.findBy("guild_snowflake", g.snowflake).length;
      const roleCount = ds().roles.findBy("guild_snowflake", g.snowflake).length;
      return [
        escapeHtml(g.name),
        escapeHtml(g.snowflake),
        escapeHtml(ownerName),
        escapeHtml(String(memberCount)),
        escapeHtml(String(channelCount)),
        escapeHtml(String(roleCount)),
      ];
    });
    return renderSection(
      "Guilds",
      renderTable(
        ["Name", "ID", "Owner", "Members", "Channels", "Roles"],
        rows,
        "No guilds in the emulator store.",
      ),
    );
  }

  function renderChannelsTab(): string {
    const channels = ds().channels.all().sort((a, b) => a.position - b.position);
    const rows = channels.map((ch) => {
      const guild = ch.guild_snowflake
        ? ds().guilds.findOneBy("snowflake", ch.guild_snowflake)
        : null;
      return [
        escapeHtml(ch.name ?? ""),
        escapeHtml(channelTypeName(ch.type)),
        escapeHtml(guild ? guild.name : ch.guild_snowflake ?? "DM"),
      ];
    });
    return renderSection(
      "Channels",
      renderTable(
        ["Name", "Type", "Guild"],
        rows,
        "No channels in the emulator store.",
      ),
    );
  }

  function renderMessagesTab(requestedChannel: string): string {
    const channels = ds().channels.all().filter((ch) => ch.type === 0 || ch.type === 5);
    const activeChannel =
      channels.find((ch) => ch.snowflake === requestedChannel) ?? channels[0];

    if (!activeChannel) {
      return renderSection(
        "Messages",
        '<p class="inspector-empty">No text channels in the emulator store.</p>',
      );
    }

    const selectorRows = channels.map((ch) => {
      const guild = ch.guild_snowflake
        ? ds().guilds.findOneBy("snowflake", ch.guild_snowflake)
        : null;
      const isActive = ch.snowflake === activeChannel.snowflake;
      return [
        isActive ? badge("active", "granted") : "",
        `<a href="${escapeAttr(`/?tab=messages&channel=${encodeURIComponent(ch.snowflake)}`)}">${escapeHtml(`#${ch.name ?? ch.snowflake}`)}</a>`,
        escapeHtml(guild ? guild.name : ""),
      ];
    });

    const messages = ds()
      .messages.findBy("channel_snowflake", activeChannel.snowflake)
      .sort((a, b) => (b.snowflake > a.snowflake ? 1 : -1))
      .slice(0, 50);

    const messageRows = messages.map((msg) => {
      const author = ds().users.findOneBy("snowflake", msg.author_snowflake);
      const authorName = author ? author.username : msg.author_snowflake;
      const isBot = author?.bot ?? false;
      return [
        `${escapeHtml(authorName)}${isBot ? ` ${badge("bot", "granted")}` : ""}`,
        escapeHtml(msg.content),
        escapeHtml(msg.snowflake),
      ];
    });

    return [
      renderSection(
        "Channels",
        renderTable(
          ["", "Channel", "Guild"],
          selectorRows,
          "No text channels in the emulator store.",
        ),
      ),
      renderSection(
        `Messages in #${activeChannel.name ?? activeChannel.snowflake}`,
        renderTable(
          ["Author", "Content", "ID"],
          messageRows,
          "No messages yet.",
        ),
      ),
    ].join("\n");
  }

  function renderMembersTab(): string {
    const guilds = ds().guilds.all();
    const sections: string[] = [];

    for (const guild of guilds) {
      const members = ds().members.findBy("guild_snowflake", guild.snowflake);
      const rows = members.map((m) => {
        const user = ds().users.findOneBy("snowflake", m.user_snowflake);
        const username = user ? user.username : m.user_snowflake;
        const isBot = user?.bot ?? false;
        const roles = m.role_snowflakes
          .map((rs) => ds().roles.findOneBy("snowflake", rs)?.name ?? rs)
          .join(", ");
        return [
          `${escapeHtml(username)}${isBot ? ` ${badge("bot", "granted")}` : ""}`,
          escapeHtml(m.nick ?? ""),
          escapeHtml(m.user_snowflake),
          escapeHtml(roles),
          escapeHtml(m.joined_at),
        ];
      });
      sections.push(
        renderSection(
          `Members — ${guild.name}`,
          renderTable(
            ["Username", "Nickname", "ID", "Roles", "Joined"],
            rows,
            "No members in this guild.",
          ),
        ),
      );
    }

    if (sections.length === 0) {
      return renderSection("Members", '<p class="inspector-empty">No guilds in the emulator store.</p>');
    }
    return sections.join("\n");
  }

  function renderTokensTab(): string {
    const application = ds().applications.all()[0] ?? null;
    const botUser = application
      ? ds().users.findOneBy("snowflake", application.bot_user_snowflake) ?? null
      : null;

    const appInfo = application
      ? renderTable(
          ["Field", "Value"],
          [
            ["Application name", escapeHtml(application.name)],
            ["Bot user", escapeHtml(botUser ? botUser.username : application.bot_user_snowflake)],
            ["Application ID", escapeHtml(application.snowflake)],
            ["Ed25519 public key", escapeHtml(application.verify_key)],
          ],
          "",
        )
      : '<p class="inspector-empty">No application in the emulator store.</p>';

    const tokens = ds().tokens.all();
    const tokenRows = tokens.map((t) => {
      const user = ds().users.findOneBy("snowflake", t.user_snowflake);
      return [
        escapeHtml(t.token),
        badge(t.type, t.type === "bot" ? "granted" : "requested"),
        escapeHtml(user ? user.username : t.user_snowflake),
        escapeHtml(t.scopes.join(", ")),
        escapeHtml(t.expires_at ?? "never"),
      ];
    });

    return [
      renderSection("Application", appInfo),
      renderSection(
        "Tokens",
        renderTable(
          ["Token", "Type", "User", "Scopes", "Expires"],
          tokenRows,
          "No tokens have been seeded.",
        ),
      ),
    ].join("\n");
  }

  function renderGatewayTab(): string {
    const sessions = ds().gatewaySessions.all().sort((a, b) => {
      return b.connected_at > a.connected_at ? 1 : -1;
    });
    const rows = sessions.map((s) => {
      const bot = ds().users.findOneBy("snowflake", s.bot_user_snowflake);
      return [
        escapeHtml(s.session_id),
        escapeHtml(bot ? bot.username : s.bot_user_snowflake),
        escapeHtml(intentsLabel(s.intents)),
        escapeHtml(s.connected_at),
      ];
    });
    return renderSection(
      "Gateway Sessions",
      renderTable(
        ["Session ID", "Bot", "Intents", "Connected At"],
        rows,
        "No active gateway sessions.",
      ),
    );
  }
}
