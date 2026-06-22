/**
 * Spec suite for `developers/topics/teams.mdx` as surfaced on the Application object.
 *
 * Encodes the documented Team contract: the Team object shape (id, icon, name, owner_user_id,
 * members), the Team Member object shape (membership_state, team_id, user partial, role), the
 * Membership State enum (INVITED = 1 / ACCEPTED = 2), the Team Member Role values (admin,
 * developer, read_only), and the Application object's `team` field (null when no team; a full
 * Team object when one is configured).
 *
 * Team data is configured via the store side-channel (APP_TEAM_KEY) — the same mechanism
 * applicationManagement.ts already uses for extras — so no entity or factory changes are needed.
 */
import { describe, it, expect } from "vitest";
import { createDiscordTestApp, api, botHeaders, json, seededIds } from "../helpers.js";
import {
  MembershipState,
  TeamMemberRole,
  APP_TEAM_KEY,
  type TeamData,
} from "../../routes/applicationManagement.js";

// Enum value assertions (doc-driven constants)

describe("teams.mdx — Membership State Enum values", () => {
  it("INVITED is 1", () => {
    expect(MembershipState.INVITED).toBe(1);
  });

  it("ACCEPTED is 2", () => {
    expect(MembershipState.ACCEPTED).toBe(2);
  });
});

describe("teams.mdx — Team Member Role string values", () => {
  it("ADMIN role value is 'admin'", () => {
    expect(TeamMemberRole.ADMIN).toBe("admin");
  });

  it("DEVELOPER role value is 'developer'", () => {
    expect(TeamMemberRole.DEVELOPER).toBe("developer");
  });

  it("READ_ONLY role value is 'read_only'", () => {
    expect(TeamMemberRole.READ_ONLY).toBe("read_only");
  });
});

// Helpers

function appSnowflake(store: ReturnType<typeof createDiscordTestApp>["store"]): string {
  return seededIds(store).app;
}

async function getApplication(app: ReturnType<typeof createDiscordTestApp>["app"]): Promise<Record<string, unknown>> {
  const res = await app.request(api("/applications/@me"), { headers: botHeaders() });
  expect(res.status).toBe(200);
  return await json(res);
}

/** Build a minimal but fully-documented TeamData fixture for a single ACCEPTED admin member. */
function buildTeam(overrides?: Partial<TeamData>): TeamData {
  return {
    id: "531992624043786253",
    name: "A team",
    icon: "dd9b7dcfdf5351b9c3de0fe167bacbe1",
    owner_user_id: "511972282709709995",
    members: [
      {
        membership_state: MembershipState.ACCEPTED,
        team_id: "531992624043786253",
        user: {
          id: "511972282709709995",
          username: "Mr Owner",
          discriminator: "0001",
          avatar: "d9e261cd35999608eb7e3de1fae3688b",
        },
        role: TeamMemberRole.ADMIN,
      },
    ],
    ...overrides,
  };
}

// Application `team` field — default (no team)

describe("teams.mdx — Application.team field — default (owner-held app)", () => {
  it("team is present on the application object", async () => {
    const { app } = createDiscordTestApp();
    const a = await getApplication(app);
    expect("team" in a).toBe(true);
  });

  it("team is null when no team is configured (default seeded application is owner-held)", async () => {
    const { app } = createDiscordTestApp();
    const a = await getApplication(app);
    expect(a.team).toBeNull();
  });
});

// Application `team` field — configured via store side-channel

