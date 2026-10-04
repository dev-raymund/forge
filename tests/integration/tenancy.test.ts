import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import pg from "pg";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import type { Actor } from "@/modules/auth/shared";
import { TRIAL_DAYS } from "@/modules/billing";
import { findSiteBySlug, siteAddress } from "@/modules/sites";
import {
  assertContext, canAccessSite, changeMemberRole, createOrganization, inTenant, leaveOrganization, listMembers, listOrganizations, removeMember,
  resolveOrgContext, resolveSiteContext, transferOwnership, updateOrganization, type OrgContext, type RoleKey,
} from "@/modules/tenancy";
import * as t from "@/platform/db/schema";
import { withPlatform, withTenant, withUser } from "@/platform/db/tenant";
import { isAppError } from "@/platform/errors";
import { dbError, PG } from "../fixtures/db-error";
import { createSite, createUser, roleId } from "../fixtures/factories";

/**
 * M3-1: the tenancy module against real Postgres, as forge_app through
 * PgBouncer. Two kinds of proof side by side:
 *  - the services (organizations, members, the resolver) refuse what they must;
 *  - the database refuses it too, with the service out of the picture.
 */

const unique = () => randomBytes(4).toString("hex");
const slug = (prefix = "org") => `${prefix}-${unique()}`;
const actorOf = (user: { id: string }): Actor => ({ kind: "user", userId: user.id, sessionId: uuidv7(), emailVerified: true });
const ANONYMOUS: Actor = { kind: "anonymous" };

/** A user with their own organization, and the context of that user in it. */
async function newTenant(name = "Tenant") {
  const user = await createUser({ name: `${name} Owner` });
  const actor = actorOf(user);
  const org = await createOrganization(actor, { name: `${name} ${unique()}`, slug: slug() });
  const ctx = await resolveOrgContext(actor, org.slug);
  return { user, actor, org, ctx };
}

/** Membership rows are created by accepting an invitation (M3-4); until then tests insert them the same way. */
async function addMember(org: { id: string }, role: RoleKey, name = `A ${role}`) {
  const user = await createUser({ name });
  const [member] = await withTenant({ orgId: org.id }, async (tx) =>
    tx.insert(t.organizationMembers).values({ organizationId: org.id, userId: user.id, roleId: await roleId(tx, role) }).returning(),
  );
  return { user, actor: actorOf(user), memberId: member!.id };
}
const contextOf = (actor: Actor, org: { slug: string }) => resolveOrgContext(actor, org.slug);

async function failureOf(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error("expected the operation to be refused");
}

const membersOf = (orgId: string) =>
  withTenant({ orgId }, (tx) =>
    tx
      .select({ id: t.organizationMembers.id, userId: t.organizationMembers.userId, role: t.roles.key })
      .from(t.organizationMembers)
      .innerJoin(t.roles, eq(t.roles.id, t.organizationMembers.roleId))
      .where(eq(t.organizationMembers.organizationId, orgId)),
  );
const rolesOf = async (orgId: string) => (await membersOf(orgId)).map((m) => m.role).sort();
const ownersOf = async (orgId: string) => (await membersOf(orgId)).filter((m) => m.role === "owner").length;
const orgRow = async (orgId: string) => (await withTenant({ orgId }, (tx) => tx.select().from(t.organizations).where(eq(t.organizations.id, orgId))))[0];

/** DDL as the schema owner, for the tests that need the database to fail on cue. */
async function asOwner<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: process.env.TEST_WORKER_OWNER_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

describe("creating an organization", () => {
  it("creates the organization, its Owner and its trial together, and the creator is the Owner", async () => {
    const user = await createUser();
    const before = Date.now();
    const org = await createOrganization(actorOf(user), { name: "  Acme Studio ", slug: ` ACME-${unique()} ` });

    expect(org).toMatchObject({ name: "Acme Studio", status: "active", role: "owner" });
    expect(org.slug).toMatch(/^acme-[0-9a-f]{8}$/); // one spelling: trimmed, lowercased
    expect(org.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);

    expect(await orgRow(org.id)).toMatchObject({ id: org.id, name: "Acme Studio", slug: org.slug, status: "active", createdBy: user.id, deletedAt: null });
    expect(await membersOf(org.id)).toEqual([{ id: expect.any(String), userId: user.id, role: "owner" }]);
    const [subscription] = await withTenant({ orgId: org.id }, (tx) => tx.select().from(t.subscriptions));
    expect(subscription).toMatchObject({ organizationId: org.id, planKey: "pro", status: "trialing" });
    const trialDays = (subscription!.trialEndsAt!.getTime() - before) / (24 * 3600 * 1000);
    expect(trialDays).toBeGreaterThan(TRIAL_DAYS - 0.01);
    expect(trialDays).toBeLessThan(TRIAL_DAYS + 0.01);
  });

  it.each([
    ["the Owner membership", "organization_members"],
    ["the trial subscription", "subscriptions"],
  ])("is atomic: if %s cannot be written, no organization is left behind", async (_what, table) => {
    const user = await createUser();
    const wanted = slug("atomic");
    const trigger = `tenancy_test_fail_${unique()}`;
    await asOwner(async (owner) => {
      await owner.query(`create function ${trigger}() returns trigger language plpgsql as $$ begin raise exception 'forced failure'; end $$`);
      await owner.query(`create trigger ${trigger} before insert on ${table} for each row execute function ${trigger}()`);
    });
    try {
      await expect(createOrganization(actorOf(user), { name: "Half Made", slug: wanted })).rejects.toThrow();
    } finally {
      await asOwner(async (owner) => {
        await owner.query(`drop trigger ${trigger} on ${table}`);
        await owner.query(`drop function ${trigger}()`);
      });
    }
    // Nothing committed: no organization, so nothing for the user to be a member of, and the slug is still free.
    expect(await listOrganizations(actorOf(user))).toEqual([]);
    const made = await createOrganization(actorOf(user), { name: "Whole", slug: wanted });
    expect(await rolesOf(made.id)).toEqual(["owner"]);
  });

  it("refuses reserved, malformed and too-short slugs, and an empty name, before touching the database", async () => {
    const actor = actorOf(await createUser());
    for (const [input, field] of [
      [{ name: "Acme", slug: "login" }, "slug"],
      [{ name: "Acme", slug: "settings" }, "slug"],
      [{ name: "Acme", slug: "acme studio" }, "slug"],
      [{ name: "Acme", slug: "ab" }, "slug"],
      [{ name: "Acme", slug: "../acme" }, "slug"],
      [{ name: "   ", slug: slug() }, "name"],
    ] as const) {
      const error = await failureOf(() => createOrganization(actor, input));
      expect(error.kind, JSON.stringify(input)).toBe("Validation");
      expect(Object.keys(error.fieldErrors ?? {})).toEqual([field]);
    }
    expect(await listOrganizations(actor)).toEqual([]);
  });

  it("a slug belongs to one organization, whatever the casing", async () => {
    const { org } = await newTenant();
    const other = actorOf(await createUser());
    for (const taken of [org.slug, org.slug.toUpperCase(), ` ${org.slug} `]) {
      const error = await failureOf(() => createOrganization(other, { name: "Copycat", slug: taken }));
      expect(error).toMatchObject({ kind: "Validation", fieldErrors: { slug: ["That URL is already taken."] } });
    }
    expect(await listOrganizations(other)).toEqual([]);
  });

  it("needs a signed-in user; the caller cannot name another owner, an id or a status", async () => {
    expect((await failureOf(() => createOrganization(ANONYMOUS, { name: "Nobody's", slug: slug() }))).kind).toBe("Unauthenticated");

    const user = await createUser();
    const victim = await createUser();
    const forged = { name: "Forged", slug: slug(), id: uuidv7(), ownerId: victim.id, userId: victim.id, createdBy: victim.id, status: "suspended", role: "viewer" };
    const org = await createOrganization(actorOf(user), forged);
    expect(org.id).not.toBe(forged.id);
    expect(await orgRow(org.id)).toMatchObject({ createdBy: user.id, status: "active" });
    expect(await membersOf(org.id)).toEqual([{ id: expect.any(String), userId: user.id, role: "owner" }]);
    expect(await listOrganizations(actorOf(victim))).toEqual([]);
  });
});

