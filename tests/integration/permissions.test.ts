import { and, eq } from "drizzle-orm";
import pg from "pg";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import type { Actor } from "@/modules/auth/shared";
import {
  can, canActOn, canManageMembers, canTransferOwnership, canUpdateOrganization, changeMemberRole, inTenant, isContext, leaveOrganization, listMembers,
  listOrganizations, PERMISSIONS, permissionsForRole, removeMember, requirePermission, resolveOrgContext, resolveSiteContext, transferOwnership,
  updateOrganization, type OrgContext, type Permission, type RoleKey,
} from "@/modules/tenancy";
import { ROLE_KEYS } from "@/modules/tenancy/shared";
import * as t from "@/platform/db/schema";
import { withPlatform, withTenant, withUser } from "@/platform/db/tenant";
import { isAppError } from "@/platform/errors";
import { dbError, PG } from "../fixtures/db-error";
import { createPublishedEntry, createSite, createUser } from "../fixtures/factories";
import { actorOf, addMember, addUser, newTenant, refusalOf } from "../fixtures/tenants";

/**
 * M3-2: authorization against real Postgres, as forge_app through PgBouncer.
 * The path under test is the whole one: membership row → role → catalog →
 * context → policy → service → what is left in the database.
 *
 * What each role holds, key by key, is pinned against plan §13 in
 * src/modules/tenancy/permissions.test.ts. Here: that the real resolver hands
 * out exactly that, that the services obey it, and that nothing gets around it.
 */

const FORBIDDEN = "You don't have permission to do that.";

/** "ok", or the kind of `AppError` the operation was refused with. */
async function outcomeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "ok";
  } catch (error) {
    if (isAppError(error)) return error.kind;
    throw error;
  }
}

const membersOf = (orgId: string) =>
  withTenant({ orgId }, (tx) =>
    tx
      .select({ id: t.organizationMembers.id, userId: t.organizationMembers.userId, role: t.roles.key })
      .from(t.organizationMembers)
      .innerJoin(t.roles, eq(t.roles.id, t.organizationMembers.roleId))
      .where(eq(t.organizationMembers.organizationId, orgId)),
  );
const roleOf = async (orgId: string, memberId: string) => (await membersOf(orgId)).find((m) => m.id === memberId)?.role;
const ownersOf = async (orgId: string) => (await membersOf(orgId)).filter((m) => m.role === "owner").map((m) => m.userId);
const nameOf = async (orgId: string) => (await withTenant({ orgId }, (tx) => tx.select().from(t.organizations).where(eq(t.organizations.id, orgId))))[0]!.name;

/** As the schema owner, on a direct connection: for rows the application's own role is not allowed to write. */
async function asOwner<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: process.env.TEST_WORKER_OWNER_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** A few keys per role that the role must and must not hold: the edges of each column of the table. */
const EDGES: Record<RoleKey, { size: number; holds: Permission[]; lacks: Permission[] }> = {
  owner: { size: 29, holds: ["org.manage", "org.billing.manage", "sites.delete", "org.members.manage", "entries.page.read"], lacks: [] },
  admin: { size: 26, holds: ["org.members.manage", "org.activity.read", "sites.create", "site.settings.manage"], lacks: ["org.manage", "org.billing.manage", "sites.delete"] },
  editor: { size: 22, holds: ["entries.page.publish", "entries.post.update.any", "site.menus.manage", "terms.manage", "media.delete.any"], lacks: ["org.members.manage", "org.activity.read", "sites.create", "site.settings.manage"] },
  author: { size: 10, holds: ["entries.post.create", "entries.post.publish.own", "terms.assign", "media.upload"], lacks: ["entries.page.create", "entries.post.update.any", "terms.manage", "media.delete.any", "site.menus.manage"] },
  viewer: { size: 2, holds: ["entries.page.read", "entries.post.read"], lacks: ["entries.post.create", "terms.assign", "media.upload", "media.update.own"] },
};

