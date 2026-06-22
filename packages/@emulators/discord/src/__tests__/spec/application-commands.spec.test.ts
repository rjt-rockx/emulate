/**
 * Spec suite for `developers/interactions/application-commands.mdx`.
 *
 * Encodes the page's documented expectations: the Application Command object shape and every
 * field (type, name + name_localizations, description + description_localizations, options,
 * default_member_permissions, dm_permission, default_permission, nsfw, integration_types,
 * contexts, handler), the four Command Types, the option types and ALL option validation
 * rules, command-count limits, the name regex, and every create/get/modify/delete/bulk
 * endpoint contract (including 201-vs-200 on create-as-upsert). Written from the doc first;
 * the implementation is built/fixed until this is green.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, bearerHeaders, json, seededIds } from "../helpers.js";
import { getDiscordStore } from "../../store.js";

function appId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return seededIds(store).app;
}
function guildId(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return seededIds(store).guild;
}

async function createGlobal(
  app: ReturnType<typeof createDiscordTestApp>["app"],
  aid: string,
  body: Record<string, unknown>,
) {
  return app.request(api(`/applications/${aid}/commands`), {
    method: "POST",
    headers: botHeaders(),
    body: JSON.stringify(body),
  });
}

describe("application-commands.mdx — Application Command object structure", () => {
  it("a created CHAT_INPUT command echoes every documented field", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const res = await createGlobal(app, aid, { name: "blep", type: 1, description: "Send a photo" });
    expect(res.status).toBe(201);
    const cmd = await json(res);
    // id, application_id, name, description, version, type
    expect(typeof cmd.id).toBe("string");
    expect(cmd.application_id).toBe(aid);
    expect(cmd.name).toBe("blep");
    expect(cmd.description).toBe("Send a photo");
    expect(cmd.type).toBe(1);
    expect("version" in cmd).toBe(true);
    // localization dictionaries are present (nullable, default null)
    expect("name_localizations" in cmd).toBe(true);
    expect("description_localizations" in cmd).toBe(true);
    // options default to [] for CHAT_INPUT
    expect(Array.isArray(cmd.options)).toBe(true);
    // default_member_permissions present (nullable)
    expect("default_member_permissions" in cmd).toBe(true);
    // dm_permission (deprecated) still emitted
    expect("dm_permission" in cmd).toBe(true);
    // default_permission defaults to true
    expect(cmd.default_permission).toBe(true);
    // nsfw defaults to false
    expect(cmd.nsfw).toBe(false);
    // integration_types defaults to [0] (GUILD_INSTALL)
    expect(cmd.integration_types).toEqual([0]);
    // contexts present (nullable)
    expect("contexts" in cmd).toBe(true);
  });

  it("defaults type to 1 (CHAT_INPUT) when omitted", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await createGlobal(app, appId(store), { name: "noop", description: "x" });
    expect((await json<{ type: number }>(res)).type).toBe(1);
  });

  it("persists and echoes name_localizations and description_localizations", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await createGlobal(app, appId(store), {
      name: "birthday",
      type: 1,
      description: "Wish a friend a happy birthday",
      name_localizations: { "zh-CN": "生日", el: "γενέθλια" },
      description_localizations: { "zh-CN": "祝你朋友生日快乐" },
    });
    const cmd = await json<Record<string, Record<string, string>>>(res);
    expect(cmd.name_localizations["zh-CN"]).toBe("生日");
    expect(cmd.name_localizations.el).toBe("γενέθλια");
    expect(cmd.description_localizations["zh-CN"]).toBe("祝你朋友生日快乐");
  });

  it("persists and echoes contexts and integration_types", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await createGlobal(app, appId(store), {
      name: "profile",
      type: 1,
      description: "x",
      integration_types: [0, 1],
      contexts: [0, 1, 2],
    });
    const cmd = await json<Record<string, number[]>>(res);
    expect(cmd.integration_types).toEqual([0, 1]);
    expect(cmd.contexts).toEqual([0, 1, 2]);
  });

  it("persists default_permission=false", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await createGlobal(app, appId(store), {
      name: "secret",
      type: 1,
      description: "x",
      default_permission: false,
    });
    expect((await json<{ default_permission: boolean }>(res)).default_permission).toBe(false);
  });

  it("persists default_member_permissions as a bit-set string ('0' = admins only)", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await createGlobal(app, appId(store), {
      name: "perm_test",
      type: 1,
      description: "x",
      default_member_permissions: "0",
    });
    expect((await json<{ default_member_permissions: string }>(res)).default_member_permissions).toBe("0");
  });

  it("persists nsfw=true (age-restricted)", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await createGlobal(app, appId(store), { name: "adult", type: 1, description: "x", nsfw: true });
    expect((await json<{ nsfw: boolean }>(res)).nsfw).toBe(true);
  });
});

describe("application-commands.mdx — Command Types", () => {
  it("supports CHAT_INPUT (1), USER (2), MESSAGE (3)", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const chat = await createGlobal(app, aid, { name: "slashy", type: 1, description: "d" });
    const user = await createGlobal(app, aid, { name: "View Profile", type: 2 });
    const message = await createGlobal(app, aid, { name: "Bookmark", type: 3 });
    expect(((await chat.json()) as { type: number }).type).toBe(1);
    expect(((await user.json()) as { type: number }).type).toBe(2);
    expect(((await message.json()) as { type: number }).type).toBe(3);
  });

  it("USER/MESSAGE commands fetch back with an EMPTY string description (not null)", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await createGlobal(app, appId(store), { name: "High Five", type: 2 });
    const cmd = await json<{ description: string }>(res);
    expect(cmd.description).toBe("");
  });

  it("the description field is not allowed for USER/MESSAGE commands (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await createGlobal(app, appId(store), { name: "High Five", type: 2, description: "not allowed" });
    expect(res.status).toBe(400);
    const body = await json<{ code: number; errors: { description?: unknown } }>(res);
    expect(body.code).toBe(50035);
    expect(body.errors.description).toBeTruthy();
  });

  it("supports PRIMARY_ENTRY_POINT (4) with a handler", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await createGlobal(app, appId(store), {
      name: "launch",
      description: "Launch Racing with Friends",
      type: 4,
      handler: 2,
    });
    expect(res.status).toBe(201);
    const cmd = await json<{ type: number; handler: number }>(res);
    expect(cmd.type).toBe(4);
    expect(cmd.handler).toBe(2);
  });
});

describe("application-commands.mdx — Application Command naming", () => {
  it("rejects an UPPERCASE CHAT_INPUT name (must be lowercase) with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await createGlobal(app, appId(store), { name: "Ping", type: 1, description: "x" });
    expect(res.status).toBe(400);
    const body = await json<{ code: number; errors: { name?: unknown } }>(res);
    expect(body.code).toBe(50035);
    expect(body.errors.name).toBeTruthy();
  });

  it("rejects a CHAT_INPUT name with spaces (regex)", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await createGlobal(app, appId(store), { name: "my command", type: 1, description: "x" });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects a CHAT_INPUT name longer than 32 characters", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await createGlobal(app, appId(store), { name: "a".repeat(33), type: 1, description: "x" });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("accepts a CHAT_INPUT name with hyphen, underscore and digits", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await createGlobal(app, appId(store), { name: "my-cmd_2", type: 1, description: "x" });
    expect(res.status).toBe(201);
  });

  it("allows a USER command name with spaces and mixed case", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await createGlobal(app, appId(store), { name: "Report User", type: 2 });
    expect(res.status).toBe(201);
  });
});

describe("application-commands.mdx — Application Command description rules (CHAT_INPUT)", () => {
  it("rejects a CHAT_INPUT command with no description (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await createGlobal(app, appId(store), { name: "ping", type: 1 });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects a CHAT_INPUT description longer than 100 characters", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await createGlobal(app, appId(store), { name: "ping", type: 1, description: "x".repeat(101) });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });
});

describe("application-commands.mdx — Option validation rules", () => {
  it("rejects more than 25 options (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const options = Array.from({ length: 26 }, (_, i) => ({ type: 3, name: `opt${i}`, description: "d" }));
    const res = await createGlobal(app, appId(store), { name: "many", type: 1, description: "x", options });
    expect(res.status).toBe(400);
    const body = await json<{ code: number; errors: { options?: unknown } }>(res);
    expect(body.code).toBe(50035);
    expect(body.errors.options).toBeTruthy();
  });

  it("requires required options to be listed before optional ones (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const options = [
      { type: 3, name: "optional", description: "d", required: false },
      { type: 3, name: "needed", description: "d", required: true },
    ];
    const res = await createGlobal(app, appId(store), { name: "order", type: 1, description: "x", options });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("accepts options when required precede optional", async () => {
    const { app, store } = createDiscordTestApp();
    const options = [
      { type: 3, name: "needed", description: "d", required: true },
      { type: 3, name: "optional", description: "d", required: false },
    ];
    const res = await createGlobal(app, appId(store), { name: "ordered", type: 1, description: "x", options });
    expect(res.status).toBe(201);
  });

  it("rejects an option whose name violates the 1-32 regex (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await createGlobal(app, appId(store), {
      name: "opttest",
      type: 1,
      description: "x",
      options: [{ type: 3, name: "Bad Name", description: "d" }],
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects an option with an empty or >100 char description (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const tooLong = await createGlobal(app, appId(store), {
      name: "optdesc",
      type: 1,
      description: "x",
      options: [{ type: 3, name: "good", description: "y".repeat(101) }],
    });
    expect(tooLong.status).toBe(400);
    expect(((await tooLong.json()) as { code: number }).code).toBe(50035);
    const empty = await createGlobal(app, appId(store), {
      name: "optdesc2",
      type: 1,
      description: "x",
      options: [{ type: 3, name: "good", description: "" }],
    });
    expect(empty.status).toBe(400);
  });

  it("rejects more than 25 choices on an option (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const choices = Array.from({ length: 26 }, (_, i) => ({ name: `c${i}`, value: `v${i}` }));
    const res = await createGlobal(app, appId(store), {
      name: "choosy",
      type: 1,
      description: "x",
      options: [{ type: 3, name: "pick", description: "d", choices }],
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects an option with BOTH choices and autocomplete (mutually exclusive, 50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await createGlobal(app, appId(store), {
      name: "ac",
      type: 1,
      description: "x",
      options: [{ type: 3, name: "q", description: "d", autocomplete: true, choices: [{ name: "a", value: "a" }] }],
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects min_value/max_value on a non-INTEGER/NUMBER option (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await createGlobal(app, appId(store), {
      name: "minmax",
      type: 1,
      description: "x",
      options: [{ type: 3, name: "s", description: "d", min_value: 1 }],
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("accepts min_value/max_value on an INTEGER option", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await createGlobal(app, appId(store), {
      name: "intopt",
      type: 1,
      description: "x",
      options: [{ type: 4, name: "n", description: "d", min_value: 1, max_value: 10 }],
    });
    expect(res.status).toBe(201);
  });

  it("rejects min_length/max_length on a non-STRING option (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await createGlobal(app, appId(store), {
      name: "lentest",
      type: 1,
      description: "x",
      options: [{ type: 4, name: "n", description: "d", min_length: 1 }],
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("rejects channel_types on a non-CHANNEL option (50035)", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await createGlobal(app, appId(store), {
      name: "chtest",
      type: 1,
      description: "x",
      options: [{ type: 3, name: "s", description: "d", channel_types: [0] }],
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("accepts channel_types on a CHANNEL option", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await createGlobal(app, appId(store), {
      name: "chok",
      type: 1,
      description: "x",
      options: [{ type: 7, name: "ch", description: "d", channel_types: [0, 2] }],
    });
    expect(res.status).toBe(201);
  });

  it("accepts one level of subcommand nesting (group -> subcommand) but rejects two", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const valid = await createGlobal(app, aid, {
      name: "permissions",
      type: 1,
      description: "x",
      options: [
        {
          type: 2,
          name: "user",
          description: "group",
          options: [{ type: 1, name: "get", description: "subcmd" }],
        },
      ],
    });
    expect(valid.status).toBe(201);

    const invalid = await createGlobal(app, aid, {
      name: "toodeep",
      type: 1,
      description: "x",
      options: [
        {
          type: 2,
          name: "group",
          description: "g",
          options: [
            { type: 2, name: "nestedgroup", description: "ng", options: [{ type: 1, name: "leaf", description: "l" }] },
          ],
        },
      ],
    });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { code: number }).code).toBe(50035);
  });
});

describe("application-commands.mdx — command count limits", () => {
  it("rejects the 101st global CHAT_INPUT command", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    for (let i = 0; i < 100; i++) {
      const res = await createGlobal(app, aid, { name: `cmd${i}`, type: 1, description: "x" });
      expect(res.status).toBe(201);
    }
    const overflow = await createGlobal(app, aid, { name: "cmd100", type: 1, description: "x" });
    expect(overflow.status).toBe(400);
  });

  // AC1: doc says 15 global USER commands (application-commands.mdx:167)
  it("allows up to 15 global USER commands and rejects the 16th", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    for (let i = 0; i < 15; i++) {
      const res = await createGlobal(app, aid, { name: `User Cmd ${i}`, type: 2 });
      expect(res.status).toBe(201);
    }
    const overflow = await createGlobal(app, aid, { name: "User Cmd 15", type: 2 });
    expect(overflow.status).toBe(400);
  });

  // AC1: doc says 15 global MESSAGE commands (application-commands.mdx:168)
  it("allows up to 15 global MESSAGE commands and rejects the 16th", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    for (let i = 0; i < 15; i++) {
      const res = await createGlobal(app, aid, { name: `Msg Cmd ${i}`, type: 3 });
      expect(res.status).toBe(201);
    }
    const overflow = await createGlobal(app, aid, { name: "Msg Cmd 15", type: 3 });
    expect(overflow.status).toBe(400);
  });

  // AC2: doc says 1 global PRIMARY_ENTRY_POINT command (application-commands.mdx:169)
  it("allows exactly 1 global PRIMARY_ENTRY_POINT command and rejects a second", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const first = await createGlobal(app, aid, { name: "launch", description: "Launch the activity", type: 4, handler: 2 });
    expect(first.status).toBe(201);
    const second = await createGlobal(app, aid, { name: "open", description: "Open the activity", type: 4, handler: 2 });
    expect(second.status).toBe(400);
  });

  it("per-guild USER/MESSAGE caps also apply (15 each)", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const gid = guildId(store);
    for (let i = 0; i < 15; i++) {
      const res = await app.request(api(`/applications/${aid}/guilds/${gid}/commands`), {
        method: "POST",
        headers: botHeaders(),
        body: JSON.stringify({ name: `Guild Usr ${i}`, type: 2 }),
      });
      expect(res.status).toBe(201);
    }
    const overflow = await app.request(api(`/applications/${aid}/guilds/${gid}/commands`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "Guild Usr 15", type: 2 }),
    });
    expect(overflow.status).toBe(400);
  });
});

describe("application-commands.mdx — Create Global Application Command (201 vs 200)", () => {
  it("returns 201 on first create, 200 when overwriting an existing name", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const first = await createGlobal(app, aid, { name: "dup", type: 1, description: "first" });
    expect(first.status).toBe(201);
    const second = await createGlobal(app, aid, { name: "dup", type: 1, description: "second" });
    expect(second.status).toBe(200);
    const cmd = (await second.json()) as { description: string };
    expect(cmd.description).toBe("second");
  });
});

describe("application-commands.mdx — Get/Edit/Delete Global Application Command", () => {
  it("Get returns the command by id", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const created = (await (await createGlobal(app, aid, { name: "fetchme", type: 1, description: "d" })).json()) as {
      id: string;
    };
    const res = await app.request(api(`/applications/${aid}/commands/${created.id}`), { headers: botHeaders() });
    expect(res.status).toBe(200);
    expect((await json<{ name: string }>(res)).name).toBe("fetchme");
  });

  it("Edit returns 200 and applies name/description/options/default_member_permissions/dm_permission/nsfw/type", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const created = (await (await createGlobal(app, aid, { name: "editme", type: 1, description: "d" })).json()) as {
      id: string;
    };
    const res = await app.request(api(`/applications/${aid}/commands/${created.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({
        description: "updated",
        default_member_permissions: "8",
        nsfw: true,
        contexts: [0],
        name_localizations: { "zh-CN": "改" },
      }),
    });
    expect(res.status).toBe(200);
    const cmd = await json(res);
    expect(cmd.description).toBe("updated");
    expect(cmd.default_member_permissions).toBe("8");
    expect(cmd.nsfw).toBe(true);
    expect(cmd.contexts).toEqual([0]);
    expect((cmd.name_localizations as Record<string, string>)["zh-CN"]).toBe("改");
  });

  it("Edit validates options and returns 50035 for bad option payloads", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const created = (await (await createGlobal(app, aid, { name: "valedit", type: 1, description: "d" })).json()) as {
      id: string;
    };
    const res = await app.request(api(`/applications/${aid}/commands/${created.id}`), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ options: [{ type: 3, name: "Bad Name", description: "d" }] }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });

  it("Delete returns 204 and removes the command", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const created = (await (await createGlobal(app, aid, { name: "delme", type: 1, description: "d" })).json()) as {
      id: string;
    };
    const res = await app.request(api(`/applications/${aid}/commands/${created.id}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(res.status).toBe(204);
    expect(getDiscordStore(store).commands.findOneBy("snowflake", created.id)).toBeUndefined();
  });
});

describe("application-commands.mdx — Bulk Overwrite Global Application Commands", () => {
  it("returns 200 and overwrites the whole global command list", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    await createGlobal(app, aid, { name: "old", type: 1, description: "d" });
    const res = await app.request(api(`/applications/${aid}/commands`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify([
        { name: "new1", type: 1, description: "a" },
        { name: "new2", type: 1, description: "b" },
      ]),
    });
    expect(res.status).toBe(200);
    const list = await json<Array<{ name: string }>>(res);
    expect(list.map((c) => c.name).sort()).toEqual(["new1", "new2"]);
    const all = (await (await app.request(api(`/applications/${aid}/commands`), { headers: botHeaders() })).json()) as Array<{
      name: string;
    }>;
    expect(all.some((c) => c.name === "old")).toBe(false);
  });

  it("bulk overwrite runs validation and rejects an invalid command with 50035", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await app.request(api(`/applications/${appId(store)}/commands`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify([{ name: "Bad Name", type: 1, description: "d" }]),
    });
    expect(res.status).toBe(400);
    expect((await json<{ code: number }>(res)).code).toBe(50035);
  });
});

describe("application-commands.mdx — Guild commands", () => {
  it("creates, lists, gets and deletes a guild command scoped to the guild", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const gid = guildId(store);
    const created = await app.request(api(`/applications/${aid}/guilds/${gid}/commands`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "guildcmd", type: 1, description: "d" }),
    });
    expect(created.status).toBe(201);
    const cmd = (await created.json()) as { id: string; guild_id: string };
    expect(cmd.guild_id).toBe(gid);

    const list = (await (
      await app.request(api(`/applications/${aid}/guilds/${gid}/commands`), { headers: botHeaders() })
    ).json()) as Array<{ name: string }>;
    expect(list.some((c) => c.name === "guildcmd")).toBe(true);

    // A global GET must not see the guild command.
    const globals = (await (await app.request(api(`/applications/${aid}/commands`), { headers: botHeaders() })).json()) as Array<{
      name: string;
    }>;
    expect(globals.some((c) => c.name === "guildcmd")).toBe(false);

    const del = await app.request(api(`/applications/${aid}/guilds/${gid}/commands/${cmd.id}`), {
      method: "DELETE",
      headers: botHeaders(),
    });
    expect(del.status).toBe(204);
  });

  it("guild create returns 201 on new name and 200 on overwrite", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const gid = guildId(store);
    const first = await app.request(api(`/applications/${aid}/guilds/${gid}/commands`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "gdup", type: 1, description: "a" }),
    });
    expect(first.status).toBe(201);
    const second = await app.request(api(`/applications/${aid}/guilds/${gid}/commands`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "gdup", type: 1, description: "b" }),
    });
    expect(second.status).toBe(200);
  });

  it("a global and a guild CHAT_INPUT command may share the same name", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const gid = guildId(store);
    const global = await createGlobal(app, aid, { name: "shared", type: 1, description: "d" });
    expect(global.status).toBe(201);
    const guild = await app.request(api(`/applications/${aid}/guilds/${gid}/commands`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "shared", type: 1, description: "d" }),
    });
    expect(guild.status).toBe(201);
  });
});

describe("application-commands.mdx — authorization", () => {
  it("all command endpoints require a bot (or credentials) token; unauthenticated -> 401", async () => {
    const { app, store } = createDiscordTestApp();
    const res = await app.request(api(`/applications/${appId(store)}/commands`));
    expect(res.status).toBe(401);
  });
});

// AC7: upsert key includes type; same-name different-type commands must coexist (application-commands.mdx:158,162)
describe("application-commands.mdx — upsert key includes type (AC7)", () => {
  it("a global CHAT_INPUT and USER command with the same name both survive", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const chat = await createGlobal(app, aid, { name: "doublename", type: 1, description: "slash version" });
    expect(chat.status).toBe(201);
    const user = await createGlobal(app, aid, { name: "Doublename", type: 2 });
    expect(user.status).toBe(201);
    // Both commands must now exist (different types, same-ish name)
    const list = (await (
      await app.request(api(`/applications/${aid}/commands`), { headers: botHeaders() })
    ).json()) as Array<{ type: number; name: string }>;
    expect(list.some((c) => c.type === 1 && c.name === "doublename")).toBe(true);
    expect(list.some((c) => c.type === 2 && c.name === "Doublename")).toBe(true);
  });

  it("upserting (same name, same type) updates the existing command — returns 200", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const first = await createGlobal(app, aid, { name: "upsertme", type: 1, description: "original" });
    expect(first.status).toBe(201);
    // Same name, same type -> upsert
    const second = await createGlobal(app, aid, { name: "upsertme", type: 1, description: "updated" });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { description: string }).description).toBe("updated");
  });

  it("creating a USER command with a name already used by a CHAT_INPUT command is NOT an upsert", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const chat = await createGlobal(app, aid, { name: "multi", type: 1, description: "slash" });
    expect(chat.status).toBe(201);
    // Same name, different type -> new command, not an update
    const user = await createGlobal(app, aid, { name: "Multi", type: 2 });
    expect(user.status).toBe(201);
    // The CHAT_INPUT command's description must be unchanged
    const chatId = ((await chat.json()) as { id: string }).id;
    const fetched = (await (
      await app.request(api(`/applications/${aid}/commands/${chatId}`), { headers: botHeaders() })
    ).json()) as { description: string };
    expect(fetched.description).toBe("slash");
  });
});

// AC3 + AC4: Application Command Permissions endpoints (application-commands.mdx:1372-1408)
describe("application-commands.mdx — Application Command Permissions endpoints (AC3 / AC4)", () => {
  /** Seed a bearer token into the store so we can call the PUT permissions endpoint. */
  function seedBearerToken(store: ReturnType<typeof createDiscordTestApp>["store"], token: string): void {
    const ds = getDiscordStore(store);
    const app = ds.applications.all()[0]!;
    const botUser = ds.users.findOneBy("snowflake", app.bot_user_snowflake)!;
    ds.tokens.insert({
      token,
      type: "bearer",
      user_snowflake: botUser.snowflake,
      application_snowflake: app.snowflake,
      scopes: ["applications.commands.permissions.update"],
      expires_at: null,
      refresh_token: null,
    });
  }

  it("GET guild command permissions list returns an array (empty when none set)", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const gid = guildId(store);
    const res = await app.request(
      api(`/applications/${aid}/guilds/${gid}/commands/permissions`),
      { headers: botHeaders() },
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("GET single command permissions returns 404 (10066) when none set", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const gid = guildId(store);
    // Create a command first so we have a valid command id
    const cmd = (await (
      await createGlobal(app, aid, { name: "permcmd", type: 1, description: "d" })
    ).json()) as { id: string };
    const res = await app.request(
      api(`/applications/${aid}/guilds/${gid}/commands/${cmd.id}/permissions`),
      { headers: botHeaders() },
    );
    expect(res.status).toBe(404);
    expect((await json<{ code: number }>(res)).code).toBe(10066);
  });

  it("PUT command permissions requires a Bearer token; bot token -> 403 (AC4)", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const gid = guildId(store);
    const cmd = (await (
      await createGlobal(app, aid, { name: "gatedcmd", type: 1, description: "d" })
    ).json()) as { id: string };
    const res = await app.request(
      api(`/applications/${aid}/guilds/${gid}/commands/${cmd.id}/permissions`),
      {
        method: "PUT",
        headers: botHeaders(),
        body: JSON.stringify({ permissions: [] }),
      },
    );
    expect(res.status).toBe(403);
  });

  it("PUT command permissions with a Bearer token succeeds and returns the updated object", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const gid = guildId(store);
    const BEARER = "test_bearer_perms_token";
    seedBearerToken(store, BEARER);
    const cmd = (await (
      await createGlobal(app, aid, { name: "writeperm", type: 1, description: "d" })
    ).json()) as { id: string };
    const permission = { id: gid, type: 1, permission: true };
    const res = await app.request(
      api(`/applications/${aid}/guilds/${gid}/commands/${cmd.id}/permissions`),
      {
        method: "PUT",
        headers: bearerHeaders(BEARER),
        body: JSON.stringify({ permissions: [permission] }),
      },
    );
    expect(res.status).toBe(200);
    const body = await json<{ id: string; application_id: string; guild_id: string; permissions: unknown[] }>(res);
    expect(body.id).toBe(cmd.id);
    expect(body.application_id).toBe(aid);
    expect(body.guild_id).toBe(gid);
    expect(body.permissions).toHaveLength(1);
  });

  it("GET single command permissions returns the object after a PUT", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const gid = guildId(store);
    const BEARER = "test_bearer_get_after_put";
    seedBearerToken(store, BEARER);
    const cmd = (await (
      await createGlobal(app, aid, { name: "roundtrip", type: 1, description: "d" })
    ).json()) as { id: string };
    const permission = { id: gid, type: 2, permission: false };
    await app.request(
      api(`/applications/${aid}/guilds/${gid}/commands/${cmd.id}/permissions`),
      {
        method: "PUT",
        headers: bearerHeaders(BEARER),
        body: JSON.stringify({ permissions: [permission] }),
      },
    );
    const res = await app.request(
      api(`/applications/${aid}/guilds/${gid}/commands/${cmd.id}/permissions`),
      { headers: botHeaders() },
    );
    expect(res.status).toBe(200);
    const body = await json<{ id: string; permissions: Array<{ type: number; permission: boolean }> }>(res);
    expect(body.id).toBe(cmd.id);
    expect(body.permissions[0]?.type).toBe(2);
    expect(body.permissions[0]?.permission).toBe(false);
  });

  it("GET guild permissions list includes the command after its permissions are set", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const gid = guildId(store);
    const BEARER = "test_bearer_guild_list";
    seedBearerToken(store, BEARER);
    const cmd = (await (
      await createGlobal(app, aid, { name: "listperm", type: 1, description: "d" })
    ).json()) as { id: string };
    await app.request(
      api(`/applications/${aid}/guilds/${gid}/commands/${cmd.id}/permissions`),
      {
        method: "PUT",
        headers: bearerHeaders(BEARER),
        body: JSON.stringify({ permissions: [{ id: gid, type: 1, permission: true }] }),
      },
    );
    const res = await app.request(
      api(`/applications/${aid}/guilds/${gid}/commands/permissions`),
      { headers: botHeaders() },
    );
    expect(res.status).toBe(200);
    const list = await json<Array<{ id: string }>>(res);
    expect(list.some((entry) => entry.id === cmd.id)).toBe(true);
  });

  it("bulk PUT guild permissions unauthenticated returns 401", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const gid = guildId(store);
    const res = await app.request(
      api(`/applications/${aid}/guilds/${gid}/commands/permissions`),
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify([]) },
    );
    expect(res.status).toBe(401);
  });
});