describe("the organizations a user can see", () => {
  it("lists the caller's own organizations with their role in each, and nothing of anyone else's", async () => {
    const a = await newTenant("Alpha");
    const b = await newTenant("Beta");
    const second = await createOrganization(a.actor, { name: "Alpha Second", slug: slug() });
    const guest = await addMember(b.org, "viewer");

    expect((await listOrganizations(a.actor)).map((o) => [o.id, o.role]).sort()).toEqual([[a.org.id, "owner"], [second.id, "owner"]].sort());
    expect(await listOrganizations(b.actor)).toEqual([{ id: b.org.id, slug: b.org.slug, name: b.org.name, status: "active", role: "owner" }]);
    expect(await listOrganizations(guest.actor)).toEqual([expect.objectContaining({ id: b.org.id, role: "viewer" })]);
    expect((await failureOf(() => listOrganizations(ANONYMOUS))).kind).toBe("Unauthenticated");
  });

  it("a deleted organization disappears; a suspended one is listed as suspended", async () => {
    const a = await newTenant();
    const gone = await createOrganization(a.actor, { name: "Gone", slug: slug() });
    const frozen = await createOrganization(a.actor, { name: "Frozen", slug: slug() });
    await withTenant({ orgId: gone.id }, (tx) => tx.update(t.organizations).set({ deletedAt: new Date() }).where(eq(t.organizations.id, gone.id)));
    await withTenant({ orgId: frozen.id }, (tx) => tx.update(t.organizations).set({ status: "suspended" }).where(eq(t.organizations.id, frozen.id)));

    const listed = await listOrganizations(a.actor);
    expect(listed.map((o) => o.id)).not.toContain(gone.id);
    expect(listed.find((o) => o.id === frozen.id)).toMatchObject({ status: "suspended" });
  });
});