describe("teams.mdx — Application.team field — team-owned application", () => {
  it("team is a non-null object when a team is set via store side-channel", async () => {
    const { app, store } = createDiscordTestApp();
    const snowflake = appSnowflake(store);
    store.setData<TeamData>(APP_TEAM_KEY(snowflake), buildTeam());

    const a = await getApplication(app);
    expect(a.team).not.toBeNull();
    expect(typeof a.team).toBe("object");
  });

  it("team.id is the configured team snowflake (string)", async () => {
    const { app, store } = createDiscordTestApp();
    const snowflake = appSnowflake(store);
    const team = buildTeam({ id: "531992624043786253" });
    store.setData<TeamData>(APP_TEAM_KEY(snowflake), team);

    const a = await getApplication(app);
    const t = a.team as Record<string, unknown>;
    expect(t.id).toBe("531992624043786253");
  });

  it("team.name is the configured team name (string)", async () => {
    const { app, store } = createDiscordTestApp();
    const snowflake = appSnowflake(store);
    store.setData<TeamData>(APP_TEAM_KEY(snowflake), buildTeam({ name: "Widgets Inc" }));

    const a = await getApplication(app);
    const t = a.team as Record<string, unknown>;
    expect(t.name).toBe("Widgets Inc");
  });

  it("team.icon is a string hash when set", async () => {
    const { app, store } = createDiscordTestApp();
    const snowflake = appSnowflake(store);
    store.setData<TeamData>(APP_TEAM_KEY(snowflake), buildTeam({ icon: "dd9b7dcfdf5351b9c3de0fe167bacbe1" }));

    const a = await getApplication(app);
    const t = a.team as Record<string, unknown>;
    expect(t.icon).toBe("dd9b7dcfdf5351b9c3de0fe167bacbe1");
  });

  it("team.icon is null when not set (nullable field)", async () => {
    const { app, store } = createDiscordTestApp();
    const snowflake = appSnowflake(store);
    store.setData<TeamData>(APP_TEAM_KEY(snowflake), buildTeam({ icon: null }));

    const a = await getApplication(app);
    const t = a.team as Record<string, unknown>;
    expect(t.icon).toBeNull();
  });

  it("team.owner_user_id identifies the team owner (snowflake string)", async () => {
    const { app, store } = createDiscordTestApp();
    const snowflake = appSnowflake(store);
    store.setData<TeamData>(APP_TEAM_KEY(snowflake), buildTeam({ owner_user_id: "511972282709709995" }));

    const a = await getApplication(app);
    const t = a.team as Record<string, unknown>;
    expect(t.owner_user_id).toBe("511972282709709995");
  });

  it("team.members is an array", async () => {
    const { app, store } = createDiscordTestApp();
    const snowflake = appSnowflake(store);
    store.setData<TeamData>(APP_TEAM_KEY(snowflake), buildTeam());

    const a = await getApplication(app);
    const t = a.team as Record<string, unknown>;
    expect(Array.isArray(t.members)).toBe(true);
  });
});

// Team Member Object shape