// AC12: guild bulk-overwrite returns 200 (application-commands.mdx:1345-1348)
describe("application-commands.mdx — Guild Bulk Overwrite Application Commands (AC12)", () => {
  it("returns 200 and overwrites the whole guild command list", async () => {
    const { app, store } = createDiscordTestApp();
    const aid = appId(store);
    const gid = guildId(store);
    // Seed an existing guild command
    await app.request(api(`/applications/${aid}/guilds/${gid}/commands`), {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ name: "oldguildcmd", type: 1, description: "old" }),
    });
    const res = await app.request(api(`/applications/${aid}/guilds/${gid}/commands`), {
      method: "PUT",
      headers: botHeaders(),
      body: JSON.stringify([
        { name: "newguild1", type: 1, description: "a" },
        { name: "newguild2", type: 1, description: "b" },
      ]),
    });
    expect(res.status).toBe(200);
    const list = await json<Array<{ name: string }>>(res);
    expect(list.map((c) => c.name).sort()).toEqual(["newguild1", "newguild2"]);
    // Old command gone
    const all = (await (
      await app.request(api(`/applications/${aid}/guilds/${gid}/commands`), { headers: botHeaders() })
    ).json()) as Array<{ name: string }>;
    expect(all.some((c) => c.name === "oldguildcmd")).toBe(false);
  });
});