describe("each role is given its permissions by the resolver, from its membership row", () => {
  it.each(ROLE_KEYS)("%s", async (role) => {
    const a = await newTenant();
    const member = await addMember(a.org, role);
    const own = { organizationId: a.org.id, ownerId: member.user.id };

    expect(member.ctx.membership).toEqual({ id: member.memberId, role });
    expect(member.ctx.permissions).toBe(permissionsForRole(role));
    expect(member.ctx.permissions.list).toHaveLength(EDGES[role].size);
    for (const key of EDGES[role].holds) expect(can(member.ctx, key, own), `${role} holds ${key}`).toBe(true);
    for (const key of EDGES[role].lacks) expect(can(member.ctx, key, own), `${role} lacks ${key}`).toBe(false);
    for (const key of PERMISSIONS) expect(can(member.ctx, key, own), key).toBe(permissionsForRole(role).has(key));

    // A site context is the same member: same permissions, no more for being narrower.
    const site = await createSite(a.org.id, a.user.id);
    const inSite = await resolveSiteContext(member.actor, a.org.slug, site.slug);
    expect(inSite.permissions).toBe(member.ctx.permissions);
    expect(inSite.site.id).toBe(site.id);
  });

  it("the organization's creator is its Owner and holds the whole catalog", async () => {
    const a = await newTenant();
    expect(a.ctx.membership.role).toBe("owner");
    expect(a.ctx.permissions.list).toEqual([...PERMISSIONS]);
  });
});

describe("the services allow exactly what the role's permissions say", () => {
  const TABLE: Record<RoleKey, { update: boolean; manage: boolean; transfer: boolean }> = {
    owner: { update: true, manage: true, transfer: true },
    admin: { update: false, manage: true, transfer: false },
    editor: { update: false, manage: false, transfer: false },
    author: { update: false, manage: false, transfer: false },
    viewer: { update: false, manage: false, transfer: false },
  };

  it.each(ROLE_KEYS)("%s", async (role) => {
    const a = await newTenant();
    const member = await addMember(a.org, role);
    const [toChange, toRemove, toPromote] = [await addMember(a.org, "viewer"), await addMember(a.org, "viewer"), await addMember(a.org, "viewer")];
    const expected = TABLE[role];
    const { ctx } = member;

    // The policies, the catalog and the table agree before anything is attempted.
    expect({ update: canUpdateOrganization(ctx), manage: canManageMembers(ctx), transfer: canTransferOwnership(ctx) }).toEqual(expected);
    expect({ update: can(ctx, "org.manage"), manage: can(ctx, "org.members.manage"), transfer: can(ctx, "org.manage") }).toEqual(expected);

    // Reading the member list is membership, not a permission.
    expect(await outcomeOf(() => listMembers(ctx))).toBe("ok");

    expect(await outcomeOf(() => updateOrganization(ctx, { name: `By ${role}` }))).toBe(expected.update ? "ok" : "Forbidden");
    expect(await nameOf(a.org.id)).toBe(expected.update ? `By ${role}` : a.org.name);

    expect(await outcomeOf(() => changeMemberRole(ctx, { memberId: toChange.memberId, role: "author" }))).toBe(expected.manage ? "ok" : "Forbidden");
    expect(await roleOf(a.org.id, toChange.memberId)).toBe(expected.manage ? "author" : "viewer");

    expect(await outcomeOf(() => removeMember(ctx, { memberId: toRemove.memberId }))).toBe(expected.manage ? "ok" : "Forbidden");
    expect(await roleOf(a.org.id, toRemove.memberId)).toBe(expected.manage ? undefined : "viewer");

    expect(await outcomeOf(() => transferOwnership(ctx, { memberId: toPromote.memberId }))).toBe(expected.transfer ? "ok" : "Forbidden");
    expect(await roleOf(a.org.id, toPromote.memberId)).toBe(expected.transfer ? "owner" : "viewer");

    // Leaving takes no permission: every role may, on their next request as on this one.
    expect(await outcomeOf(async () => leaveOrganization(await resolveOrgContext(member.actor, a.org.slug)))).toBe("ok");
    expect(await roleOf(a.org.id, member.memberId)).toBeUndefined();
    expect(await ownersOf(a.org.id)).toContain(a.user.id);
  });
});