describe("teams.mdx — Team Member Object shape", () => {
  function teamWithMember(memberOverride?: Partial<TeamData["members"][0]>): TeamData {
    const base = buildTeam();
    return {
      ...base,
      members: [{ ...base.members[0]!, ...memberOverride }],
    };
  }

  it("member.membership_state is a number (integer)", async () => {
    const { app, store } = createDiscordTestApp();
    const snowflake = appSnowflake(store);
    store.setData<TeamData>(APP_TEAM_KEY(snowflake), teamWithMember({ membership_state: MembershipState.ACCEPTED }));

    const a = await getApplication(app);
    const t = a.team as Record<string, unknown>;
    const members = t.members as Array<Record<string, unknown>>;
    expect(Number.isInteger(members[0]!.membership_state)).toBe(true);
  });

  it("membership_state ACCEPTED is 2 on the serialised member", async () => {
    const { app, store } = createDiscordTestApp();
    const snowflake = appSnowflake(store);
    store.setData<TeamData>(APP_TEAM_KEY(snowflake), teamWithMember({ membership_state: MembershipState.ACCEPTED }));

    const a = await getApplication(app);
    const t = a.team as Record<string, unknown>;
    const members = t.members as Array<Record<string, unknown>>;
    expect(members[0]!.membership_state).toBe(2);
  });

  it("membership_state INVITED is 1 on the serialised member", async () => {
    const { app, store } = createDiscordTestApp();
    const snowflake = appSnowflake(store);
    store.setData<TeamData>(APP_TEAM_KEY(snowflake), teamWithMember({ membership_state: MembershipState.INVITED }));

    const a = await getApplication(app);
    const t = a.team as Record<string, unknown>;
    const members = t.members as Array<Record<string, unknown>>;
    expect(members[0]!.membership_state).toBe(1);
  });

  it("member.team_id is the parent team's snowflake", async () => {
    const { app, store } = createDiscordTestApp();
    const snowflake = appSnowflake(store);
    const team = buildTeam({ id: "531992624043786253" });
    store.setData<TeamData>(APP_TEAM_KEY(snowflake), team);

    const a = await getApplication(app);
    const t = a.team as Record<string, unknown>;
    const members = t.members as Array<Record<string, unknown>>;
    expect(members[0]!.team_id).toBe("531992624043786253");
  });

  it("member.role is a string", async () => {
    const { app, store } = createDiscordTestApp();
    const snowflake = appSnowflake(store);
    store.setData<TeamData>(APP_TEAM_KEY(snowflake), buildTeam());

    const a = await getApplication(app);
    const t = a.team as Record<string, unknown>;
    const members = t.members as Array<Record<string, unknown>>;
    expect(typeof members[0]!.role).toBe("string");
  });

  it("member.role reflects 'admin' for an admin member", async () => {
    const { app, store } = createDiscordTestApp();
    const snowflake = appSnowflake(store);
    store.setData<TeamData>(APP_TEAM_KEY(snowflake), teamWithMember({ role: TeamMemberRole.ADMIN }));

    const a = await getApplication(app);
    const t = a.team as Record<string, unknown>;
    const members = t.members as Array<Record<string, unknown>>;
    expect(members[0]!.role).toBe("admin");
  });

  it("member.role reflects 'developer' for a developer member", async () => {
    const { app, store } = createDiscordTestApp();
    const snowflake = appSnowflake(store);
    store.setData<TeamData>(APP_TEAM_KEY(snowflake), teamWithMember({ role: TeamMemberRole.DEVELOPER }));

    const a = await getApplication(app);
    const t = a.team as Record<string, unknown>;
    const members = t.members as Array<Record<string, unknown>>;
    expect(members[0]!.role).toBe("developer");
  });

  it("member.role reflects 'read_only' for a read-only member", async () => {
    const { app, store } = createDiscordTestApp();
    const snowflake = appSnowflake(store);
    store.setData<TeamData>(APP_TEAM_KEY(snowflake), teamWithMember({ role: TeamMemberRole.READ_ONLY }));

    const a = await getApplication(app);
    const t = a.team as Record<string, unknown>;
    const members = t.members as Array<Record<string, unknown>>;
    expect(members[0]!.role).toBe("read_only");
  });

  it("member.user is an object with at least id and username (partial user)", async () => {
    const { app, store } = createDiscordTestApp();
    const snowflake = appSnowflake(store);
    store.setData<TeamData>(
      APP_TEAM_KEY(snowflake),
      teamWithMember({
        user: { id: "511972282709709995", username: "Mr Owner" },
      }),
    );

    const a = await getApplication(app);
    const t = a.team as Record<string, unknown>;
    const members = t.members as Array<Record<string, unknown>>;
    const user = members[0]!.user as Record<string, unknown>;
    expect(typeof user.id).toBe("string");
    expect(typeof user.username).toBe("string");
  });

  it("member.user.id matches the configured user id", async () => {
    const { app, store } = createDiscordTestApp();
    const snowflake = appSnowflake(store);
    store.setData<TeamData>(
      APP_TEAM_KEY(snowflake),
      teamWithMember({
        user: { id: "511972282709709995", username: "Mr Owner", discriminator: "0001", avatar: "d9e261cd35999608eb7e3de1fae3688b" },
      }),
    );

    const a = await getApplication(app);
    const t = a.team as Record<string, unknown>;
    const members = t.members as Array<Record<string, unknown>>;
    const user = members[0]!.user as Record<string, unknown>;
    expect(user.id).toBe("511972282709709995");
  });

  it("member.user.avatar is passed through (nullable string)", async () => {
    const { app, store } = createDiscordTestApp();
    const snowflake = appSnowflake(store);
    store.setData<TeamData>(
      APP_TEAM_KEY(snowflake),
      teamWithMember({
        user: { id: "511972282709709995", username: "Mr Owner", avatar: "d9e261cd35999608eb7e3de1fae3688b" },
      }),
    );

    const a = await getApplication(app);
    const t = a.team as Record<string, unknown>;
    const members = t.members as Array<Record<string, unknown>>;
    const user = members[0]!.user as Record<string, unknown>;
    expect(user.avatar).toBe("d9e261cd35999608eb7e3de1fae3688b");
  });
});