describe("the tenant resolver: session user → organization slug → membership", () => {
  it("gives a member the context of their organization, with their role", async () => {
    const { user, actor, org } = await newTenant();
    const ctx = await resolveOrgContext(actor, org.slug, { requestId: "req-123", ip: "203.0.113.9" });
    expect(ctx).toMatchObject({
      requestId: "req-123", ip: "203.0.113.9",
      actor: { kind: "user", userId: user.id },
      org: { id: org.id, slug: org.slug, name: org.name },
      membership: { role: "owner" },
    });
    const editor = await addMember(org, "editor");
    expect((await resolveOrgContext(editor.actor, org.slug)).membership).toEqual({ id: editor.memberId, role: "editor" });
  });

  it("answers NotFound, identically, for a slug that does not exist and for an organization the user is not in", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const unknown = await failureOf(() => resolveOrgContext(a.actor, slug("nobody")));
    const notMine = await failureOf(() => resolveOrgContext(a.actor, b.org.slug));
    expect(unknown.kind).toBe("NotFound");
    expect({ kind: notMine.kind, message: notMine.message }).toEqual({ kind: unknown.kind, message: unknown.message });
  });

  it("does not ask the database about things that are not slugs", async () => {
    const { actor, org } = await newTenant();
    for (const input of [org.slug.toUpperCase(), ` ${org.slug}`, `${org.slug}/sites`, `${org.slug}'--`, "", "x".repeat(200), "..", "%00", org.id]) {
      expect((await failureOf(() => resolveOrgContext(actor, input))).kind, JSON.stringify(input)).toBe("NotFound");
    }
    expect((await failureOf(() => resolveOrgContext(actor, undefined as unknown as string))).kind).toBe("NotFound");
  });

  it("needs a signed-in user", async () => {
    const { org } = await newTenant();
    expect((await failureOf(() => resolveOrgContext(ANONYMOUS, org.slug))).kind).toBe("Unauthenticated");
  });

  it("a deleted organization is NotFound even for its Owner; a suspended one is Forbidden for its members and NotFound for everyone else", async () => {
    const a = await newTenant();
    const outsider = actorOf(await createUser());
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.organizations).set({ status: "suspended" }).where(eq(t.organizations.id, a.org.id)));
    expect(await failureOf(() => resolveOrgContext(a.actor, a.org.slug))).toMatchObject({ kind: "Forbidden", message: "This organization has been suspended." });
    expect((await failureOf(() => resolveOrgContext(outsider, a.org.slug))).kind).toBe("NotFound");

    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.organizations).set({ status: "active", deletedAt: new Date() }).where(eq(t.organizations.id, a.org.id)));
    expect((await failureOf(() => resolveOrgContext(a.actor, a.org.slug))).kind).toBe("NotFound");
  });

  it("someone who was removed is a stranger on their next request", async () => {
    const a = await newTenant();
    const member = await addMember(a.org, "editor");
    expect((await contextOf(member.actor, a.org)).membership.role).toBe("editor");
    await removeMember(a.ctx, { memberId: member.memberId });
    expect((await failureOf(() => contextOf(member.actor, a.org))).kind).toBe("NotFound");
  });

  it("a context cannot be assembled from ids: a cast, a hand-built object or an edited copy is refused", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const fakes = [
      { requestId: "", actor: a.actor, org: { id: b.org.id, slug: b.org.slug, name: "x" }, membership: { id: uuidv7(), role: "owner" } },
      { ...a.ctx, org: { ...a.ctx.org, id: b.org.id } }, // a real context, pointed at another organization
      { ...a.ctx },
      JSON.parse(JSON.stringify(a.ctx)) as unknown,
      null,
      "ctx",
    ] as unknown as OrgContext[];
    for (const fake of fakes) {
      expect(() => assertContext(fake)).toThrow(/must come from resolveOrgContext/);
      await expect(listMembers(fake)).rejects.toThrow(/must come from resolveOrgContext/);
      expect(() => inTenant(fake, async () => 1)).toThrow(/must come from resolveOrgContext/);
      await expect(updateOrganization(fake, { name: "Hijacked" })).rejects.toThrow(/must come from resolveOrgContext/);
    }
    expect(() => assertContext(a.ctx)).not.toThrow();
    // The genuine context itself cannot be edited in place.
    expect(() => ((a.ctx.org as { id: string }).id = b.org.id)).toThrow(TypeError);
    expect(() => ((a.ctx.membership as { role: string }).role = "owner")).toThrow(TypeError);
    expect((await orgRow(b.org.id))!.name).toBe(b.org.name);
  });
});

describe("the tenant resolver: … → site slug → the site belongs to the organization", () => {
  it("resolves a site of the caller's organization", async () => {
    const a = await newTenant();
    const site = await createSite(a.org.id, a.user.id, slug("site"));
    const ctx = await resolveSiteContext(a.actor, a.org.slug, site.slug);
    expect(ctx.site).toEqual({ id: site.id, slug: site.slug, name: site.name, status: "coming_soon" });
    expect(ctx.org.id).toBe(a.org.id);
    expect(canAccessSite(ctx, { organizationId: a.org.id })).toBe(true);
    // Every member of the organization reaches its sites (V1: roles are organization-wide).
    const viewer = await addMember(a.org, "viewer");
    expect((await resolveSiteContext(viewer.actor, a.org.slug, site.slug)).site.id).toBe(site.id);
  });

  it("another organization's site is NotFound through every door", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const siteB = await createSite(b.org.id, b.user.id, slug("site"));

    // B's site slug under A's organization; B's organization and site as A; a real slug that is nobody's.
    expect((await failureOf(() => resolveSiteContext(a.actor, a.org.slug, siteB.slug))).kind).toBe("NotFound");
    expect((await failureOf(() => resolveSiteContext(a.actor, b.org.slug, siteB.slug))).kind).toBe("NotFound");
    expect((await failureOf(() => resolveSiteContext(a.actor, a.org.slug, slug("ghost")))).kind).toBe("NotFound");
    expect((await failureOf(() => resolveSiteContext(a.actor, a.org.slug, siteB.id))).kind).toBe("NotFound");
    expect(canAccessSite(a.ctx, { organizationId: b.org.id })).toBe(false);
  });

  it("two organizations may use the same site slug, and each resolves its own", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const shared = slug("blog");
    const [siteA, siteB] = [await createSite(a.org.id, a.user.id, shared), await insertSiteWithAddress(b, shared, slug("addr"))];
    expect((await resolveSiteContext(a.actor, a.org.slug, shared)).site.id).toBe(siteA.id);
    expect((await resolveSiteContext(b.actor, b.org.slug, shared)).site.id).toBe(siteB.id);
  });

  it("a deleted site is NotFound; a site's public address is not its admin slug", async () => {
    const a = await newTenant();
    const site = await insertSiteWithAddress(a, slug("docs"), slug("public"));
    const address = await inTenant(a.ctx, (tx) => siteAddress(tx, site));
    expect(address).not.toBe(site.slug);
    expect((await failureOf(() => resolveSiteContext(a.actor, a.org.slug, address!))).kind).toBe("NotFound"); // the address is not an admin URL
    await inTenant(a.ctx, (tx) => tx.update(t.sites).set({ deletedAt: new Date() }).where(eq(t.sites.id, site.id)));
    expect((await failureOf(() => resolveSiteContext(a.actor, a.org.slug, site.slug))).kind).toBe("NotFound");
  });
});

/** A site whose admin slug and public address differ (the factory uses one value for both). */
async function insertSiteWithAddress(tenant: { org: { id: string }; user: { id: string } }, siteSlug: string, address: string) {
  return withTenant({ orgId: tenant.org.id, userId: tenant.user.id }, async (tx) => {
    const [site] = await tx.insert(t.sites).values({ organizationId: tenant.org.id, name: siteSlug, slug: siteSlug, createdBy: tenant.user.id }).returning();
    await tx.insert(t.siteSettings).values({ siteId: site!.id, organizationId: tenant.org.id, general: { tagline: `tagline of ${address}` } });
    await tx.insert(t.domains).values({ organizationId: tenant.org.id, siteId: site!.id, hostname: address, kind: "subdomain", isPrimary: true, status: "active" });
    return site!;
  });
}

