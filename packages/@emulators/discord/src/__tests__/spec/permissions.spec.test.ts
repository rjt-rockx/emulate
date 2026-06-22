/**
 * Spec suite for `developers/topics/permissions.mdx`.
 *
 * Encodes:
 *   1. Every Bitwise Permission Flag value from the documentation table.
 *   2. The full permission computation algorithm (guild-level then channel overwrites).
 *   3. ADMINISTRATOR and guild-owner short-circuit semantics.
 *   4. @everyone role id == guild id invariant.
 *
 * Written from the doc first; if permissions.ts diverges from the algorithm or any
 * bit value is wrong this suite will fail and the fix must go in permissions.ts.
 */
import { describe, it, expect } from "vitest";
import { Store } from "@emulators/core";
import { getDiscordStore } from "../../store.js";
import { createUser, createGuild, createRole, addGuildMember, createChannel } from "../../factories.js";
import {
  computePermissions,
  computeGuildPermissions,
  hasPermission,
  PermissionFlags,
  ALL_PERMISSIONS,
} from "../../permissions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setup() {
  const store = new Store();
  const ds = getDiscordStore(store);
  const owner = createUser(ds, { username: "owner" });
  const member = createUser(ds, { username: "member" });
  const guild = createGuild(ds, { name: "TestGuild", ownerSnowflake: owner.snowflake });
  addGuildMember(ds, guild.snowflake, member.snowflake);
  const channel = createChannel(ds, { name: "general", type: 0, guildSnowflake: guild.snowflake });
  return { ds, store, owner, member, guild, channel };
}

// ---------------------------------------------------------------------------
// Section 1: Bitwise Permission Flags table
//
// Each permission name, its documented hex value, and the bit-shift form are all
// cross-checked here. The expected values come directly from the doc table.
// ---------------------------------------------------------------------------