describe("a change of role counts from the next request", () => {
  it("demoted: the next context holds less, and the context of a request already under way can do nothing with what it held", async () => {
    const a = await newTenant();
    const admin = await addMember(a.org, "admin");
    const target = await addMember(a.org, "viewer");
    expect(canManageMembers(admin.ctx)).toBe(true);

    await changeMemberRole(a.ctx, { memberId: admin.memberId, role: "viewer" });

    const next = await resolveOrgContext(admin.actor, a.org.slug);
    expect(next.permissions).toBe(permissionsForRole("viewer"));
    expect(canManageMembers(next)).toBe(false);
    expect((await refusalOf(() => changeMemberRole(next, { memberId: target.memberId, role: "editor" }))).kind).toBe("Forbidden");

    // The earlier context is a record of the moment it was resolved, and it is not edited…
    expect(admin.ctx.membership.role).toBe("admin");
    // …but the services ask again, of the role as it is now, under the organization lock.
    expect((await refusalOf(() => changeMemberRole(admin.ctx, { memberId: target.memberId, role: "editor" }))).kind).toBe("Forbidden");
    expect((await refusalOf(() => removeMember(admin.ctx, { memberId: target.memberId }))).kind).toBe("Forbidden");
    expect(await roleOf(a.org.id, target.memberId)).toBe("viewer");
  });

  it("an Owner who stepped down cannot rename or hand over the organization with a context from before", async () => {
    const a = await newTenant();
    const second = await addMember(a.org, "owner");
    const other = await addMember(a.org, "editor");
    await changeMemberRole(a.ctx, { memberId: second.memberId, role: "admin" });

    expect(canUpdateOrganization(second.ctx)).toBe(true); // what the stale context still says
    expect((await refusalOf(() => updateOrganization(second.ctx, { name: "Too Late" }))).kind).toBe("Forbidden");
    expect((await refusalOf(() => transferOwnership(second.ctx, { memberId: other.memberId }))).kind).toBe("Forbidden");
    expect(await nameOf(a.org.id)).toBe(a.org.name);
    expect(await ownersOf(a.org.id)).toEqual([a.user.id]);
  });

  it("promoted: the next context holds more", async () => {
    const a = await newTenant();
    const member = await addMember(a.org, "viewer");
    const other = await addMember(a.org, "author");
    await changeMemberRole(a.ctx, { memberId: member.memberId, role: "admin" });

    // A context from before the promotion is still a Viewer's.
    expect((await refusalOf(() => removeMember(member.ctx, { memberId: other.memberId }))).kind).toBe("Forbidden");
    const next = await resolveOrgContext(member.actor, a.org.slug);
    expect(next.permissions).toBe(permissionsForRole("admin"));
    await removeMember(next, { memberId: other.memberId });
    expect(await roleOf(a.org.id, other.memberId)).toBeUndefined();
  });

  it("removed: no context on the next request, and nothing to be done with the old one", async () => {
    const a = await newTenant();
    const admin = await addMember(a.org, "admin");
    const target = await addMember(a.org, "viewer");
    await removeMember(a.ctx, { memberId: admin.memberId });

    expect((await refusalOf(() => resolveOrgContext(admin.actor, a.org.slug))).kind).toBe("NotFound");
    // No longer a member: the organization is not theirs to be told anything about.
    expect((await refusalOf(() => changeMemberRole(admin.ctx, { memberId: target.memberId, role: "editor" }))).kind).toBe("NotFound");
    expect((await refusalOf(() => removeMember(admin.ctx, { memberId: target.memberId }))).kind).toBe("NotFound");
    expect(await roleOf(a.org.id, target.memberId)).toBe("viewer");
  });

  it("holds under concurrency: two Admins demoting each other at once, and only one of them still could", async () => {
    for (let round = 0; round < 3; round++) {
      const a = await newTenant();
      const [one, two] = [await addMember(a.org, "admin"), await addMember(a.org, "admin")];
      const results = await Promise.allSettled([
        changeMemberRole(one.ctx, { memberId: two.memberId, role: "viewer" }),
        changeMemberRole(two.ctx, { memberId: one.memberId, role: "viewer" }),
      ]);
      // Both held the permission when their requests began. Whoever came second had lost it by the time they held the lock.
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(refused.reason).toMatchObject({ kind: "Forbidden" });
      expect([await roleOf(a.org.id, one.memberId), await roleOf(a.org.id, two.memberId)].sort()).toEqual(["admin", "viewer"]);
    }
  });
});