describe("updating an organization", () => {
  it("an Owner renames it and changes its slug; the old slug stops resolving", async () => {
    const a = await newTenant();
    const next = slug("renamed");
    const updated = await updateOrganization(a.ctx, { name: "  New Name ", slug: next.toUpperCase() });
    expect(updated).toEqual({ id: a.org.id, name: "New Name", slug: next, status: "active", role: "owner" });
    expect((await resolveOrgContext(a.actor, next)).org.name).toBe("New Name");
    expect((await failureOf(() => resolveOrgContext(a.actor, a.org.slug))).kind).toBe("NotFound");
  });

  it("only an Owner can; everyone else in the organization is Forbidden, and nothing changes", async () => {
    const a = await newTenant();
    for (const role of ["admin", "editor", "author", "viewer"] as const) {
      const member = await addMember(a.org, role);
      const error = await failureOf(async () => updateOrganization(await contextOf(member.actor, a.org), { name: `By ${role}` }));
      expect(error.kind, role).toBe("Forbidden");
    }
    expect((await orgRow(a.org.id))!.name).toBe(a.org.name);
  });

  it("there is no way to aim it at another organization: the target is the context's, whatever else is sent", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const forged = { name: "Aimed At B", id: b.org.id, organizationId: b.org.id, slug: undefined } as unknown as { name: string };
    await updateOrganization(a.ctx, forged);
    expect((await orgRow(a.org.id))!.name).toBe("Aimed At B");
    expect((await orgRow(b.org.id))!.name).toBe(b.org.name);
  });

  it("validates like creation: reserved and taken slugs, empty input", async () => {
    const a = await newTenant();
    const b = await newTenant();
    expect((await failureOf(() => updateOrganization(a.ctx, { slug: "account" }))).fieldErrors).toEqual({ slug: ["That URL is reserved. Choose another."] });
    expect((await failureOf(() => updateOrganization(a.ctx, { slug: b.org.slug }))).fieldErrors).toEqual({ slug: ["That URL is already taken."] });
    expect((await failureOf(() => updateOrganization(a.ctx, {}))).kind).toBe("Validation");
    expect((await failureOf(() => updateOrganization(a.ctx, { name: " " }))).kind).toBe("Validation");
    expect((await orgRow(a.org.id))!.slug).toBe(a.org.slug);
  });

  it("uses the role the member has now, not the one in a context resolved earlier", async () => {
    const a = await newTenant();
    const second = await addMember(a.org, "owner");
    const stale = await contextOf(second.actor, a.org); // an Owner at this moment
    await changeMemberRole(a.ctx, { memberId: second.memberId, role: "viewer" });
    expect((await failureOf(() => updateOrganization(stale, { name: "Too Late" }))).kind).toBe("Forbidden");
  });
});

describe("members: who can change whom", () => {
  it("lists the members of this organization only, even for someone who belongs to several", async () => {
    const a = await newTenant("Alpha");
    const b = await newTenant("Beta");
    const editor = await addMember(a.org, "editor", "Edith Editor");
    // The same person also belongs to B.
    await withTenant({ orgId: b.org.id }, async (tx) =>
      tx.insert(t.organizationMembers).values({ organizationId: b.org.id, userId: a.user.id, roleId: await roleId(tx, "viewer") }),
    );

    const list = await listMembers(a.ctx);
    expect(list.map((m) => [m.userId, m.role]).sort()).toEqual([[a.user.id, "owner"], [editor.user.id, "editor"]].sort());
    expect(list.find((m) => m.userId === editor.user.id)).toMatchObject({ id: editor.memberId, name: "Edith Editor", email: editor.user.email });
    // Any member may see the list; a member of B sees B's.
    expect((await listMembers(await contextOf(editor.actor, a.org))).length).toBe(2);
    expect((await listMembers(b.ctx)).map((m) => m.userId).sort()).toEqual([a.user.id, b.user.id].sort());
  });

  it("a Viewer, Author or Editor cannot promote themselves or anyone else", async () => {
    const a = await newTenant();
    const other = await addMember(a.org, "viewer");
    for (const role of ["viewer", "author", "editor"] as const) {
      const member = await addMember(a.org, role);
      const ctx = await contextOf(member.actor, a.org);
      for (const [memberId, to] of [[member.memberId, "owner"], [member.memberId, "admin"], [other.memberId, "admin"], [a.ctx.membership.id, "viewer"]] as const) {
        expect((await failureOf(() => changeMemberRole(ctx, { memberId, role: to }))).kind, `${role} → ${to}`).toBe("Forbidden");
      }
      expect((await failureOf(() => removeMember(ctx, { memberId: other.memberId }))).kind).toBe("Forbidden");
      expect((await failureOf(() => transferOwnership(ctx, { memberId: member.memberId }))).kind).toBe("Forbidden");
    }
    expect((await rolesOf(a.org.id)).filter((r) => r === "owner")).toHaveLength(1);
  });

  it("an Admin manages the roles below Owner, and cannot make, change or remove an Owner", async () => {
    const a = await newTenant();
    const admin = await addMember(a.org, "admin");
    const editor = await addMember(a.org, "editor");
    const ctx = await contextOf(admin.actor, a.org);

    await changeMemberRole(ctx, { memberId: editor.memberId, role: "author" });
    expect((await membersOf(a.org.id)).find((m) => m.id === editor.memberId)!.role).toBe("author");

    expect((await failureOf(() => changeMemberRole(ctx, { memberId: editor.memberId, role: "owner" }))).kind).toBe("Forbidden");
    expect((await failureOf(() => changeMemberRole(ctx, { memberId: admin.memberId, role: "owner" }))).kind).toBe("Forbidden"); // themselves
    expect((await failureOf(() => changeMemberRole(ctx, { memberId: a.ctx.membership.id, role: "admin" }))).kind).toBe("Forbidden");
    expect((await failureOf(() => removeMember(ctx, { memberId: a.ctx.membership.id }))).kind).toBe("Forbidden");
    expect((await failureOf(() => transferOwnership(ctx, { memberId: admin.memberId }))).kind).toBe("Forbidden");

    await removeMember(ctx, { memberId: editor.memberId });
    expect((await membersOf(a.org.id)).map((m) => m.id)).not.toContain(editor.memberId);
  });

  it("an Owner can make another Owner; only then can the first step down", async () => {
    const a = await newTenant();
    const admin = await addMember(a.org, "admin");
    const self = a.ctx.membership.id;

    expect(await failureOf(() => changeMemberRole(a.ctx, { memberId: self, role: "admin" }))).toMatchObject({
      kind: "Conflict", message: "An organization needs at least one Owner. Make someone else an Owner first.",
    });
    await changeMemberRole(a.ctx, { memberId: admin.memberId, role: "owner" });
    expect(await ownersOf(a.org.id)).toBe(2);
    await changeMemberRole(a.ctx, { memberId: self, role: "admin" });
    expect(await ownersOf(a.org.id)).toBe(1);
    expect((await contextOf(a.actor, a.org)).membership.role).toBe("admin");
  });

  it("rejects a role that does not exist, and a member id that is not one", async () => {
    const a = await newTenant();
    const member = await addMember(a.org, "viewer");
    expect((await failureOf(() => changeMemberRole(a.ctx, { memberId: member.memberId, role: "superuser" as RoleKey }))).kind).toBe("Validation");
    for (const memberId of ["", "not-a-uuid", "1; drop table organization_members", uuidv7(), a.user.id, a.org.id]) {
      expect((await failureOf(() => changeMemberRole(a.ctx, { memberId, role: "editor" }))).kind, memberId).toBe("NotFound");
      expect((await failureOf(() => removeMember(a.ctx, { memberId }))).kind, memberId).toBe("NotFound");
      expect((await failureOf(() => transferOwnership(a.ctx, { memberId }))).kind, memberId).toBe("NotFound");
    }
    expect((await membersOf(a.org.id)).find((m) => m.id === member.memberId)!.role).toBe("viewer");
  });
});

