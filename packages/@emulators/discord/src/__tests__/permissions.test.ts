import { describe, it, expect } from "vitest";
import { Store } from "@emulators/core";
import { getDiscordStore } from "../store.js";
import { createUser, createGuild, createRole, addGuildMember, createChannel } from "../factories.js";
import { computePermissions, hasPermission, PermissionFlags, ALL_PERMISSIONS } from "../permissions.js";

function setup() {
  const store = new Store();
  const ds = getDiscordStore(store);
  const owner = createUser(ds, { username: "owner" });
  const member = createUser(ds, { username: "member" });
  const guild = createGuild(ds, { name: "G", ownerSnowflake: owner.snowflake });
  addGuildMember(ds, guild.snowflake, member.snowflake);
  const channel = createChannel(ds, { name: "c", type: 0, guildSnowflake: guild.snowflake });
  return { ds, owner, member, guild, channel };
}

describe("discord permissions", () => {
  it("grants all permissions to the guild owner", () => {
    const { ds, owner, channel } = setup();
    expect(computePermissions(ds, owner.snowflake, channel.snowflake)).toBe(ALL_PERMISSIONS);
  });

  it("derives base permissions from @everyone and roles", () => {
    const { ds, member, guild, channel } = setup();
    // @everyone (role id == guild id) grants ViewChannel + SendMessages by the default seed.
    const everyone = ds.roles.findOneBy("snowflake", guild.snowflake)!;
    ds.roles.update(everyone.id, { permissions: String(PermissionFlags.ViewChannel) });
    const role = createRole(ds, guild.snowflake, { name: "talker", permissions: String(PermissionFlags.SendMessages) });
    const m = ds.members.findBy("guild_snowflake", guild.snowflake).find((x) => x.user_snowflake === member.snowflake)!;
    ds.members.update(m.id, { role_snowflakes: [role.snowflake] });

    const perms = computePermissions(ds, member.snowflake, channel.snowflake);
    expect(hasPermission(perms, PermissionFlags.ViewChannel)).toBe(true);
    expect(hasPermission(perms, PermissionFlags.SendMessages)).toBe(true);
    expect(hasPermission(perms, PermissionFlags.BanMembers)).toBe(false);
  });

  it("applies channel overwrites (deny wins over base, member overwrite last)", () => {
    const { ds, member, guild, channel } = setup();
    const everyone = ds.roles.findOneBy("snowflake", guild.snowflake)!;
    ds.roles.update(everyone.id, { permissions: String(PermissionFlags.ViewChannel | PermissionFlags.SendMessages) });
    // Deny SendMessages for @everyone in this channel, but allow it back for the member.
    ds.channels.update(channel.id, {
      permission_overwrites: [
        { id: guild.snowflake, type: 0, allow: "0", deny: String(PermissionFlags.SendMessages) },
        { id: member.snowflake, type: 1, allow: String(PermissionFlags.SendMessages), deny: "0" },
      ],
    });
    const perms = computePermissions(ds, member.snowflake, channel.snowflake);
    expect(hasPermission(perms, PermissionFlags.SendMessages)).toBe(true);
    expect(hasPermission(perms, PermissionFlags.ViewChannel)).toBe(true);
  });

  it("administrator short-circuits to all permissions", () => {
    const { ds, member, guild, channel } = setup();
    const role = createRole(ds, guild.snowflake, { name: "admin", permissions: String(PermissionFlags.Administrator) });
    const m = ds.members.findBy("guild_snowflake", guild.snowflake).find((x) => x.user_snowflake === member.snowflake)!;
    ds.members.update(m.id, { role_snowflakes: [role.snowflake] });
    expect(computePermissions(ds, member.snowflake, channel.snowflake)).toBe(ALL_PERMISSIONS);
  });
});