describe("nobody can give themselves a permission", () => {
  it("nothing a member sends becomes one: not a field in the input, not something passed to the resolver", async () => {
    const a = await newTenant();
    const viewer = await addMember(a.org, "viewer");
    const claims = { role: "owner", actorRole: "owner", permissions: [...PERMISSIONS], membership: { role: "owner" }, userId: a.user.id, organizationId: a.org.id };

    expect((await refusalOf(() => updateOrganization(viewer.ctx, { name: "Mine Now", ...claims } as { name: string }))).kind).toBe("Forbidden");
    expect((await refusalOf(() => changeMemberRole(viewer.ctx, { ...claims, memberId: viewer.memberId, role: "owner" }))).kind).toBe("Forbidden");
    expect((await refusalOf(() => transferOwnership(viewer.ctx, { ...claims, memberId: viewer.memberId }))).kind).toBe("Forbidden");

    // The actor's user id is the one thing that is believed, and it comes from the session (modules/auth), never from input.
    const loudActor = { ...viewer.actor, role: "owner", permissions: [...PERMISSIONS], membership: { role: "owner" }, organizationId: a.org.id } as unknown as Actor;
    const ctx = await resolveOrgContext(loudActor, a.org.slug, { requestId: "r", ...claims, permissions: permissionsForRole("owner") } as { requestId: string });
    expect(ctx.permissions).toBe(permissionsForRole("viewer"));
    expect(ctx.membership.role).toBe("viewer");
    expect(ctx.actor).toEqual(loudActor); // the actor is whoever authentication said; it carries no authority here
    expect(can(ctx, "org.manage")).toBe(false);

    expect(await nameOf(a.org.id)).toBe(a.org.name);
    expect(await roleOf(a.org.id, viewer.memberId)).toBe("viewer");
  });

  it("a context is not something that can be written: a copy with the Owner's permissions put in is refused everywhere", async () => {
    const a = await newTenant();
    const viewer = await addMember(a.org, "viewer");
    const target = await addMember(a.org, "author");
    const forgeries = [
      { ...viewer.ctx, permissions: a.ctx.permissions },
      { ...viewer.ctx, permissions: a.ctx.permissions, membership: a.ctx.membership },
      { ...a.ctx, actor: viewer.ctx.actor }, // the Owner's context with somebody else in it
      { ...a.ctx },
      { requestId: "", actor: viewer.actor, org: a.ctx.org, membership: { id: viewer.memberId, role: "owner" }, permissions: permissionsForRole("owner") },
    ] as unknown as OrgContext[];

    for (const forged of forgeries) {
      expect(isContext(forged)).toBe(false);
      for (const key of PERMISSIONS) expect(can(forged, key, { organizationId: a.org.id, ownerId: viewer.user.id })).toBe(false);
      expect(() => requirePermission(forged, "entries.page.read")).toThrow(/must come from resolveOrgContext/);
      await expect(updateOrganization(forged, { name: "Forged" })).rejects.toThrow(/must come from resolveOrgContext/);
      await expect(changeMemberRole(forged, { memberId: target.memberId, role: "owner" })).rejects.toThrow(/must come from resolveOrgContext/);
      await expect(removeMember(forged, { memberId: target.memberId })).rejects.toThrow(/must come from resolveOrgContext/);
      await expect(transferOwnership(forged, { memberId: target.memberId })).rejects.toThrow(/must come from resolveOrgContext/);
      await expect(leaveOrganization(forged)).rejects.toThrow(/must come from resolveOrgContext/);
    }
    // With no context at all, the answer is the same.
    for (const nothing of [undefined, null] as unknown as OrgContext[]) {
      expect(can(nothing, "entries.page.read")).toBe(false);
      expect(() => requirePermission(nothing, "entries.page.read")).toThrow(/must come from resolveOrgContext/);
      await expect(removeMember(nothing, { memberId: target.memberId })).rejects.toThrow(/must come from resolveOrgContext/);
    }
    expect(await nameOf(a.org.id)).toBe(a.org.name);
    expect((await membersOf(a.org.id)).map((m) => m.role).sort()).toEqual(["author", "owner", "viewer"]);
  });

  it("managing members does not reach what only an Owner holds", async () => {
    const a = await newTenant();
    const admin = await addMember(a.org, "admin");
    const other = await addMember(a.org, "editor");

    // Everything member management allows an Admin: up to their own level, and no further.
    await changeMemberRole(admin.ctx, { memberId: other.memberId, role: "admin" });
    for (const memberId of [admin.memberId, other.memberId]) {
      expect((await refusalOf(() => changeMemberRole(admin.ctx, { memberId, role: "owner" }))).kind).toBe("Forbidden");
      expect((await refusalOf(() => transferOwnership(admin.ctx, { memberId }))).kind).toBe("Forbidden");
    }
    expect((await refusalOf(() => updateOrganization(admin.ctx, { name: "Admin's" }))).kind).toBe("Forbidden");

    const again = await resolveOrgContext(admin.actor, a.org.slug);
    for (const key of ["org.manage", "org.billing.manage", "sites.delete"] as const) expect(can(again, key), key).toBe(false);
    expect(await ownersOf(a.org.id)).toEqual([a.user.id]);
  });

  it("the application's database role cannot redefine what a role is", async () => {
    const a = await newTenant();
    const attempts = [
      (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => tx.insert(t.roles).values({ organizationId: a.org.id, key: "owner", name: "Owner" }),
      (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => tx.update(t.roles).set({ key: "owner" }).where(eq(t.roles.key, "viewer")),
      (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => tx.delete(t.roles).where(eq(t.roles.key, "owner")),
    ];
    for (const attempt of attempts) {
      expect((await dbError(withTenant({ orgId: a.org.id, userId: a.user.id }, attempt))).code).toBe(PG.insufficientPrivilege);
      expect((await dbError(withUser(a.user.id, attempt as never))).code).toBe(PG.insufficientPrivilege);
      expect((await dbError(withPlatform(attempt as never))).code).toBe(PG.insufficientPrivilege);
    }
    const rows = await withPlatform((tx) => tx.select({ key: t.roles.key, organizationId: t.roles.organizationId }).from(t.roles));
    expect(rows.map((r) => r.key).sort()).toEqual([...ROLE_KEYS].sort());
    expect(rows.every((r) => r.organizationId === null)).toBe(true);
  });

  it("a role row the code does not define gives its member nothing, even one that is named owner", async () => {
    const a = await newTenant();
    // Rows only the schema owner could write: a role belonging to the organization that calls itself "owner",
    // and a platform-wide role with a key that is not one of the five.
    const cases = [
      { roleRow: uuidv7(), organizationId: a.org.id as string | null, key: "owner", user: await createUser() },
      { roleRow: uuidv7(), organizationId: null as string | null, key: "superuser", user: await createUser() },
    ];
    await asOwner(async (owner) => {
      for (const c of cases) {
        await owner.query("begin");
        await owner.query("select set_config('app.org_id', $1, true)", [a.org.id]);
        await owner.query("insert into roles (id, organization_id, key, name) values ($1, $2, $3, 'Made Up')", [c.roleRow, c.organizationId, c.key]);
        await owner.query("insert into organization_members (id, organization_id, user_id, role_id) values ($1, $2, $3, $4)", [uuidv7(), a.org.id, c.user.id, c.roleRow]);
        await owner.query("commit");
      }
    });
    try {
      for (const c of cases) {
        const actor = actorOf(c.user);
        expect((await refusalOf(() => resolveOrgContext(actor, a.org.slug))).kind, c.key).toBe("NotFound");
        expect(await listOrganizations(actor), c.key).toEqual([]);
      }
      // They are not members as far as anyone can see, and the made-up "owner" does not count as an Owner:
      expect((await listMembers(a.ctx)).map((m) => m.userId)).toEqual([a.user.id]);
      expect(await refusalOf(() => leaveOrganization(a.ctx))).toMatchObject({ kind: "Conflict" }); // the real one is still the last
    } finally {
      await asOwner(async (owner) => {
        await owner.query("begin");
        await owner.query("select set_config('app.org_id', $1, true)", [a.org.id]);
        await owner.query("delete from organization_members where role_id = any($1::uuid[])", [cases.map((c) => c.roleRow)]);
        await owner.query("delete from roles where id = any($1::uuid[])", [cases.map((c) => c.roleRow)]);
        await owner.query("commit");
      });
    }
  });
});

describe("a permission is the right to attempt; the membership rules still decide", () => {
  it("an Admin holds org.members.manage and still cannot make, change or remove an Owner", async () => {
    const a = await newTenant();
    const admin = await addMember(a.org, "admin");
    expect(canManageMembers(admin.ctx)).toBe(true);

    const owner = a.ctx.membership.id;
    expect((await refusalOf(() => changeMemberRole(admin.ctx, { memberId: owner, role: "viewer" }))).kind).toBe("Forbidden");
    expect((await refusalOf(() => removeMember(admin.ctx, { memberId: owner }))).kind).toBe("Forbidden");
    expect((await refusalOf(() => changeMemberRole(admin.ctx, { memberId: admin.memberId, role: "owner" }))).kind).toBe("Forbidden");
    expect(await ownersOf(a.org.id)).toEqual([a.user.id]);
  });

  it("the Owner holds every permission and still cannot leave the organization without one", async () => {
    const a = await newTenant();
    expect(a.ctx.permissions.list).toHaveLength(PERMISSIONS.length);
    const self = a.ctx.membership.id;
    // 409, not 403: they are allowed to attempt it; the state it would leave is what is refused.
    expect((await refusalOf(() => changeMemberRole(a.ctx, { memberId: self, role: "admin" }))).kind).toBe("Conflict");
    expect((await refusalOf(() => removeMember(a.ctx, { memberId: self }))).kind).toBe("Conflict");
    expect((await refusalOf(() => leaveOrganization(a.ctx))).kind).toBe("Conflict");
    expect(await ownersOf(a.org.id)).toEqual([a.user.id]);
  });
});

describe("outside the organization: NotFound. Inside it without the permission: Forbidden", () => {
  it("a member without the permission gets one answer whatever they name, so the answer says nothing about what exists", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const viewer = await addMember(a.org, "viewer");
    const colleague = await addMember(a.org, "editor");
    const named = [colleague.memberId, a.ctx.membership.id, b.ctx.membership.id, b.org.id, b.user.id, uuidv7(), "not-a-uuid", ""];

    const answers = new Set<string>();
    for (const memberId of named) {
      for (const attempt of [
        () => changeMemberRole(viewer.ctx, { memberId, role: "editor" }),
        () => removeMember(viewer.ctx, { memberId }),
        () => transferOwnership(viewer.ctx, { memberId }),
      ]) {
        const refusal = await refusalOf(attempt);
        answers.add(`${refusal.kind}: ${refusal.message}`);
      }
    }
    expect([...answers]).toEqual([`Forbidden: ${FORBIDDEN}`]);
    // Refused before the input is looked at at all.
    expect((await refusalOf(() => changeMemberRole(viewer.ctx, { memberId: colleague.memberId, role: "superuser" as RoleKey }))).kind).toBe("Forbidden");
    expect((await refusalOf(() => updateOrganization(viewer.ctx, { slug: "login" }))).kind).toBe("Forbidden");
    expect((await refusalOf(() => updateOrganization(viewer.ctx, {}))).kind).toBe("Forbidden");
  });

  it("with the permission, another organization's member is NotFound, exactly like one that does not exist", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const admin = await addMember(a.org, "admin");
    for (const ctx of [a.ctx, admin.ctx]) {
      const foreign = await refusalOf(() => changeMemberRole(ctx, { memberId: b.ctx.membership.id, role: "viewer" }));
      const missing = await refusalOf(() => changeMemberRole(ctx, { memberId: uuidv7(), role: "viewer" }));
      expect({ kind: foreign.kind, message: foreign.message }).toEqual({ kind: "NotFound", message: missing.message });
      expect((await refusalOf(() => removeMember(ctx, { memberId: b.ctx.membership.id }))).kind).toBe("NotFound");
    }
    expect((await membersOf(b.org.id)).map((m) => m.role)).toEqual(["owner"]);
  });

  it("someone who is not a member is never told Forbidden: an organization they are not in does not exist for them", async () => {
    const a = await newTenant();
    const b = await newTenant();
    for (const role of ROLE_KEYS) {
      const member = await addMember(a.org, role);
      expect((await refusalOf(() => resolveOrgContext(member.actor, b.org.slug))).kind, role).toBe("NotFound");
    }
  });
});

describe("one organization's permissions are worth nothing in another", () => {
  it("a user in two organizations has each one's role there, and neither one's anywhere else", async () => {
    const [a, b, c] = [await newTenant("Alpha"), await newTenant("Beta"), await newTenant("Gamma")];
    const inB = (await addUser(b.org, a.user, "viewer")).memberId;
    const asViewerOfB = await resolveOrgContext(a.actor, b.org.slug);

    expect(a.ctx.permissions).toBe(permissionsForRole("owner"));
    expect(asViewerOfB.permissions).toBe(permissionsForRole("viewer"));
    expect(can(asViewerOfB, "org.manage")).toBe(false);
    expect((await refusalOf(() => updateOrganization(asViewerOfB, { name: "Alpha Took Over" }))).kind).toBe("Forbidden");
    expect((await refusalOf(() => changeMemberRole(asViewerOfB, { memberId: inB, role: "owner" }))).kind).toBe("Forbidden");
    expect((await refusalOf(() => transferOwnership(asViewerOfB, { memberId: inB }))).kind).toBe("Forbidden");

    // Being the Owner of Alpha does not reach their own membership row in Beta: from Alpha it is not found.
    expect((await refusalOf(() => changeMemberRole(a.ctx, { memberId: inB, role: "owner" }))).kind).toBe("NotFound");
    expect((await refusalOf(() => transferOwnership(a.ctx, { memberId: b.ctx.membership.id }))).kind).toBe("NotFound");
    // And two memberships add up to nothing in a third organization.
    expect((await refusalOf(() => resolveOrgContext(a.actor, c.org.slug))).kind).toBe("NotFound");

    expect(await nameOf(b.org.id)).toBe(b.org.name);
    expect(await roleOf(b.org.id, inB)).toBe("viewer");
    expect(await ownersOf(b.org.id)).toEqual([b.user.id]);
  });

  it("a thing that belongs to another organization satisfies no permission, even for the person who made it: RBAC, policy and RLS each refuse", async () => {
    const a = await newTenant();
    const b = await newTenant();
    // One person: an Author in both. In B they wrote an entry.
    const person = await addMember(a.org, "author");
    await addUser(b.org, person.user, "author");
    const siteOfB = await createSite(b.org.id, b.user.id);
    const { entry } = await createPublishedEntry({ orgId: b.org.id, siteId: siteOfB.id, userId: person.user.id });
    const theirEntryInB = { organizationId: entry.organizationId, ownerId: entry.authorId };
    expect(theirEntryInB).toEqual({ organizationId: b.org.id, ownerId: person.user.id });

    // Policy: from A's context it is nobody's to touch, for its author and for A's Owner alike.
    for (const ctx of [person.ctx, a.ctx]) {
      for (const key of PERMISSIONS) expect(can(ctx, key, theirEntryInB), key).toBe(false);
      for (const scope of ["entries.post.update", "entries.post.publish", "entries.post.delete", "media.update", "media.delete"] as const) {
        expect(canActOn(ctx, scope, theirEntryInB), scope).toBe(false);
      }
      expect((await refusalOf(() => requirePermission(ctx, "entries.post.update.own", theirEntryInB))).kind).toBe("Forbidden");
    }
    // In B's own context the same thing is theirs, so the refusal above is about the organization and nothing else.
    const inB = await resolveOrgContext(person.actor, b.org.slug);
    expect(can(inB, "entries.post.update.own", theirEntryInB)).toBe(true);
    expect(canActOn(inB, "entries.post.delete", theirEntryInB)).toBe(true);

    // RLS: a transaction of A cannot see the row to begin with, whoever asks.
    for (const ctx of [person.ctx, a.ctx]) {
      expect(await inTenant(ctx, (tx) => tx.select({ id: t.entries.id }).from(t.entries).where(eq(t.entries.id, entry.id)))).toEqual([]);
      const touched = await inTenant(ctx, (tx) => tx.update(t.entries).set({ title: "Taken" }).where(eq(t.entries.id, entry.id)).returning({ id: t.entries.id }));
      expect(touched).toEqual([]);
    }
    expect(await inTenant(inB, (tx) => tx.select({ title: t.entries.title }).from(t.entries).where(eq(t.entries.id, entry.id)))).toEqual([{ title: "Hello" }]);
  });
});

describe("a suspended organization hands out no permissions", () => {
  it("to any role, the Owner included; and gives them back when it is active again", async () => {
    const a = await newTenant();
    const members = [];
    for (const role of ROLE_KEYS) members.push({ role, ...(await addMember(a.org, role)) });
    const outsider = actorOf(await createUser());
    const setStatus = (status: "active" | "suspended") =>
      withTenant({ orgId: a.org.id }, (tx) => tx.update(t.organizations).set({ status }).where(eq(t.organizations.id, a.org.id)));

    await setStatus("suspended");
    for (const member of members) {
      const refusal = await refusalOf(() => resolveOrgContext(member.actor, a.org.slug));
      expect({ kind: refusal.kind, message: refusal.message }, member.role).toEqual({ kind: "Forbidden", message: "This organization has been suspended." });
      const site = await refusalOf(() => resolveSiteContext(member.actor, a.org.slug, "any-site"));
      expect(site.kind, member.role).toBe("Forbidden");
    }
    // Someone who is not a member still learns nothing, not even that it is suspended.
    expect((await refusalOf(() => resolveOrgContext(outsider, a.org.slug))).kind).toBe("NotFound");

    await setStatus("active");
    for (const member of members) {
      expect((await resolveOrgContext(member.actor, a.org.slug)).permissions, member.role).toBe(permissionsForRole(member.role));
    }
  });
});

describe("the public site has no permissions in it", () => {
  it("what an address resolves to is a site, not a context: it can be asked for nothing and used for nothing", async () => {
    const a = await newTenant();
    const site = await createSite(a.org.id, a.user.id);
    // What the renderer does for `/s/{address}`: the address, and nothing about who is asking.
    const [resolved] = await withPlatform((tx) =>
      tx
        .select({ siteId: t.domains.siteId, orgId: t.domains.organizationId })
        .from(t.domains)
        .where(and(eq(t.domains.hostname, site.slug), eq(t.domains.kind, "subdomain"), eq(t.domains.status, "active"))),
    );
    expect(resolved).toEqual({ siteId: site.id, orgId: a.org.id });

    const asContext = resolved as unknown as OrgContext;
    expect(isContext(asContext)).toBe(false);
    for (const key of PERMISSIONS) expect(can(asContext, key, { organizationId: a.org.id, ownerId: a.user.id }), key).toBe(false);
    expect(() => requirePermission(asContext, "entries.page.read")).toThrow(/must come from resolveOrgContext/);
    await expect(listMembers(asContext)).rejects.toThrow(/must come from resolveOrgContext/);

    // A visitor is anonymous: the admin resolver gives them no context, for this organization's own slugs or its address.
    const anonymous: Actor = { kind: "anonymous" };
    expect((await refusalOf(() => resolveOrgContext(anonymous, a.org.slug))).kind).toBe("Unauthenticated");
    expect((await refusalOf(() => resolveSiteContext(anonymous, a.org.slug, site.slug))).kind).toBe("Unauthenticated");
  });
});