describe("an organization always has an Owner", () => {
  it("the last Owner cannot be demoted, removed, or leave", async () => {
    const a = await newTenant();
    await addMember(a.org, "admin");
    const self = a.ctx.membership.id;
    for (const attempt of [
      () => changeMemberRole(a.ctx, { memberId: self, role: "viewer" }),
      () => removeMember(a.ctx, { memberId: self }),
      () => leaveOrganization(a.ctx),
    ]) {
      expect((await failureOf(attempt)).kind).toBe("Conflict");
    }
    expect(await ownersOf(a.org.id)).toBe(1);
    expect(await resolveOrgContext(a.actor, a.org.slug)).toBeDefined();
  });

  it("with a second Owner, either can leave or be removed, but never both", async () => {
    const a = await newTenant();
    const second = await addMember(a.org, "owner");
    const ctx2 = await contextOf(second.actor, a.org);

    await leaveOrganization(ctx2);
    expect(await ownersOf(a.org.id)).toBe(1);
    expect((await failureOf(() => leaveOrganization(a.ctx))).kind).toBe("Conflict");
    expect((await failureOf(() => contextOf(second.actor, a.org))).kind).toBe("NotFound"); // they really left
  });

  it("anyone else can leave", async () => {
    const a = await newTenant();
    for (const role of ["admin", "editor", "author", "viewer"] as const) {
      const member = await addMember(a.org, role);
      await leaveOrganization(await contextOf(member.actor, a.org));
      expect((await failureOf(() => contextOf(member.actor, a.org))).kind, role).toBe("NotFound");
    }
    expect(await rolesOf(a.org.id)).toEqual(["owner"]);
  });

  it("handing over: the other member becomes an Owner and the caller an Admin, together", async () => {
    const a = await newTenant();
    const editor = await addMember(a.org, "editor");
    await transferOwnership(a.ctx, { memberId: editor.memberId });

    const members = await membersOf(a.org.id);
    expect(members.find((m) => m.id === editor.memberId)!.role).toBe("owner");
    expect(members.find((m) => m.userId === a.user.id)!.role).toBe("admin");
    expect(await ownersOf(a.org.id)).toBe(1);
    // Not to oneself, and not twice with a context from before.
    expect((await failureOf(() => transferOwnership(a.ctx, { memberId: a.ctx.membership.id }))).kind).toBe("Forbidden");
    expect((await failureOf(() => transferOwnership(a.ctx, { memberId: editor.memberId }))).kind).toBe("Forbidden");
  });

  it("holds under concurrency: two Owners demoting each other at once leave exactly one Owner", async () => {
    for (let round = 0; round < 6; round++) {
      const a = await newTenant();
      const second = await addMember(a.org, "owner");
      const ctx2 = await contextOf(second.actor, a.org);
      const results = await Promise.allSettled([
        changeMemberRole(a.ctx, { memberId: second.memberId, role: "admin" }),
        changeMemberRole(ctx2, { memberId: a.ctx.membership.id, role: "admin" }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled"), `round ${round}`).toHaveLength(1);
      const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(["Forbidden", "Conflict"]).toContain((refused.reason as { kind?: string }).kind); // demoted first, or would be the last
      expect(await ownersOf(a.org.id), `round ${round}`).toBe(1);
    }
  });

  it("holds under concurrency: several Owners leaving at once never empty the organization", async () => {
    for (let round = 0; round < 4; round++) {
      const a = await newTenant();
      const others = await Promise.all([addMember(a.org, "owner"), addMember(a.org, "owner"), addMember(a.org, "owner")]);
      const contexts = [a.ctx, ...(await Promise.all(others.map((o) => contextOf(o.actor, a.org))))];
      const results = await Promise.allSettled(contexts.map((ctx) => leaveOrganization(ctx)));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
      expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ kind: "Conflict" });
      expect(await ownersOf(a.org.id)).toBe(1);
    }
  });
});

describe("one organization cannot reach into another (the services)", () => {
  it("B's member ids are NotFound in A's context, and B is unchanged", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const editorB = await addMember(b.org, "editor");
    const before = await membersOf(b.org.id);

    for (const memberId of [editorB.memberId, b.ctx.membership.id]) {
      expect((await failureOf(() => changeMemberRole(a.ctx, { memberId, role: "viewer" }))).kind).toBe("NotFound");
      expect((await failureOf(() => removeMember(a.ctx, { memberId }))).kind).toBe("NotFound");
      expect((await failureOf(() => transferOwnership(a.ctx, { memberId }))).kind).toBe("NotFound");
    }
    expect(await membersOf(b.org.id)).toEqual(before);
  });

  it("a user in two organizations cannot use one membership to act in the other", async () => {
    const a = await newTenant();
    const b = await newTenant();
    // A's Owner is a Viewer in B.
    const [guestRow] = await withTenant({ orgId: b.org.id }, async (tx) =>
      tx.insert(t.organizationMembers).values({ organizationId: b.org.id, userId: a.user.id, roleId: await roleId(tx, "viewer") }).returning(),
    );
    // From A's context, their own membership row in B is visible to the database (it is theirs), and still not reachable.
    expect((await failureOf(() => changeMemberRole(a.ctx, { memberId: guestRow!.id, role: "owner" }))).kind).toBe("NotFound");
    expect((await failureOf(() => removeMember(a.ctx, { memberId: guestRow!.id }))).kind).toBe("NotFound");
    // In B they are a Viewer, whatever they are in A.
    const asViewerInB = await contextOf(a.actor, b.org);
    expect(asViewerInB.membership.role).toBe("viewer");
    expect((await failureOf(() => changeMemberRole(asViewerInB, { memberId: guestRow!.id, role: "owner" }))).kind).toBe("Forbidden");
    expect((await failureOf(() => updateOrganization(asViewerInB, { name: "Mine Now" }))).kind).toBe("Forbidden");
    expect(await rolesOf(b.org.id)).toEqual(["owner", "viewer"]);
  });
});