// Multi-member team

describe("teams.mdx — Team with multiple members", () => {
  it("all configured members appear in the response", async () => {
    const { app, store } = createDiscordTestApp();
    const snowflake = appSnowflake(store);
    const team: TeamData = {
      id: "531992624043786253",
      name: "Multi",
      icon: null,
      owner_user_id: "100000000000000001",
      members: [
        {
          membership_state: MembershipState.ACCEPTED,
          team_id: "531992624043786253",
          user: { id: "100000000000000001", username: "alice" },
          role: TeamMemberRole.ADMIN,
        },
        {
          membership_state: MembershipState.ACCEPTED,
          team_id: "531992624043786253",
          user: { id: "100000000000000002", username: "bob" },
          role: TeamMemberRole.DEVELOPER,
        },
        {
          membership_state: MembershipState.INVITED,
          team_id: "531992624043786253",
          user: { id: "100000000000000003", username: "charlie" },
          role: TeamMemberRole.READ_ONLY,
        },
      ],
    };
    store.setData<TeamData>(APP_TEAM_KEY(snowflake), team);

    const a = await getApplication(app);
    const t = a.team as Record<string, unknown>;
    const members = t.members as Array<Record<string, unknown>>;
    expect(members).toHaveLength(3);
  });

  it("each member carries the correct membership_state and role", async () => {
    const { app, store } = createDiscordTestApp();
    const snowflake = appSnowflake(store);
    const team: TeamData = {
      id: "531992624043786253",
      name: "Multi",
      icon: null,
      owner_user_id: "100000000000000001",
      members: [
        {
          membership_state: MembershipState.ACCEPTED,
          team_id: "531992624043786253",
          user: { id: "100000000000000001", username: "alice" },
          role: TeamMemberRole.ADMIN,
        },
        {
          membership_state: MembershipState.INVITED,
          team_id: "531992624043786253",
          user: { id: "100000000000000002", username: "bob" },
          role: TeamMemberRole.DEVELOPER,
        },
      ],
    };
    store.setData<TeamData>(APP_TEAM_KEY(snowflake), team);

    const a = await getApplication(app);
    const t = a.team as Record<string, unknown>;
    const members = t.members as Array<Record<string, unknown>>;
    expect(members[0]!.membership_state).toBe(MembershipState.ACCEPTED);
    expect(members[0]!.role).toBe(TeamMemberRole.ADMIN);
    expect(members[1]!.membership_state).toBe(MembershipState.INVITED);
    expect(members[1]!.role).toBe(TeamMemberRole.DEVELOPER);
  });
});

// Round-trip fidelity — team survives a PATCH /applications/@me

describe("teams.mdx — team field survives PATCH /applications/@me", () => {
  it("team is still populated after editing an unrelated application field", async () => {
    const { app, store } = createDiscordTestApp();
    const snowflake = appSnowflake(store);
    store.setData<TeamData>(APP_TEAM_KEY(snowflake), buildTeam({ name: "Persisted Team" }));

    const res = await app.request(api("/applications/@me"), {
      method: "PATCH",
      headers: botHeaders(),
      body: JSON.stringify({ description: "updated description" }),
    });
    expect(res.status).toBe(200);
    const a = await json(res);
    const t = a.team as Record<string, unknown>;
    expect(t).not.toBeNull();
    expect(t.name).toBe("Persisted Team");
  });

  it("team reverts to null after being cleared from the store", async () => {
    const { app, store } = createDiscordTestApp();
    const snowflake = appSnowflake(store);
    store.setData<TeamData>(APP_TEAM_KEY(snowflake), buildTeam());

    // Confirm it is present.
    const a1 = await getApplication(app);
    expect(a1.team).not.toBeNull();

    // Clear it.
    store.setData<null>(APP_TEAM_KEY(snowflake), null);
    const a2 = await getApplication(app);
    expect(a2.team).toBeNull();
  });
});