describe("permissions.mdx -- Bitwise Permission Flags table", () => {
  it("CREATE_INSTANT_INVITE = 0x0000000000000001 (1 << 0)", () => {
    expect(PermissionFlags.CreateInstantInvite).toBe(0x0000000000000001n);
  });

  it("KICK_MEMBERS = 0x0000000000000002 (1 << 1)", () => {
    expect(PermissionFlags.KickMembers).toBe(0x0000000000000002n);
  });

  it("BAN_MEMBERS = 0x0000000000000004 (1 << 2)", () => {
    expect(PermissionFlags.BanMembers).toBe(0x0000000000000004n);
  });

  it("ADMINISTRATOR = 0x0000000000000008 (1 << 3)", () => {
    expect(PermissionFlags.Administrator).toBe(0x0000000000000008n);
  });

  it("MANAGE_CHANNELS = 0x0000000000000010 (1 << 4)", () => {
    expect(PermissionFlags.ManageChannels).toBe(0x0000000000000010n);
  });

  it("MANAGE_GUILD = 0x0000000000000020 (1 << 5)", () => {
    expect(PermissionFlags.ManageGuild).toBe(0x0000000000000020n);
  });

  it("ADD_REACTIONS = 0x0000000000000040 (1 << 6)", () => {
    expect(PermissionFlags.AddReactions).toBe(0x0000000000000040n);
  });

  it("VIEW_AUDIT_LOG = 0x0000000000000080 (1 << 7)", () => {
    expect(PermissionFlags.ViewAuditLog).toBe(0x0000000000000080n);
  });

  it("PRIORITY_SPEAKER = 0x0000000000000100 (1 << 8)", () => {
    expect(PermissionFlags.PrioritySpeaker).toBe(0x0000000000000100n);
  });

  it("STREAM = 0x0000000000000200 (1 << 9)", () => {
    expect(PermissionFlags.Stream).toBe(0x0000000000000200n);
  });

  it("VIEW_CHANNEL = 0x0000000000000400 (1 << 10)", () => {
    expect(PermissionFlags.ViewChannel).toBe(0x0000000000000400n);
  });

  it("SEND_MESSAGES = 0x0000000000000800 (1 << 11)", () => {
    expect(PermissionFlags.SendMessages).toBe(0x0000000000000800n);
  });

  it("SEND_TTS_MESSAGES = 0x0000000000001000 (1 << 12)", () => {
    expect(PermissionFlags.SendTtsMessages).toBe(0x0000000000001000n);
  });

  it("MANAGE_MESSAGES = 0x0000000000002000 (1 << 13)", () => {
    expect(PermissionFlags.ManageMessages).toBe(0x0000000000002000n);
  });

  it("EMBED_LINKS = 0x0000000000004000 (1 << 14)", () => {
    expect(PermissionFlags.EmbedLinks).toBe(0x0000000000004000n);
  });

  it("ATTACH_FILES = 0x0000000000008000 (1 << 15)", () => {
    expect(PermissionFlags.AttachFiles).toBe(0x0000000000008000n);
  });

  it("READ_MESSAGE_HISTORY = 0x0000000000010000 (1 << 16)", () => {
    expect(PermissionFlags.ReadMessageHistory).toBe(0x0000000000010000n);
  });

  it("MENTION_EVERYONE = 0x0000000000020000 (1 << 17)", () => {
    expect(PermissionFlags.MentionEveryone).toBe(0x0000000000020000n);
  });

  it("USE_EXTERNAL_EMOJIS = 0x0000000000040000 (1 << 18)", () => {
    expect(PermissionFlags.UseExternalEmojis).toBe(0x0000000000040000n);
  });

  it("VIEW_GUILD_INSIGHTS = 0x0000000000080000 (1 << 19)", () => {
    expect(PermissionFlags.ViewGuildInsights).toBe(0x0000000000080000n);
  });

  it("CONNECT = 0x0000000000100000 (1 << 20)", () => {
    expect(PermissionFlags.Connect).toBe(0x0000000000100000n);
  });

  it("SPEAK = 0x0000000000200000 (1 << 21)", () => {
    expect(PermissionFlags.Speak).toBe(0x0000000000200000n);
  });

  it("MUTE_MEMBERS = 0x0000000000400000 (1 << 22)", () => {
    expect(PermissionFlags.MuteMembers).toBe(0x0000000000400000n);
  });

  it("DEAFEN_MEMBERS = 0x0000000000800000 (1 << 23)", () => {
    expect(PermissionFlags.DeafenMembers).toBe(0x0000000000800000n);
  });

  it("MOVE_MEMBERS = 0x0000000001000000 (1 << 24)", () => {
    expect(PermissionFlags.MoveMembers).toBe(0x0000000001000000n);
  });

  it("USE_VAD = 0x0000000002000000 (1 << 25)", () => {
    expect(PermissionFlags.UseVad).toBe(0x0000000002000000n);
  });

  it("CHANGE_NICKNAME = 0x0000000004000000 (1 << 26)", () => {
    expect(PermissionFlags.ChangeNickname).toBe(0x0000000004000000n);
  });

  it("MANAGE_NICKNAMES = 0x0000000008000000 (1 << 27)", () => {
    expect(PermissionFlags.ManageNicknames).toBe(0x0000000008000000n);
  });

  it("MANAGE_ROLES = 0x0000000010000000 (1 << 28)", () => {
    expect(PermissionFlags.ManageRoles).toBe(0x0000000010000000n);
  });

  it("MANAGE_WEBHOOKS = 0x0000000020000000 (1 << 29)", () => {
    expect(PermissionFlags.ManageWebhooks).toBe(0x0000000020000000n);
  });

  it("MANAGE_GUILD_EXPRESSIONS = 0x0000000040000000 (1 << 30)", () => {
    expect(PermissionFlags.ManageGuildExpressions).toBe(0x0000000040000000n);
  });

  it("USE_APPLICATION_COMMANDS = 0x0000000080000000 (1 << 31)", () => {
    expect(PermissionFlags.UseApplicationCommands).toBe(0x0000000080000000n);
  });

  it("REQUEST_TO_SPEAK = 0x0000000100000000 (1 << 32)", () => {
    expect(PermissionFlags.RequestToSpeak).toBe(0x0000000100000000n);
  });

  it("MANAGE_EVENTS = 0x0000000200000000 (1 << 33)", () => {
    expect(PermissionFlags.ManageEvents).toBe(0x0000000200000000n);
  });

  it("MANAGE_THREADS = 0x0000000400000000 (1 << 34)", () => {
    expect(PermissionFlags.ManageThreads).toBe(0x0000000400000000n);
  });

  it("CREATE_PUBLIC_THREADS = 0x0000000800000000 (1 << 35)", () => {
    expect(PermissionFlags.CreatePublicThreads).toBe(0x0000000800000000n);
  });

  it("CREATE_PRIVATE_THREADS = 0x0000001000000000 (1 << 36)", () => {
    expect(PermissionFlags.CreatePrivateThreads).toBe(0x0000001000000000n);
  });

  it("USE_EXTERNAL_STICKERS = 0x0000002000000000 (1 << 37)", () => {
    expect(PermissionFlags.UseExternalStickers).toBe(0x0000002000000000n);
  });

  it("SEND_MESSAGES_IN_THREADS = 0x0000004000000000 (1 << 38)", () => {
    expect(PermissionFlags.SendMessagesInThreads).toBe(0x0000004000000000n);
  });

  it("USE_EMBEDDED_ACTIVITIES = 0x0000008000000000 (1 << 39)", () => {
    expect(PermissionFlags.UseEmbeddedActivities).toBe(0x0000008000000000n);
  });

  it("MODERATE_MEMBERS = 0x0000010000000000 (1 << 40)", () => {
    expect(PermissionFlags.ModerateMembers).toBe(0x0000010000000000n);
  });

  it("VIEW_CREATOR_MONETIZATION_ANALYTICS = 0x0000020000000000 (1 << 41)", () => {
    expect(PermissionFlags.ViewCreatorMonetizationAnalytics).toBe(0x0000020000000000n);
  });

  it("USE_SOUNDBOARD = 0x0000040000000000 (1 << 42)", () => {
    expect(PermissionFlags.UseSoundboard).toBe(0x0000040000000000n);
  });

  it("CREATE_GUILD_EXPRESSIONS = 0x0000080000000000 (1 << 43)", () => {
    expect(PermissionFlags.CreateGuildExpressions).toBe(0x0000080000000000n);
  });

  it("CREATE_EVENTS = 0x0000100000000000 (1 << 44)", () => {
    expect(PermissionFlags.CreateEvents).toBe(0x0000100000000000n);
  });

  it("USE_EXTERNAL_SOUNDS = 0x0000200000000000 (1 << 45)", () => {
    expect(PermissionFlags.UseExternalSounds).toBe(0x0000200000000000n);
  });

  it("SEND_VOICE_MESSAGES = 0x0000400000000000 (1 << 46)", () => {
    expect(PermissionFlags.SendVoiceMessages).toBe(0x0000400000000000n);
  });

  it("SET_VOICE_CHANNEL_STATUS = 0x0001000000000000 (1 << 48) -- note: bit 47 unassigned in doc", () => {
    expect(PermissionFlags.SetVoiceChannelStatus).toBe(0x0001000000000000n);
  });

  it("SEND_POLLS = 0x0002000000000000 (1 << 49)", () => {
    expect(PermissionFlags.SendPolls).toBe(0x0002000000000000n);
  });

  it("USE_EXTERNAL_APPS = 0x0004000000000000 (1 << 50)", () => {
    expect(PermissionFlags.UseExternalApps).toBe(0x0004000000000000n);
  });

  it("PIN_MESSAGES = 0x0008000000000000 (1 << 51)", () => {
    expect(PermissionFlags.PinMessages).toBe(0x0008000000000000n);
  });

  it("BYPASS_SLOWMODE = 0x0010000000000000 (1 << 52)", () => {
    expect(PermissionFlags.BypassSlowmode).toBe(0x0010000000000000n);
  });

  it("ALL_PERMISSIONS is the OR of all documented flags (serializes to decimal string)", () => {
    const expected =
      PermissionFlags.CreateInstantInvite |
      PermissionFlags.KickMembers |
      PermissionFlags.BanMembers |
      PermissionFlags.Administrator |
      PermissionFlags.ManageChannels |
      PermissionFlags.ManageGuild |
      PermissionFlags.AddReactions |
      PermissionFlags.ViewAuditLog |
      PermissionFlags.PrioritySpeaker |
      PermissionFlags.Stream |
      PermissionFlags.ViewChannel |
      PermissionFlags.SendMessages |
      PermissionFlags.SendTtsMessages |
      PermissionFlags.ManageMessages |
      PermissionFlags.EmbedLinks |
      PermissionFlags.AttachFiles |
      PermissionFlags.ReadMessageHistory |
      PermissionFlags.MentionEveryone |
      PermissionFlags.UseExternalEmojis |
      PermissionFlags.ViewGuildInsights |
      PermissionFlags.Connect |
      PermissionFlags.Speak |
      PermissionFlags.MuteMembers |
      PermissionFlags.DeafenMembers |
      PermissionFlags.MoveMembers |
      PermissionFlags.UseVad |
      PermissionFlags.ChangeNickname |
      PermissionFlags.ManageNicknames |
      PermissionFlags.ManageRoles |
      PermissionFlags.ManageWebhooks |
      PermissionFlags.ManageGuildExpressions |
      PermissionFlags.UseApplicationCommands |
      PermissionFlags.RequestToSpeak |
      PermissionFlags.ManageEvents |
      PermissionFlags.ManageThreads |
      PermissionFlags.CreatePublicThreads |
      PermissionFlags.CreatePrivateThreads |
      PermissionFlags.UseExternalStickers |
      PermissionFlags.SendMessagesInThreads |
      PermissionFlags.UseEmbeddedActivities |
      PermissionFlags.ModerateMembers |
      PermissionFlags.ViewCreatorMonetizationAnalytics |
      PermissionFlags.UseSoundboard |
      PermissionFlags.CreateGuildExpressions |
      PermissionFlags.CreateEvents |
      PermissionFlags.UseExternalSounds |
      PermissionFlags.SendVoiceMessages |
      PermissionFlags.SetVoiceChannelStatus |
      PermissionFlags.SendPolls |
      PermissionFlags.UseExternalApps |
      PermissionFlags.PinMessages |
      PermissionFlags.BypassSlowmode;
    expect(ALL_PERMISSIONS).toBe(expected);
    // Serialization: BigInt -> string (the Discord wire format for permissions).
    expect(ALL_PERMISSIONS.toString()).toBe(expected.toString());
  });
});