describe("the database refuses it too (RLS, as forge_app, no service involved)", () => {
  const TENANCY_TABLES = ["organizations", "organization_members", "organization_invitations", "subscriptions", "sites", "site_settings"] as const;
  const orgColumn = (table: string) => (table === "organizations" ? "id" : "organization_id");

  async function seeded() {
    const [a, b] = [await newTenant("A"), await newTenant("B")];
    for (const tenant of [a, b]) {
      await createSite(tenant.org.id, tenant.user.id, slug("site"));
      await withTenant({ orgId: tenant.org.id }, async (tx) =>
        tx.insert(t.organizationInvitations).values({
          organizationId: tenant.org.id, email: `invitee-${unique()}@example.test`, roleId: await roleId(tx, "editor"),
          tokenHash: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + 86_400_000),
        }),
      );
    }
    return { a, b };
  }

  it("reads: A's context sees A's rows and none of B's, in every tenancy table", async () => {
    const { a, b } = await seeded();
    for (const table of TENANCY_TABLES) {
      const rows = await withTenant({ orgId: a.org.id, userId: a.user.id }, (tx) =>
        tx.execute<{ org: string }>(sql`select ${sql.identifier(orgColumn(table))} as org from ${sql.identifier(table)}`),
      );
      const seen = new Set(rows.rows.map((r) => r.org));
      expect(seen.has(a.org.id), `${table}: A's own row`).toBe(true);
      expect(seen.has(b.org.id), `${table}: B's row`).toBe(false);
    }
  });

  it("no tenant context: no rows, in every tenancy table", async () => {
    await seeded();
    for (const table of TENANCY_TABLES) {
      const rows = await withPlatform((tx) => tx.execute(sql`select 1 from ${sql.identifier(table)}`));
      expect(rows.rows, table).toEqual([]);
    }
  });

  it("no tenant context: nothing can be written either", async () => {
    const { a } = await seeded();
    const outsider = await createUser();
    expect((await dbError(withPlatform((tx) => tx.insert(t.organizations).values({ name: "Stray", slug: slug() })))).code).toBe(PG.insufficientPrivilege);
    expect(
      (await dbError(withPlatform(async (tx) => tx.insert(t.organizationMembers).values({ organizationId: a.org.id, userId: outsider.id, roleId: await roleIdOf("owner") })))).code,
    ).toBe(PG.insufficientPrivilege);
    expect((await dbError(withPlatform((tx) => tx.insert(t.sites).values({ organizationId: a.org.id, name: "x", slug: slug("s") })))).code).toBe(PG.insufficientPrivilege);
    expect(await withPlatform((tx) => tx.update(t.organizations).set({ name: "Renamed" }).returning())).toEqual([]);
    expect(await withPlatform((tx) => tx.delete(t.organizationMembers).returning())).toEqual([]);
    expect(await rolesOf(a.org.id)).toEqual(["owner"]);
  });

  it("writes: A's context cannot insert into, move rows to, update or delete in B", async () => {
    const { a, b } = await seeded();
    const stranger = await createUser();
    const asA = <T>(work: Parameters<typeof withTenant<T>>[1]) => withTenant({ orgId: a.org.id, userId: a.user.id }, work);

    // INSERT stamped with B.
    expect((await dbError(asA(async (tx) => tx.insert(t.organizationMembers).values({ organizationId: b.org.id, userId: stranger.id, roleId: await roleIdOf("owner") })))).code).toBe(PG.insufficientPrivilege);
    expect((await dbError(asA(async (tx) => tx.insert(t.organizationMembers).values({ organizationId: b.org.id, userId: a.user.id, roleId: await roleIdOf("owner") })))).code).toBe(PG.insufficientPrivilege);
    expect((await dbError(asA((tx) => tx.insert(t.sites).values({ organizationId: b.org.id, name: "x", slug: slug("s") })))).code).toBe(PG.insufficientPrivilege);
    expect((await dbError(asA((tx) => tx.insert(t.subscriptions).values({ organizationId: b.org.id })))).code).toBe(PG.insufficientPrivilege);
    expect((await dbError(asA((tx) => tx.insert(t.organizations).values({ name: "Second", slug: slug() })))).code).toBe(PG.insufficientPrivilege); // not the context's id

    // UPDATE own row into B.
    expect((await dbError(asA((tx) => tx.update(t.sites).set({ organizationId: b.org.id })))).code).toBe(PG.insufficientPrivilege);
    expect((await dbError(asA((tx) => tx.update(t.organizationMembers).set({ organizationId: b.org.id })))).code).toBeDefined();

    // UPDATE / DELETE aimed at B's rows touch nothing.
    for (const table of TENANCY_TABLES) {
      const column = sql.identifier(orgColumn(table));
      const updated = await asA((tx) => tx.execute(sql`update ${sql.identifier(table)} set ${column} = ${column} where ${column} = ${b.org.id} returning 1`));
      const deleted = await asA((tx) => tx.execute(sql`delete from ${sql.identifier(table)} where ${column} = ${b.org.id} returning 1`));
      expect([updated.rows.length, deleted.rows.length], table).toEqual([0, 0]);
    }
    expect(await rolesOf(b.org.id)).toEqual(["owner"]);
    expect((await orgRow(b.org.id))!.name).toBe(b.org.name);
  });

  it("membership rows are readable by their user anywhere, and writable only inside their organization (migration 0004)", async () => {
    const { a, b } = await seeded();
    // A's Owner is also a Viewer in B.
    await withTenant({ orgId: b.org.id }, async (tx) => tx.insert(t.organizationMembers).values({ organizationId: b.org.id, userId: a.user.id, roleId: await roleIdOf("viewer") }));
    const mine = and(eq(t.organizationMembers.userId, a.user.id), eq(t.organizationMembers.organizationId, b.org.id));

    // Readable: with only a user context, and from inside A.
    expect(await withUser(a.user.id, (tx) => tx.select().from(t.organizationMembers).where(mine))).toHaveLength(1);
    expect(await withTenant({ orgId: a.org.id, userId: a.user.id }, (tx) => tx.select().from(t.organizationMembers).where(mine))).toHaveLength(1);

    // Not writable from either place: not promoted, not deleted (which would walk around B's rules).
    const ownerRole = await roleIdOf("owner");
    for (const run of [
      <T>(work: Parameters<typeof withUser<T>>[1]) => withUser(a.user.id, work),
      <T>(work: Parameters<typeof withTenant<T>>[1]) => withTenant({ orgId: a.org.id, userId: a.user.id }, work as never),
    ]) {
      expect(await run((tx) => tx.update(t.organizationMembers).set({ roleId: ownerRole }).where(mine).returning())).toEqual([]);
      expect(await run((tx) => tx.delete(t.organizationMembers).where(mine).returning())).toEqual([]);
    }
    expect(await rolesOf(b.org.id)).toEqual(["owner", "viewer"]);
  });

  it("a user-only context can read the user's organizations and change nothing: not rename, not delete, not leave", async () => {
    const { a } = await seeded();
    const viewer = await addMember(a.org, "viewer");
    for (const userId of [a.user.id, viewer.user.id]) {
      expect((await withUser(userId, (tx) => tx.select({ id: t.organizations.id }).from(t.organizations))).map((o) => o.id)).toEqual([a.org.id]);
      expect(await withUser(userId, (tx) => tx.update(t.organizations).set({ name: "Renamed" }).returning())).toEqual([]);
      expect(await withUser(userId, (tx) => tx.delete(t.organizations).returning())).toEqual([]);
      expect(await withUser(userId, (tx) => tx.delete(t.organizationMembers).returning())).toEqual([]);
      expect((await dbError(withUser(userId, (tx) => tx.insert(t.organizations).values({ name: "New", slug: slug() })))).code).toBe(PG.insufficientPrivilege);
    }
    expect((await orgRow(a.org.id))!.name).toBe(a.org.name);
    expect(await rolesOf(a.org.id)).toEqual(["owner", "viewer"]);
  });

  it("cross-tenant references cannot be stored: the composite keys refuse a site of another organization", async () => {
    const { a, b } = await seeded();
    const [siteB] = await withTenant({ orgId: b.org.id }, (tx) => tx.select().from(t.sites));
    const asA = <T>(work: Parameters<typeof withTenant<T>>[1]) => withTenant({ orgId: a.org.id, userId: a.user.id }, work);

    // A site of B's with no settings row yet, so the primary key is not what answers.
    const [bareB] = await withTenant({ orgId: b.org.id }, (tx) => tx.insert(t.sites).values({ organizationId: b.org.id, name: "bare", slug: slug("bare") }).returning());

    // Tenant tables: RLS passes (the row is stamped with A), the foreign key does not (the site is B's).
    expect(await dbError(asA((tx) => tx.insert(t.siteSettings).values({ siteId: bareB!.id, organizationId: a.org.id })))).toMatchObject({
      code: PG.foreignKeyViolation, constraint: "site_settings_site_fk",
    });
    // Where B already has the row, A's attempt is refused as well (by the primary key, before the foreign key is even looked at).
    expect((await dbError(asA((tx) => tx.insert(t.siteSettings).values({ siteId: siteB!.id, organizationId: a.org.id })))).code).toBe(PG.uniqueViolation);
    expect((await dbError(asA((tx) => tx.insert(t.menus).values({ organizationId: a.org.id, siteId: siteB!.id, location: "header" })))).code).toBe(PG.foreignKeyViolation);
    // `domains` has no RLS (it is read before the tenant is known): the composite key is the whole defence there.
    for (const run of [asA, withPlatform]) {
      const error = await dbError((run as typeof withPlatform)((tx) =>
        tx.insert(t.domains).values({ organizationId: a.org.id, siteId: siteB!.id, hostname: slug("stolen"), kind: "subdomain", status: "active" }),
      ));
      expect(error).toMatchObject({ code: PG.foreignKeyViolation, constraint: "domains_site_fk" });
    }
    // And a membership cannot point at an organization that does not exist.
    const ghost = uuidv7();
    expect((await dbError(withTenant({ orgId: ghost }, async (tx) => tx.insert(t.organizationMembers).values({ organizationId: ghost, userId: a.user.id, roleId: await roleIdOf("owner") })))).code).toBe(PG.foreignKeyViolation);
  });

  it("the runtime role cannot switch RLS off or change its own policies", async () => {
    for (const statement of [
      "alter table organizations disable row level security",
      "alter table organization_members no force row level security",
      "drop policy organizations_delete on organizations",
      "create policy open_all on organizations for all using (true)",
      "set role forge_owner",
    ]) {
      expect((await dbError(withPlatform((tx) => tx.execute(sql.raw(statement))))).code, statement).toMatch(/^42/);
    }
    const [row] = (await withPlatform((tx) => tx.execute<{ bypass: boolean; superuser: boolean; current: string }>(
      sql`select rolbypassrls as bypass, rolsuper as superuser, current_user::text as current from pg_roles where rolname = current_user`,
    ))).rows;
    expect(row).toEqual({ bypass: false, superuser: false, current: "forge_app" });
  });
});

const roleIds = new Map<RoleKey, string>();
async function roleIdOf(key: RoleKey): Promise<string> {
  if (!roleIds.has(key)) roleIds.set(key, await withPlatform((tx) => roleId(tx as never, key)));
  return roleIds.get(key)!;
}

describe("slugs and addresses are unique where the plan says so", () => {
  it("organization slugs: unique across the platform, lowercase by constraint", async () => {
    const a = await newTenant();
    const id = uuidv7();
    expect(await dbError(withTenant({ orgId: id }, (tx) => tx.insert(t.organizations).values({ id, name: "Twin", slug: a.org.slug })))).toMatchObject({
      code: PG.uniqueViolation, constraint: "organizations_slug_unique",
    });
    for (const bad of ["Upper-Case", "with space", "trailing-", "double--hyphen", ""]) {
      const badId = uuidv7();
      expect((await dbError(withTenant({ orgId: badId }, (tx) => tx.insert(t.organizations).values({ id: badId, name: "Bad", slug: bad })))).code, bad).toBe(PG.checkViolation);
    }
  });

  it("site slugs: unique inside an organization, free for the next one", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const shared = slug("docs");
    await insertSiteWithAddress(a, shared, slug("addr"));
    expect((await dbError(insertSiteWithAddress(a, shared, slug("addr")))).code).toBe(PG.uniqueViolation);
    await expect(insertSiteWithAddress(b, shared, slug("addr"))).resolves.toBeDefined();
  });

  it("site addresses: one per platform, whoever asks, and lowercase", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const address = slug("taken");
    await insertSiteWithAddress(a, slug("one"), address);
    expect(await dbError(insertSiteWithAddress(b, slug("two"), address))).toMatchObject({ code: PG.uniqueViolation, constraint: "domains_hostname_unique" });
    expect((await dbError(insertSiteWithAddress(b, slug("three"), address.toUpperCase()))).code).toBe(PG.checkViolation);
  });
});