// ---------------------------------------------------------------------------
// Section 2: Guild-level permission computation (compute_base_permissions)
//
// Algorithm from the doc:
//   1. Guild owner returns ALL.
//   2. Start with @everyone role's permissions.
//   3. OR in each of the member's role permissions.
//   4. If ADMINISTRATOR is set, return ALL.
//   5. Return the accumulated base.
// ---------------------------------------------------------------------------

describe("permissions.mdx -- guild-level permission computation", () => {
  it("guild owner receives ALL_PERMISSIONS", () => {
    const { ds, owner, guild } = setup();
    expect(computeGuildPermissions(ds, owner.snowflake, guild.snowflake)).toBe(ALL_PERMISSIONS);
  });

  it("starts with @everyone base permissions (role id == guild id)", () => {
    const { ds, member, guild } = setup();
    // Set @everyone to only ViewChannel.
    const everyone = ds.roles.findOneBy("snowflake", guild.snowflake)!;
    ds.roles.update(everyone.id, { permissions: String(PermissionFlags.ViewChannel) });

    const perms = computeGuildPermissions(ds, member.snowflake, guild.snowflake);
    expect(perms & PermissionFlags.ViewChannel).toBe(PermissionFlags.ViewChannel);
    expect(perms & PermissionFlags.SendMessages).toBe(0n);
    expect(perms & PermissionFlags.KickMembers).toBe(0n);
  });

  it("ORs all assigned role permissions into the base", () => {
    const { ds, member, guild } = setup();
    const everyone = ds.roles.findOneBy("snowflake", guild.snowflake)!;
    ds.roles.update(everyone.id, { permissions: String(PermissionFlags.ViewChannel) });

    const roleA = createRole(ds, guild.snowflake, { name: "RoleA", permissions: String(PermissionFlags.SendMessages) });
    const roleB = createRole(ds, guild.snowflake, { name: "RoleB", permissions: String(PermissionFlags.AddReactions) });
    const m = ds.members.findBy("guild_snowflake", guild.snowflake).find((x) => x.user_snowflake === member.snowflake)!;
    ds.members.update(m.id, { role_snowflakes: [roleA.snowflake, roleB.snowflake] });

    const perms = computeGuildPermissions(ds, member.snowflake, guild.snowflake);
    expect(perms & PermissionFlags.ViewChannel).toBe(PermissionFlags.ViewChannel);
    expect(perms & PermissionFlags.SendMessages).toBe(PermissionFlags.SendMessages);
    expect(perms & PermissionFlags.AddReactions).toBe(PermissionFlags.AddReactions);
    expect(perms & PermissionFlags.BanMembers).toBe(0n);
  });

  it("ADMINISTRATOR in any role short-circuits to ALL_PERMISSIONS", () => {
    const { ds, member, guild } = setup();
    const everyone = ds.roles.findOneBy("snowflake", guild.snowflake)!;
    ds.roles.update(everyone.id, { permissions: "0" });

    const adminRole = createRole(ds, guild.snowflake, {
      name: "Admin",
      permissions: String(PermissionFlags.Administrator),
    });
    const m = ds.members.findBy("guild_snowflake", guild.snowflake).find((x) => x.user_snowflake === member.snowflake)!;
    ds.members.update(m.id, { role_snowflakes: [adminRole.snowflake] });

    expect(computeGuildPermissions(ds, member.snowflake, guild.snowflake)).toBe(ALL_PERMISSIONS);
  });

  it("ADMINISTRATOR in @everyone short-circuits to ALL_PERMISSIONS", () => {
    const { ds, member, guild } = setup();
    const everyone = ds.roles.findOneBy("snowflake", guild.snowflake)!;
    ds.roles.update(everyone.id, { permissions: String(PermissionFlags.Administrator) });

    expect(computeGuildPermissions(ds, member.snowflake, guild.snowflake)).toBe(ALL_PERMISSIONS);
  });

  it("unknown guild returns 0n (not all permissions)", () => {
    const { ds, member } = setup();
    expect(computeGuildPermissions(ds, member.snowflake, "99999999999999999")).toBe(0n);
  });

  it("member not in guild gets only @everyone permissions (no extra roles)", () => {
    const { ds, guild } = setup();
    const stranger = createUser(ds, { username: "stranger" });
    // stranger is NOT added as a guild member, so no member row exists.
    const everyone = ds.roles.findOneBy("snowflake", guild.snowflake)!;
    ds.roles.update(everyone.id, { permissions: String(PermissionFlags.ViewChannel) });

    const perms = computeGuildPermissions(ds, stranger.snowflake, guild.snowflake);
    // @everyone applies to all users regardless of membership row.
    expect(perms & PermissionFlags.ViewChannel).toBe(PermissionFlags.ViewChannel);
    expect(perms & PermissionFlags.SendMessages).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// Section 3: Channel overwrite computation (compute_overwrites)
//
// Algorithm from the doc:
//   1. If base has ADMINISTRATOR, return ALL (no overwrites apply).
//   2. Apply @everyone overwrite: base &= ~deny, base |= allow.
//   3. Accumulate all role overwrites: allow |= role.allow, deny |= role.deny.
//      Then: base &= ~deny, base |= allow.
//   4. Apply member-specific overwrite last: base &= ~deny, base |= allow.
// ---------------------------------------------------------------------------

describe("permissions.mdx -- channel overwrite computation", () => {
  it("DM channels (no guild_snowflake) return ALL_PERMISSIONS", () => {
    const { ds, member } = setup();
    const dm = createChannel(ds, { name: "dm", type: 1, guildSnowflake: null });
    expect(computePermissions(ds, member.snowflake, dm.snowflake)).toBe(ALL_PERMISSIONS);
  });

  it("unknown channel is not a permission context -- returns no permissions (0n)", () => {
    // A real DM channel exists in the store with no guild; a channel that does not exist at all
    // must not be conflated with a DM and silently granted ALL_PERMISSIONS.
    const { ds, member } = setup();
    expect(computePermissions(ds, member.snowflake, "99999999999999999")).toBe(0n);
  });

  it("guild owner bypasses all overwrites -- returns ALL_PERMISSIONS", () => {
    const { ds, owner, guild } = setup();
    const ch = createChannel(ds, {
      name: "locked",
      type: 0,
      guildSnowflake: guild.snowflake,
      permissionOverwrites: [
        { id: guild.snowflake, type: 0, allow: "0", deny: String(PermissionFlags.ViewChannel) },
      ],
    });
    expect(computePermissions(ds, owner.snowflake, ch.snowflake)).toBe(ALL_PERMISSIONS);
  });

  it("ADMINISTRATOR in base skips channel overwrites -- returns ALL_PERMISSIONS", () => {
    const { ds, member, guild } = setup();
    const adminRole = createRole(ds, guild.snowflake, {
      name: "Admin",
      permissions: String(PermissionFlags.Administrator),
    });
    const m = ds.members.findBy("guild_snowflake", guild.snowflake).find((x) => x.user_snowflake === member.snowflake)!;
    ds.members.update(m.id, { role_snowflakes: [adminRole.snowflake] });

    const ch = createChannel(ds, {
      name: "locked",
      type: 0,
      guildSnowflake: guild.snowflake,
      permissionOverwrites: [
        { id: guild.snowflake, type: 0, allow: "0", deny: String(PermissionFlags.SendMessages) },
      ],
    });
    // ADMINISTRATOR means all permissions even with an @everyone deny overwrite.
    expect(computePermissions(ds, member.snowflake, ch.snowflake)).toBe(ALL_PERMISSIONS);
  });

  it("@everyone overwrite deny removes a permission granted by the base", () => {
    const { ds, member, guild } = setup();
    const everyone = ds.roles.findOneBy("snowflake", guild.snowflake)!;
    // Give @everyone ViewChannel + SendMessages at guild level.
    ds.roles.update(everyone.id, {
      permissions: String(PermissionFlags.ViewChannel | PermissionFlags.SendMessages),
    });

    const ch = createChannel(ds, {
      name: "readonly",
      type: 0,
      guildSnowflake: guild.snowflake,
      permissionOverwrites: [
        // @everyone overwrite: deny SendMessages
        { id: guild.snowflake, type: 0, allow: "0", deny: String(PermissionFlags.SendMessages) },
      ],
    });

    const perms = computePermissions(ds, member.snowflake, ch.snowflake);
    expect(perms & PermissionFlags.ViewChannel).toBe(PermissionFlags.ViewChannel);
    expect(perms & PermissionFlags.SendMessages).toBe(0n);
  });

  it("@everyone overwrite allow grants a permission not in the base", () => {
    const { ds, member, guild } = setup();
    const everyone = ds.roles.findOneBy("snowflake", guild.snowflake)!;
    ds.roles.update(everyone.id, { permissions: "0" });

    const ch = createChannel(ds, {
      name: "special",
      type: 0,
      guildSnowflake: guild.snowflake,
      permissionOverwrites: [
        { id: guild.snowflake, type: 0, allow: String(PermissionFlags.ViewChannel), deny: "0" },
      ],
    });

    const perms = computePermissions(ds, member.snowflake, ch.snowflake);
    expect(perms & PermissionFlags.ViewChannel).toBe(PermissionFlags.ViewChannel);
  });

  it("role overwrite deny removes permission after @everyone overwrite is applied", () => {
    const { ds, member, guild } = setup();
    const everyone = ds.roles.findOneBy("snowflake", guild.snowflake)!;
    ds.roles.update(everyone.id, {
      permissions: String(PermissionFlags.ViewChannel | PermissionFlags.SendMessages),
    });

    // Member has a custom role.
    const customRole = createRole(ds, guild.snowflake, { name: "Silent", permissions: "0" });
    const m = ds.members.findBy("guild_snowflake", guild.snowflake).find((x) => x.user_snowflake === member.snowflake)!;
    ds.members.update(m.id, { role_snowflakes: [customRole.snowflake] });

    const ch = createChannel(ds, {
      name: "hushchan",
      type: 0,
      guildSnowflake: guild.snowflake,
      permissionOverwrites: [
        // Role overwrite: deny SendMessages for the custom role.
        { id: customRole.snowflake, type: 0, allow: "0", deny: String(PermissionFlags.SendMessages) },
      ],
    });

    const perms = computePermissions(ds, member.snowflake, ch.snowflake);
    expect(perms & PermissionFlags.ViewChannel).toBe(PermissionFlags.ViewChannel);
    expect(perms & PermissionFlags.SendMessages).toBe(0n);
  });

  it("role overwrite allow grants permission even when @everyone denies it", () => {
    const { ds, member, guild } = setup();
    const everyone = ds.roles.findOneBy("snowflake", guild.snowflake)!;
    ds.roles.update(everyone.id, {
      permissions: String(PermissionFlags.ViewChannel | PermissionFlags.SendMessages),
    });

    const customRole = createRole(ds, guild.snowflake, { name: "Talker", permissions: "0" });
    const m = ds.members.findBy("guild_snowflake", guild.snowflake).find((x) => x.user_snowflake === member.snowflake)!;
    ds.members.update(m.id, { role_snowflakes: [customRole.snowflake] });

    const ch = createChannel(ds, {
      name: "mixed",
      type: 0,
      guildSnowflake: guild.snowflake,
      permissionOverwrites: [
        // @everyone overwrite: deny SendMessages.
        { id: guild.snowflake, type: 0, allow: "0", deny: String(PermissionFlags.SendMessages) },
        // Role overwrite: allow SendMessages back.
        { id: customRole.snowflake, type: 0, allow: String(PermissionFlags.SendMessages), deny: "0" },
      ],
    });

    const perms = computePermissions(ds, member.snowflake, ch.snowflake);
    expect(perms & PermissionFlags.SendMessages).toBe(PermissionFlags.SendMessages);
  });

  it("multiple role overwrites are accumulated (union deny then union allow)", () => {
    const { ds, member, guild } = setup();
    const everyone = ds.roles.findOneBy("snowflake", guild.snowflake)!;
    ds.roles.update(everyone.id, {
      permissions: String(
        PermissionFlags.ViewChannel | PermissionFlags.SendMessages | PermissionFlags.AddReactions,
      ),
    });

    const roleA = createRole(ds, guild.snowflake, { name: "RoleA", permissions: "0" });
    const roleB = createRole(ds, guild.snowflake, { name: "RoleB", permissions: "0" });
    const m = ds.members.findBy("guild_snowflake", guild.snowflake).find((x) => x.user_snowflake === member.snowflake)!;
    ds.members.update(m.id, { role_snowflakes: [roleA.snowflake, roleB.snowflake] });

    const ch = createChannel(ds, {
      name: "multirole",
      type: 0,
      guildSnowflake: guild.snowflake,
      permissionOverwrites: [
        // RoleA denies SendMessages.
        { id: roleA.snowflake, type: 0, allow: "0", deny: String(PermissionFlags.SendMessages) },
        // RoleB allows AddReactions (which base has, but just to confirm it stays).
        { id: roleB.snowflake, type: 0, allow: String(PermissionFlags.AddReactions), deny: "0" },
      ],
    });

    const perms = computePermissions(ds, member.snowflake, ch.snowflake);
    expect(perms & PermissionFlags.ViewChannel).toBe(PermissionFlags.ViewChannel);
    expect(perms & PermissionFlags.SendMessages).toBe(0n); // denied by RoleA
    expect(perms & PermissionFlags.AddReactions).toBe(PermissionFlags.AddReactions); // allowed by RoleB
  });

  it("member-specific overwrite (type=1) is applied last and wins over role overwrites", () => {
    const { ds, member, guild } = setup();
    const everyone = ds.roles.findOneBy("snowflake", guild.snowflake)!;
    ds.roles.update(everyone.id, {
      permissions: String(PermissionFlags.ViewChannel | PermissionFlags.SendMessages),
    });

    const ch = createChannel(ds, {
      name: "memberchan",
      type: 0,
      guildSnowflake: guild.snowflake,
      permissionOverwrites: [
        // @everyone overwrite: deny SendMessages.
        { id: guild.snowflake, type: 0, allow: "0", deny: String(PermissionFlags.SendMessages) },
        // Member overwrite (type=1): allow SendMessages back.
        { id: member.snowflake, type: 1, allow: String(PermissionFlags.SendMessages), deny: "0" },
      ],
    });

    const perms = computePermissions(ds, member.snowflake, ch.snowflake);
    expect(perms & PermissionFlags.SendMessages).toBe(PermissionFlags.SendMessages);
    expect(perms & PermissionFlags.ViewChannel).toBe(PermissionFlags.ViewChannel);
  });

  it("member-specific overwrite deny removes permission that role allows", () => {
    const { ds, member, guild } = setup();
    const everyone = ds.roles.findOneBy("snowflake", guild.snowflake)!;
    ds.roles.update(everyone.id, {
      permissions: String(PermissionFlags.ViewChannel | PermissionFlags.SendMessages),
    });

    const ch = createChannel(ds, {
      name: "memberdeny",
      type: 0,
      guildSnowflake: guild.snowflake,
      permissionOverwrites: [
        // Member overwrite: deny SendMessages (last in priority chain).
        { id: member.snowflake, type: 1, allow: "0", deny: String(PermissionFlags.SendMessages) },
      ],
    });

    const perms = computePermissions(ds, member.snowflake, ch.snowflake);
    expect(perms & PermissionFlags.SendMessages).toBe(0n);
    expect(perms & PermissionFlags.ViewChannel).toBe(PermissionFlags.ViewChannel);
  });

  it("full 8-step hierarchy: base -> @everyone OW -> role OW -> member OW", () => {
    // This test exercises all 8 documented steps in order.
    //
    // Doc hierarchy:
    //   1. Base @everyone guild perms
    //   2. OR in role guild perms
    //   3. Apply @everyone channel deny
    //   4. Apply @everyone channel allow
    //   5. Accumulate role channel deny
    //   6. Accumulate role channel allow
    //   7. Apply member channel deny
    //   8. Apply member channel allow
    const { ds, member, guild } = setup();
    const everyone = ds.roles.findOneBy("snowflake", guild.snowflake)!;

    // Steps 1+2: @everyone grants ViewChannel; a role grants SendMessages.
    ds.roles.update(everyone.id, { permissions: String(PermissionFlags.ViewChannel) });
    const memberRole = createRole(ds, guild.snowflake, {
      name: "Talker",
      permissions: String(PermissionFlags.SendMessages),
    });
    const m = ds.members.findBy("guild_snowflake", guild.snowflake).find((x) => x.user_snowflake === member.snowflake)!;
    ds.members.update(m.id, { role_snowflakes: [memberRole.snowflake] });

    // Step 3: @everyone OW denies ViewChannel.
    // Step 4: @everyone OW allows MentionEveryone (was not in base).
    // Step 5: role OW denies SendMessages.
    // Step 6: role OW allows AddReactions (was not in base).
    // Step 7: member OW denies AddReactions (takes it back).
    // Step 8: member OW allows ViewChannel (restores it).
    const ch = createChannel(ds, {
      name: "hierarchy",
      type: 0,
      guildSnowflake: guild.snowflake,
      permissionOverwrites: [
        {
          id: guild.snowflake,
          type: 0,
          allow: String(PermissionFlags.MentionEveryone),
          deny: String(PermissionFlags.ViewChannel),
        },
        {
          id: memberRole.snowflake,
          type: 0,
          allow: String(PermissionFlags.AddReactions),
          deny: String(PermissionFlags.SendMessages),
        },
        {
          id: member.snowflake,
          type: 1,
          allow: String(PermissionFlags.ViewChannel),
          deny: String(PermissionFlags.AddReactions),
        },
      ],
    });

    const perms = computePermissions(ds, member.snowflake, ch.snowflake);

    // ViewChannel: denied by @everyone OW, then restored by member OW => present.
    expect(perms & PermissionFlags.ViewChannel).toBe(PermissionFlags.ViewChannel);
    // SendMessages: granted by role, then denied by role OW => absent.
    expect(perms & PermissionFlags.SendMessages).toBe(0n);
    // MentionEveryone: not in base, allowed by @everyone OW => present.
    expect(perms & PermissionFlags.MentionEveryone).toBe(PermissionFlags.MentionEveryone);
    // AddReactions: not in base, allowed by role OW, then denied by member OW => absent.
    expect(perms & PermissionFlags.AddReactions).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// Section 4: Permissions For Timed Out Members (permissions.mdx:308-310)
//
// A member with communication_disabled_until in the future temporarily loses all
// permissions except VIEW_CHANNEL and READ_MESSAGE_HISTORY. Guild owners and
// ADMINISTRATOR holders are exempt.
// ---------------------------------------------------------------------------

describe("permissions.mdx -- Permissions For Timed Out Members", () => {
  /**
   * Set communication_disabled_until on an existing guild member.
   */
  function timeoutMember(ds: ReturnType<typeof getDiscordStore>, guildSnowflake: string, userSnowflake: string, until: string): void {
    const m = ds.members.findBy("guild_snowflake", guildSnowflake).find((x) => x.user_snowflake === userSnowflake)!;
    ds.members.update(m.id, { communication_disabled_until: until });
  }

  it("a timed-out member retains ONLY VIEW_CHANNEL and READ_MESSAGE_HISTORY in a channel", () => {
    const { ds, member, guild, channel } = setup();
    // Grant the member SendMessages so we can verify it is stripped.
    const everyoneRole = ds.roles.findOneBy("snowflake", guild.snowflake)!;
    ds.roles.update(everyoneRole.id, {
      permissions: String(PermissionFlags.ViewChannel | PermissionFlags.ReadMessageHistory | PermissionFlags.SendMessages),
    });

    // Confirm the member has SendMessages before the timeout.
    const before = computePermissions(ds, member.snowflake, channel.snowflake);
    expect(before & PermissionFlags.SendMessages).toBe(PermissionFlags.SendMessages);

    // Time out the member (disabled until 1 hour from now).
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    timeoutMember(ds, guild.snowflake, member.snowflake, until);

    const perms = computePermissions(ds, member.snowflake, channel.snowflake);
    // Only VIEW_CHANNEL and READ_MESSAGE_HISTORY should remain.
    expect(perms & PermissionFlags.ViewChannel).toBe(PermissionFlags.ViewChannel);
    expect(perms & PermissionFlags.ReadMessageHistory).toBe(PermissionFlags.ReadMessageHistory);
    expect(perms & PermissionFlags.SendMessages).toBe(0n);
    expect(perms & PermissionFlags.ManageMessages).toBe(0n);
    expect(perms & PermissionFlags.AddReactions).toBe(0n);
  });

  it("a timed-out member retains ONLY VIEW_CHANNEL and READ_MESSAGE_HISTORY at guild level", () => {
    const { ds, member, guild } = setup();
    const everyoneRole = ds.roles.findOneBy("snowflake", guild.snowflake)!;
    ds.roles.update(everyoneRole.id, {
      permissions: String(PermissionFlags.ViewChannel | PermissionFlags.ReadMessageHistory | PermissionFlags.SendMessages),
    });

    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    timeoutMember(ds, guild.snowflake, member.snowflake, until);

    const perms = computeGuildPermissions(ds, member.snowflake, guild.snowflake);
    expect(perms & PermissionFlags.ViewChannel).toBe(PermissionFlags.ViewChannel);
    expect(perms & PermissionFlags.ReadMessageHistory).toBe(PermissionFlags.ReadMessageHistory);
    expect(perms & PermissionFlags.SendMessages).toBe(0n);
  });

  it("the guild owner is NOT affected by a timeout", () => {
    const { ds, owner, guild, channel } = setup();
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const ownerMember = ds.members.findBy("guild_snowflake", guild.snowflake).find((m) => m.user_snowflake === owner.snowflake);
    if (ownerMember) ds.members.update(ownerMember.id, { communication_disabled_until: until });

    const perms = computePermissions(ds, owner.snowflake, channel.snowflake);
    expect(perms).toBe(ALL_PERMISSIONS);
  });

  it("a member with ADMINISTRATOR is NOT affected by a timeout", () => {
    const { ds, member, guild, channel } = setup();
    const adminRole = ds.roles.insert({
      snowflake: "admin_role",
      guild_snowflake: guild.snowflake,
      name: "Admin",
      color: 0,
      hoist: false,
      icon: null,
      unicode_emoji: null,
      position: 1,
      permissions: String(PermissionFlags.Administrator),
      managed: false,
      mentionable: false,
      flags: 0,
      tags: null,
    });
    const m = ds.members.findBy("guild_snowflake", guild.snowflake).find((x) => x.user_snowflake === member.snowflake)!;
    ds.members.update(m.id, { role_snowflakes: [adminRole.snowflake] });

    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    timeoutMember(ds, guild.snowflake, member.snowflake, until);

    const perms = computePermissions(ds, member.snowflake, channel.snowflake);
    expect(perms).toBe(ALL_PERMISSIONS);
  });

  it("a past communication_disabled_until does NOT restrict permissions", () => {
    const { ds, member, guild, channel } = setup();
    const everyoneRole = ds.roles.findOneBy("snowflake", guild.snowflake)!;
    ds.roles.update(everyoneRole.id, {
      permissions: String(PermissionFlags.ViewChannel | PermissionFlags.SendMessages),
    });

    // Timeout expired 1 hour ago.
    const expired = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    timeoutMember(ds, guild.snowflake, member.snowflake, expired);

    const perms = computePermissions(ds, member.snowflake, channel.snowflake);
    expect(perms & PermissionFlags.SendMessages).toBe(PermissionFlags.SendMessages);
  });
});

// ---------------------------------------------------------------------------
// Section 5: hasPermission helper
// ---------------------------------------------------------------------------

describe("permissions.mdx -- hasPermission helper", () => {
  it("returns true when the exact flag is present", () => {
    expect(hasPermission(PermissionFlags.ViewChannel | PermissionFlags.SendMessages, PermissionFlags.ViewChannel)).toBe(
      true,
    );
  });

  it("returns false when the flag is absent", () => {
    expect(hasPermission(PermissionFlags.ViewChannel, PermissionFlags.SendMessages)).toBe(false);
  });

  it("returns true for any flag when ADMINISTRATOR is set", () => {
    expect(hasPermission(PermissionFlags.Administrator, PermissionFlags.ManageGuild)).toBe(true);
    expect(hasPermission(PermissionFlags.Administrator, PermissionFlags.BanMembers)).toBe(true);
    expect(hasPermission(PermissionFlags.Administrator, PermissionFlags.BypassSlowmode)).toBe(true);
  });

  it("returns false for 0n permissions (no flags set)", () => {
    expect(hasPermission(0n, PermissionFlags.ViewChannel)).toBe(false);
    expect(hasPermission(0n, PermissionFlags.SendMessages)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Section 5: @everyone role id == guild id
// ---------------------------------------------------------------------------

describe("permissions.mdx -- @everyone role id equals guild id", () => {
  it("the @everyone role's snowflake matches the guild's snowflake", () => {
    const { ds, guild } = setup();
    const everyoneRole = ds.roles.findOneBy("snowflake", guild.snowflake);
    expect(everyoneRole).toBeDefined();
    expect(everyoneRole!.snowflake).toBe(guild.snowflake);
    expect(everyoneRole!.name).toBe("@everyone");
  });

  it("@everyone overwrite is identified by id == guild.id in the overwrites array", () => {
    const { ds, member, guild } = setup();
    const everyone = ds.roles.findOneBy("snowflake", guild.snowflake)!;
    ds.roles.update(everyone.id, { permissions: String(PermissionFlags.ViewChannel) });

    const ch = createChannel(ds, {
      name: "everyonetest",
      type: 0,
      guildSnowflake: guild.snowflake,
      permissionOverwrites: [
        // Overwrite uses the guild's own snowflake as the @everyone role id.
        { id: guild.snowflake, type: 0, allow: String(PermissionFlags.SendMessages), deny: "0" },
      ],
    });

    const perms = computePermissions(ds, member.snowflake, ch.snowflake);
    // SendMessages was not in base but was granted by the @everyone overwrite.
    expect(perms & PermissionFlags.SendMessages).toBe(PermissionFlags.SendMessages);
  });
});