describe("public site resolution stays anonymous and separate from membership", () => {
  /** What the renderer does for `/s/{address}`: the address, and nothing about who is asking. */
  const resolveAddress = (address: string) =>
    withPlatform(async (tx) => {
      const [row] = await tx
        .select({ siteId: t.domains.siteId, orgId: t.domains.organizationId })
        .from(t.domains)
        .where(and(eq(t.domains.hostname, address), eq(t.domains.kind, "subdomain"), eq(t.domains.status, "active")));
      return row ?? null;
    });
  const taglineOf = (resolved: { orgId: string; siteId: string }) =>
    withTenant({ orgId: resolved.orgId }, async (tx) => {
      const [row] = await tx.select({ general: t.siteSettings.general }).from(t.siteSettings).where(eq(t.siteSettings.siteId, resolved.siteId));
      return row?.general.tagline;
    });

  it("an address resolves to its own site and organization with no session and no tenant context", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const [addressA, addressB] = [slug("alpha"), slug("beta")];
    const siteA = await insertSiteWithAddress(a, slug("site"), addressA);
    const siteB = await insertSiteWithAddress(b, slug("site"), addressB);

    expect(await resolveAddress(addressA)).toEqual({ siteId: siteA.id, orgId: a.org.id });
    expect(await resolveAddress(addressB)).toEqual({ siteId: siteB.id, orgId: b.org.id });
    expect(await taglineOf((await resolveAddress(addressA))!)).toBe(`tagline of ${addressA}`);
    expect(await taglineOf((await resolveAddress(addressB))!)).toBe(`tagline of ${addressB}`);
  });

  it("an unknown address, an admin slug, and an inactive address resolve to nothing", async () => {
    const a = await newTenant();
    const address = slug("pending");
    const site = await insertSiteWithAddress(a, slug("admin-slug"), address);
    expect(await resolveAddress(slug("nobody"))).toBeNull();
    expect(await resolveAddress(site.slug)).toBeNull(); // the admin slug is not a public address
    expect(await resolveAddress(a.org.slug)).toBeNull(); // nor is the organization's slug
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.domains).set({ status: "failed" }).where(eq(t.domains.hostname, address)));
    expect(await resolveAddress(address)).toBeNull();
  });

  it("who is signed in changes nothing: B's Owner asking for A's address gets A's site, and only through the address", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const address = slug("alpha");
    const siteA = await insertSiteWithAddress(a, slug("site"), address);

    // The lookup has no user in it. With B's user in the context, the answer is the same row…
    const asB = await withUser(b.user.id, async (tx) => {
      const [row] = await tx.select({ siteId: t.domains.siteId, orgId: t.domains.organizationId }).from(t.domains).where(eq(t.domains.hostname, address));
      return row;
    });
    expect(asB).toEqual({ siteId: siteA.id, orgId: a.org.id });
    // …and B's membership opens nothing of A's: B's own context shows none of A's site data,
    expect(await withTenant({ orgId: b.org.id, userId: b.user.id }, (tx) => tx.select().from(t.siteSettings).where(eq(t.siteSettings.siteId, siteA.id)))).toEqual([]);
    // and the admin resolver, given the public address, finds nothing.
    expect((await failureOf(() => resolveSiteContext(b.actor, b.org.slug, address))).kind).toBe("NotFound");
    expect((await failureOf(() => resolveSiteContext(b.actor, a.org.slug, siteA.slug))).kind).toBe("NotFound");
    expect(await inTenant(b.ctx, (tx) => findSiteBySlug(tx, a.org.id, siteA.slug))).toBeNull();
  });
});
