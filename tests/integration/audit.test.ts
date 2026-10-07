import { and, eq, sql } from "drizzle-orm";
import pg from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, AuditEventError, describeEvent, parseActivityQuery, queryActivity, record, recordPlatformEvent, type AuditEntry } from "@/modules/audit";
import type { Actor } from "@/modules/auth/shared";
import {
  acceptInvitation, changeMemberRole, createOrganization, inTenant, inviteMember, leaveOrganization, listActivity, removeMember, resendInvitation,
  resolveOrgContext, revokeInvitation, submitAcceptInvitation, submitChangeMemberRole, submitCreateOrganization, submitInviteMember,
  submitRenameOrganization, transferOwnership, updateOrganization, type OrgContext,
} from "@/modules/tenancy";
import * as t from "@/platform/db/schema";
import { withPlatform, withTenant, withUser, type TenantTx } from "@/platform/db/tenant";
import { jobs } from "@/platform/jobs/schema";
import { dbError, PG } from "../fixtures/db-error";
import { createSite, createUser } from "../fixtures/factories";
import { actorOf, addMember, addUser, newSlug, newTenant, refusalOf } from "../fixtures/tenants";

/**
 * M3-5 against real Postgres (as forge_app through PgBouncer): the audit
 * writer inside the tenancy services' own transactions, and the activity query
 * behind `/{org}/activity`.
 *
 * The claim under test is D-30's: a change and its record commit together or
 * not at all, the record says who did it and where from the transaction's own
 * context, and nobody can change it afterwards or read another organization's.
 */

afterAll(async () => {
  // Invitations queue emails. Leave the worker's queue as we found it: other suites count the jobs they run.
  await withPlatform((tx) => tx.delete(jobs).where(eq(jobs.type, "email.send")));
});

const DAY = 24 * 3600 * 1000;
const unique = () => uuidv7().slice(-12);
const address = (label = "invitee") => `${label}-${unique()}@example.test`;
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

type AuditRow = typeof t.auditLogs.$inferSelect;
/** Everything recorded for an organization, oldest first. */
const auditOf = (orgId: string): Promise<AuditRow[]> =>
  withTenant({ orgId }, (tx) => tx.select().from(t.auditLogs).where(eq(t.auditLogs.organizationId, orgId)).orderBy(t.auditLogs.createdAt, t.auditLogs.id));
const actionsOf = async (orgId: string) => (await auditOf(orgId)).map((row) => row.action);
const lastOf = async (orgId: string) => (await auditOf(orgId)).at(-1)!;

const rolesOf = async (orgId: string) => {
  const rows = await withTenant({ orgId }, (tx) =>
    tx
      .select({ userId: t.organizationMembers.userId, role: t.roles.key })
      .from(t.organizationMembers)
      .innerJoin(t.roles, eq(t.roles.id, t.organizationMembers.roleId))
      .where(eq(t.organizationMembers.organizationId, orgId)),
  );
  return Object.fromEntries(rows.map((row) => [row.userId, row.role]));
};
const orgRow = async (orgId: string) => (await withTenant({ orgId }, (tx) => tx.select().from(t.organizations).where(eq(t.organizations.id, orgId))))[0];
const invitationRows = (orgId: string) => withTenant({ orgId }, (tx) => tx.select().from(t.organizationInvitations).where(eq(t.organizationInvitations.organizationId, orgId)));

/** The token in the link of the newest email queued for an invitation. */
async function tokenOf(invitationId: string): Promise<string> {
  const queued = await withPlatform((tx) =>
    tx.select().from(jobs).where(and(eq(jobs.type, "email.send"), sql`${jobs.payload}->>'invitationId' = ${invitationId}`)).orderBy(jobs.createdAt, jobs.id),
  );
  return String(queued.at(-1)!.payload.url).split("/invite/")[1]!;
}

/** As the schema owner, on a direct connection: to make the database fail on cue. */
async function asOwner<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: process.env.TEST_WORKER_OWNER_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** While `work` runs, a trigger makes the database refuse `event` on `table`: at once, or (deferred) when the transaction tries to commit. */
async function whileFailing<T>(table: string, event: "insert" | "delete" | "update", work: () => Promise<T>, options: { atCommit?: boolean } = {}): Promise<T> {
  const name = `audit_test_fail_${unique()}`;
  await asOwner(async (owner) => {
    await owner.query(`create function ${name}() returns trigger language plpgsql as $$ begin raise exception 'forced failure on ${table}'; end $$`);
    await owner.query(
      options.atCommit
        ? `create constraint trigger ${name} after ${event} on ${table} deferrable initially deferred for each row execute function ${name}()`
        : `create trigger ${name} before ${event} on ${table} for each row execute function ${name}()`,
    );
  });
  try {
    return await work();
  } finally {
    await asOwner(async (owner) => {
      await owner.query(`drop trigger ${name} on ${table}`);
      await owner.query(`drop function ${name}()`);
    });
  }
}

const REQUEST = { requestId: "req-audit-1", ip: "203.0.113.9" };
/** A member's context as a request with an id and a client address would resolve it. */
const withRequest = (actor: Actor, org: { slug: string }) => resolveOrgContext(actor, org.slug, REQUEST);

describe("every change writes its line, in the same transaction", () => {
  it("creating an organization: the first line of its log, by its creator", async () => {
    const user = await createUser({ name: "Olive Owner" });
    const slug = newSlug("audited");
    const organization = await createOrganization(actorOf(user), { name: "  Audited Org ", slug }, REQUEST);

    expect(await auditOf(organization.id)).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        organizationId: organization.id,
        siteId: null,
        actorType: "user",
        actorId: user.id,
        actorLabel: user.email,
        action: "organization.created",
        resourceType: "organization",
        resourceId: organization.id,
        requestId: "req-audit-1",
        ip: "203.0.113.9",
        metadata: { name: "Audited Org", slug },
        createdAt: expect.any(Date),
      },
    ]);
  });

  it("renaming and changing the URL: what it was and what it is now, and only for what changed", async () => {
    const a = await newTenant();
    const ctx = await withRequest(a.actor, a.org);
    await updateOrganization(ctx, { name: "Renamed" });
    expect(await lastOf(a.org.id)).toMatchObject({
      action: "organization.updated", resourceType: "organization", resourceId: a.org.id, actorId: a.user.id, requestId: "req-audit-1", ip: "203.0.113.9",
      metadata: { previousName: a.org.name, newName: "Renamed" },
    });

    const next = newSlug("moved");
    await updateOrganization(ctx, { slug: next });
    expect((await lastOf(a.org.id)).metadata).toEqual({ previousSlug: a.org.slug, newSlug: next });

    // Both at once: one event with both changes.
    const moved = await resolveOrgContext(a.actor, next);
    const again = newSlug("again");
    await updateOrganization(moved, { name: "Both", slug: again });
    expect((await lastOf(a.org.id)).metadata).toEqual({ previousName: "Renamed", newName: "Both", previousSlug: next, newSlug: again });

    // Saving what is already there is not an event.
    const before = (await auditOf(a.org.id)).length;
    await updateOrganization(await resolveOrgContext(a.actor, again), { name: "Both", slug: again });
    expect(await auditOf(a.org.id)).toHaveLength(before);
    expect(await actionsOf(a.org.id)).toEqual(["organization.created", "organization.updated", "organization.updated", "organization.updated"]);
  });

  it("members: a role change, a removal, leaving, and the transfer of ownership", async () => {
    const a = await newTenant();
    const ctx = await withRequest(a.actor, a.org);
    const edith = await addUser(a.org, await createUser({ name: "Edith Editor" }), "editor");
    const vic = await addUser(a.org, await createUser({ name: "Vic Viewer" }), "viewer");
    const lee = await addUser(a.org, await createUser({ name: "Lee Leaver" }), "author");

    await changeMemberRole(ctx, { memberId: edith.memberId, role: "author" });
    expect(await lastOf(a.org.id)).toMatchObject({
      action: "member.role_changed", resourceType: "membership", resourceId: edith.memberId, actorId: a.user.id, actorLabel: a.user.email,
      metadata: { memberName: "Edith Editor", previousRole: "editor", newRole: "author" }, requestId: "req-audit-1",
    });
    // The same role again changes nothing and records nothing.
    const count = (await auditOf(a.org.id)).length;
    await changeMemberRole(ctx, { memberId: edith.memberId, role: "author" });
    expect(await auditOf(a.org.id)).toHaveLength(count);

    await removeMember(ctx, { memberId: vic.memberId });
    expect(await lastOf(a.org.id)).toMatchObject({ action: "member.removed", resourceType: "membership", resourceId: vic.memberId, metadata: { memberName: "Vic Viewer", role: "viewer" } });

    // Leaving: the actor is the one who left, and the record stays in the organization they left.
    await leaveOrganization(await withRequest(lee.actor, a.org));
    expect(await lastOf(a.org.id)).toMatchObject({ action: "member.left", resourceType: "membership", resourceId: lee.memberId, actorId: lee.user.id, metadata: { role: "author" } });

    await transferOwnership(ctx, { memberId: edith.memberId });
    expect(await lastOf(a.org.id)).toMatchObject({
      action: "organization.ownership_transferred", resourceType: "organization", resourceId: a.org.id, actorId: a.user.id, metadata: { newOwnerName: "Edith Editor" },
    });
    // One event for the transfer, not one per role that moved.
    expect(await actionsOf(a.org.id)).toEqual(["organization.created", "member.role_changed", "member.removed", "member.left", "organization.ownership_transferred"]);

    // Naming oneself in a removal is leaving, and is recorded as that.
    const former = await resolveOrgContext(a.actor, a.org.slug);
    await removeMember(former, { memberId: former.membership.id });
    expect(await lastOf(a.org.id)).toMatchObject({ action: "member.left", actorId: a.user.id, metadata: { role: "admin" } });
  });

  it("invitations: sent, sent again, revoked, and accepted by the person who joins", async () => {
    const a = await newTenant();
    const ctx = await withRequest(a.actor, a.org);
    const ivy = await createUser({ name: "Ivy Invitee", email: address() });

    const invitation = await inviteMember(ctx, { email: ivy.email, role: "editor" });
    expect(await lastOf(a.org.id)).toMatchObject({
      action: "member.invited", resourceType: "invitation", resourceId: invitation.id, actorId: a.user.id, metadata: { email: ivy.email, role: "editor" }, ip: "203.0.113.9",
    });

    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.organizationInvitations).set({ expiresAt: new Date(Date.now() + 7 * DAY - 5 * 60_000) }).where(eq(t.organizationInvitations.id, invitation.id)));
    await resendInvitation(ctx, { invitationId: invitation.id });
    expect(await lastOf(a.org.id)).toMatchObject({ action: "invitation.resent", resourceType: "invitation", resourceId: invitation.id, metadata: { email: ivy.email } });

    // Accepted: the actor is the newcomer, who had no context; the organization is the one joined.
    const token = await tokenOf(invitation.id);
    await acceptInvitation(actorOf(ivy), token, { requestId: "req-accept", ip: "198.51.100.7" });
    expect(await lastOf(a.org.id)).toMatchObject({
      organizationId: a.org.id, action: "invitation.accepted", resourceType: "invitation", resourceId: invitation.id,
      actorType: "user", actorId: ivy.id, actorLabel: ivy.email, metadata: { role: "editor" }, requestId: "req-accept", ip: "198.51.100.7",
    });
    // Opening the used link again is not an event.
    const count = (await auditOf(a.org.id)).length;
    await acceptInvitation(actorOf(ivy), token);
    expect(await auditOf(a.org.id)).toHaveLength(count);

    const other = await inviteMember(ctx, { email: address(), role: "viewer" });
    await revokeInvitation(ctx, { invitationId: other.id });
    expect(await lastOf(a.org.id)).toMatchObject({ action: "invitation.revoked", resourceType: "invitation", resourceId: other.id, metadata: { email: other.email } });

    // Someone who joined another way and then uses their link: recorded as such, with no role claimed.
    const already = await createUser({ email: address() });
    const third = await inviteMember(ctx, { email: already.email, role: "viewer" });
    await addUser(a.org, already, "admin");
    await acceptInvitation(actorOf(already), await tokenOf(third.id));
    expect((await lastOf(a.org.id)).metadata).toEqual({ role: "viewer", alreadyMember: true });

    expect(await actionsOf(a.org.id)).toEqual([
      "organization.created", "member.invited", "invitation.resent", "invitation.accepted", "member.invited", "invitation.revoked", "member.invited", "invitation.accepted",
    ]);
  });

  it("the forms carry the request's id and address into the record", async () => {
    const user = await createUser();
    const slug = newSlug("forms");
    const meta = { requestId: "req-form-7", ip: "192.0.2.44" };
    await submitCreateOrganization(actorOf(user), form({ name: "Forms", slug }), meta);
    const organization = (await resolveOrgContext(actorOf(user), slug)).org;
    await submitRenameOrganization(actorOf(user), slug, form({ name: "Forms Renamed" }), meta);
    const invitee = await createUser({ email: address() });
    await submitInviteMember(actorOf(user), slug, form({ email: invitee.email, role: "viewer" }), meta);
    const [invitation] = await invitationRows(organization.id);
    await submitAcceptInvitation(actorOf(invitee), await tokenOf(invitation!.id), meta);

    const rows = await auditOf(organization.id);
    expect(rows.map((row) => row.action)).toEqual(["organization.created", "organization.updated", "member.invited", "invitation.accepted"]);
    for (const row of rows) expect({ requestId: row.requestId, ip: row.ip }, row.action).toEqual(meta);
    expect(rows.map((row) => row.actorId)).toEqual([user.id, user.id, user.id, invitee.id]);
  });

  it("every event of M3 is covered by a mutation above: the catalog has no event nothing writes", async () => {
    const a = await newTenant();
    const ctx = a.ctx;
    const one = await addUser(a.org, await createUser(), "editor");
    const two = await addUser(a.org, await createUser(), "viewer");
    const three = await addUser(a.org, await createUser(), "viewer");
    const invitee = await createUser({ email: address() });
    await updateOrganization(ctx, { name: "Covered" });
    await changeMemberRole(ctx, { memberId: one.memberId, role: "author" });
    await removeMember(ctx, { memberId: two.memberId });
    await leaveOrganization(await resolveOrgContext(three.actor, a.org.slug));
    const sent = await inviteMember(ctx, { email: invitee.email, role: "viewer" });
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.organizationInvitations).set({ expiresAt: new Date(Date.now() + 6 * DAY) }).where(eq(t.organizationInvitations.id, sent.id)));
    await resendInvitation(ctx, { invitationId: sent.id });
    await acceptInvitation(actorOf(invitee), await tokenOf(sent.id));
    const revoked = await inviteMember(ctx, { email: address(), role: "viewer" });
    await revokeInvitation(ctx, { invitationId: revoked.id });
    await transferOwnership(ctx, { memberId: one.memberId });
    expect(new Set(await actionsOf(a.org.id))).toEqual(new Set(AUDIT_ACTIONS));
  });
});

describe("a refused change leaves no line", () => {
  it("not allowed, not found, not valid, or against a rule: the log is as it was", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const viewer = await addMember(a.org, "viewer");
    const admin = await addMember(a.org, "admin");
    const before = await auditOf(a.org.id);
    const beforeB = await auditOf(b.org.id);

    const refused: (() => Promise<unknown>)[] = [
      // Forbidden
      () => updateOrganization(viewer.ctx, { name: "No" }),
      () => changeMemberRole(viewer.ctx, { memberId: admin.memberId, role: "viewer" }),
      () => inviteMember(viewer.ctx, { email: address(), role: "viewer" }),
      () => transferOwnership(admin.ctx, { memberId: viewer.memberId }),
      () => changeMemberRole(admin.ctx, { memberId: a.ctx.membership.id, role: "viewer" }),
      // NotFound
      () => changeMemberRole(a.ctx, { memberId: b.ctx.membership.id, role: "viewer" }),
      () => removeMember(a.ctx, { memberId: uuidv7() }),
      () => revokeInvitation(a.ctx, { invitationId: uuidv7() }),
      () => acceptInvitation(a.actor, "a".repeat(43)),
      // Validation
      () => updateOrganization(a.ctx, { slug: "login" }),
      () => inviteMember(a.ctx, { email: "nonsense", role: "viewer" }),
      () => inviteMember(a.ctx, { email: address(), role: "owner" }),
      () => createOrganization(a.actor, { name: "Taken", slug: b.org.slug }),
      // Conflict: the only Owner
      () => leaveOrganization(a.ctx),
      () => changeMemberRole(a.ctx, { memberId: a.ctx.membership.id, role: "admin" }),
    ];
    for (const attempt of refused) await refusalOf(attempt);

    expect(await auditOf(a.org.id)).toEqual(before);
    expect(await auditOf(b.org.id)).toEqual(beforeB);
  });

  it("an invitation refused to the wrong account is not recorded as accepted, or at all", async () => {
    const a = await newTenant();
    const invitee = await createUser({ email: address() });
    const invitation = await inviteMember(a.ctx, { email: invitee.email, role: "viewer" });
    const before = (await auditOf(a.org.id)).length;
    const stranger = actorOf(await createUser({ email: address("stranger") }));
    const token = await tokenOf(invitation.id);
    expect((await refusalOf(() => acceptInvitation(stranger, token))).kind).toBe("Forbidden");
    expect(await auditOf(a.org.id)).toHaveLength(before);
  });
});

describe("the change and its record commit together, or not at all", () => {
  it("a transaction that fails after the record was written leaves neither the change nor the record", async () => {
    const a = await newTenant();
    const member = await addMember(a.org, "viewer");
    const before = await auditOf(a.org.id);

    // The delete and the audit row are both written; then the commit itself is refused.
    expect((await dbError(whileFailing("organization_members", "delete", () => removeMember(a.ctx, { memberId: member.memberId }), { atCommit: true }))).message).toMatch(/forced failure/);
    expect(await rolesOf(a.org.id)).toEqual({ [a.user.id]: "owner", [member.user.id]: "viewer" });
    expect(await auditOf(a.org.id)).toEqual(before);

    // The same for a role change and for a transfer (two role updates and one record).
    expect((await dbError(whileFailing("organization_members", "update", () => changeMemberRole(a.ctx, { memberId: member.memberId, role: "editor" }), { atCommit: true }))).message).toMatch(/forced failure/);
    expect((await dbError(whileFailing("organization_members", "update", () => transferOwnership(a.ctx, { memberId: member.memberId }), { atCommit: true }))).message).toMatch(/forced failure/);
    expect(await rolesOf(a.org.id)).toEqual({ [a.user.id]: "owner", [member.user.id]: "viewer" });
    expect(await auditOf(a.org.id)).toEqual(before);

    // With nothing in the way, the same call commits both.
    await removeMember(a.ctx, { memberId: member.memberId });
    expect(await rolesOf(a.org.id)).toEqual({ [a.user.id]: "owner" });
    expect(await actionsOf(a.org.id)).toEqual([...before.map((row) => row.action), "member.removed"]);
  });

  it("if the record cannot be written, the change is not made: every M3 mutation, one by one", async () => {
    const a = await newTenant();
    const editor = await addUser(a.org, await createUser({ name: "Edith Editor" }), "editor");
    const leaver = await addMember(a.org, "author");
    const invitee = await createUser({ email: address() });
    const pending = await inviteMember(a.ctx, { email: invitee.email, role: "viewer" });
    const toRevoke = await inviteMember(a.ctx, { email: address(), role: "viewer" });
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.organizationInvitations).set({ expiresAt: new Date(Date.now() + 6 * DAY) }).where(eq(t.organizationInvitations.organizationId, a.org.id)));
    const token = await tokenOf(pending.id);
    const newcomer = await createUser();
    const freeSlug = newSlug("unaudited");
    const newEmail = address("never-invited");

    const snapshot = async () => ({
      organization: await orgRow(a.org.id),
      roles: await rolesOf(a.org.id),
      invitations: (await invitationRows(a.org.id)).map(({ id, tokenHash, expiresAt, acceptedAt, revokedAt }) => ({ id, tokenHash, at: expiresAt.getTime(), acceptedAt, revokedAt })).sort((x, y) => x.id.localeCompare(y.id)),
      audit: await auditOf(a.org.id),
      emailJobs: (await withPlatform((tx) => tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.type, "email.send"), eq(jobs.organizationId, a.org.id))))).length,
    });
    const before = await snapshot();

    const mutations: [string, () => Promise<unknown>][] = [
      ["organization.created", () => createOrganization(actorOf(newcomer), { name: "Unaudited", slug: freeSlug })],
      ["organization.updated (name)", () => updateOrganization(a.ctx, { name: "Unaudited Rename" })],
      ["organization.updated (URL)", () => updateOrganization(a.ctx, { slug: newSlug("unaudited-url") })],
      ["organization.ownership_transferred", () => transferOwnership(a.ctx, { memberId: editor.memberId })],
      ["member.invited", () => inviteMember(a.ctx, { email: newEmail, role: "viewer" })],
      ["invitation.resent", () => resendInvitation(a.ctx, { invitationId: pending.id })],
      ["invitation.revoked", () => revokeInvitation(a.ctx, { invitationId: toRevoke.id })],
      ["invitation.accepted", () => acceptInvitation(actorOf(invitee), token)],
      ["member.role_changed", () => changeMemberRole(a.ctx, { memberId: editor.memberId, role: "viewer" })],
      ["member.removed", () => removeMember(a.ctx, { memberId: editor.memberId })],
      ["member.left", () => leaveOrganization(leaver.ctx)],
    ];
    await whileFailing("audit_logs", "insert", async () => {
      for (const [name, mutate] of mutations) {
        // Not an AppError: nothing the user did. It surfaces as a failure, and nothing was committed.
        expect((await dbError(mutate())).message, name).toMatch(/forced failure on audit_logs/);
      }
    });

    expect(await snapshot()).toEqual(before);
    // The organization that could not be recorded does not exist, and its URL is still free.
    expect(await homeless(newcomer)).toBe(true);
    // Through the form, the user is told something went wrong, and is not told it worked.
    const viaForm = await whileFailing("audit_logs", "insert", () => submitChangeMemberRole(a.actor, a.org.slug, form({ memberId: editor.memberId, role: "viewer" }), { requestId: "req-x" }));
    expect(viaForm).toMatchObject({ refused: "Internal", state: { status: "error", message: "Something went wrong. Please try again. Reference: req-x" } });
    expect(viaForm.revalidate).toBeUndefined();

    // With the log writable again, each of them goes through, and is recorded.
    await updateOrganization(a.ctx, { name: "Audited Rename" });
    await acceptInvitation(actorOf(invitee), token);
    expect((await auditOf(a.org.id)).slice(before.audit.length).map((row) => row.action)).toEqual(["organization.updated", "invitation.accepted"]);
  });

  it("a record that is not valid stops the transaction it is in", async () => {
    const a = await newTenant();
    const before = await auditOf(a.org.id);
    const bad: unknown[] = [
      { action: "member.promoted_to_god", resourceType: "membership", resourceId: uuidv7(), metadata: {} },
      { action: "member.role_changed", resourceType: "organization", resourceId: uuidv7(), metadata: { memberName: "X", previousRole: "editor", newRole: "author" } },
      { action: "member.role_changed", resourceType: "membership", resourceId: "not-an-id", metadata: { memberName: "X", previousRole: "editor", newRole: "author" } },
      { action: "member.role_changed", resourceType: "membership", resourceId: uuidv7(), metadata: { memberName: "X" } },
      { action: "organization.updated", resourceType: "organization", resourceId: a.org.id, metadata: {} },
      { action: "toString", resourceType: "organization", resourceId: a.org.id, metadata: {} },
    ];
    for (const entry of bad) {
      const attempt = inTenant(a.ctx, async (tx) => {
        await tx.update(t.organizations).set({ name: "Changed Without A Record" }).where(eq(t.organizations.id, a.org.id));
        await record(tx, entry as AuditEntry, a.ctx);
      });
      await expect(attempt, JSON.stringify(entry)).rejects.toBeInstanceOf(AuditEventError);
    }
    expect((await orgRow(a.org.id))!.name).toBe(a.org.name);
    expect(await auditOf(a.org.id)).toEqual(before);
  });
});

/** True when the user belongs to no organization. */
async function homeless(user: { id: string }): Promise<boolean> {
  const rows = await withUser(user.id, (tx) => tx.select({ id: t.organizationMembers.id }).from(t.organizationMembers).where(eq(t.organizationMembers.userId, user.id)));
  return rows.length === 0;
}

describe("who did it, and where, come from the transaction and from nowhere else", () => {
  const entry = (resourceId: string): AuditEntry => ({ action: "member.left", resourceType: "membership", resourceId, metadata: { role: "viewer" } });

  it("an entry cannot name an organization or an actor: whatever is passed along, the row is the transaction's own", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const claiming = {
      ...entry(a.ctx.membership.id),
      organizationId: b.org.id, actorId: b.user.id, actorLabel: "someone-else@example.test", actorType: "system", siteId: uuidv7(), createdAt: new Date(0), id: uuidv7(),
    } as unknown as AuditEntry;
    await inTenant(a.ctx, (tx) => record(tx, claiming, { requestId: "r", ip: "i", organizationId: b.org.id, userId: b.user.id } as { requestId: string }));

    const row = await lastOf(a.org.id);
    expect(row).toMatchObject({ organizationId: a.org.id, actorType: "user", actorId: a.user.id, actorLabel: a.user.email, siteId: null, action: "member.left" });
    expect(Date.now() - row.createdAt.getTime()).toBeLessThan(60_000);
    expect(await auditOf(b.org.id)).toHaveLength(1); // B's own creation, and nothing from A
  });

  it("outside an organization's transaction there is nothing to record: it refuses, and leaves no row behind", async () => {
    const a = await newTenant();
    const orgLess = async () => asOwner(async (owner) => Number((await owner.query("select count(*)::int as n from audit_logs where organization_id is null")).rows[0].n));
    const before = await orgLess();

    const refused = /must run inside an organization's transaction, with the acting user/;
    for (const attempt of [
      () => withPlatform((tx) => record(tx as unknown as TenantTx, entry(a.ctx.membership.id))),
      () => withUser(a.user.id, (tx) => record(tx as unknown as TenantTx, entry(a.ctx.membership.id))),
      // In the organization, but with nobody acting: refused too.
      () => withTenant({ orgId: a.org.id }, (tx) => record(tx, entry(a.ctx.membership.id))),
    ]) {
      const error = await attempt().then(() => null, (thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(AuditEventError);
      expect((error as Error).message).toMatch(refused);
    }

    expect(await orgLess()).toBe(before);
    expect(await actionsOf(a.org.id)).toEqual(["organization.created"]);
  });

  it("from inside one organization, a row for another cannot be written at all: the database refuses", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const forged = withTenant({ orgId: a.org.id, userId: a.user.id }, (tx) =>
      tx.insert(t.auditLogs).values({ organizationId: b.org.id, actorType: "user", actorId: a.user.id, action: "member.removed", resourceType: "membership" }),
    );
    expect((await dbError(forged)).code).toBe(PG.insufficientPrivilege);
    expect(await actionsOf(b.org.id)).toEqual(["organization.created"]);
  });

  it("the request id and address are stored as given, cut to size, and never interpreted", async () => {
    const a = await newTenant();
    await inTenant(a.ctx, (tx) => record(tx, entry(a.ctx.membership.id), { requestId: "x".repeat(500), ip: `${"9".repeat(200)}'; drop table audit_logs; --` }));
    const row = await lastOf(a.org.id);
    expect(row.requestId).toHaveLength(100);
    expect(row.ip).toHaveLength(64);
    await inTenant(a.ctx, (tx) => record(tx, entry(a.ctx.membership.id), { requestId: undefined, ip: 7 as unknown as string }));
    expect(await lastOf(a.org.id)).toMatchObject({ requestId: "", ip: "" });
  });
});

describe("what a record holds", () => {
  it("never a token, a hash, a link or a password, whatever the caller hands over", async () => {
    const a = await newTenant();
    const invitee = await createUser({ email: address() });
    const invitation = await inviteMember(a.ctx, { email: invitee.email, role: "viewer" });
    const token = await tokenOf(invitation.id);
    const [stored] = await invitationRows(a.org.id);
    await acceptInvitation(actorOf(invitee), token);

    // A careless caller: secrets next to the details the event names.
    await inTenant(a.ctx, (tx) =>
      record(
        tx,
        {
          action: "member.invited", resourceType: "invitation", resourceId: invitation.id,
          metadata: {
            email: "careless@example.test", role: "viewer", token, tokenHash: stored!.tokenHash, url: `http://localhost:3000/invite/${token}`, password: "hunter2hunter2",
            session: "s", apiKey: "k", nested: { secret: "x", fine: "y" }, anythingElse: "dropped too",
          } as { email: string; role: string },
        },
        a.ctx,
      ),
    );

    const rows = await auditOf(a.org.id);
    expect(rows.at(-1)!.metadata).toEqual({ email: "careless@example.test", role: "viewer" });
    const everything = JSON.stringify(rows);
    for (const secret of [token, stored!.tokenHash, "/invite/", "hunter2", "dropped too"]) expect(everything).not.toContain(secret);
    // Across everything this organization has recorded: only keys the events name.
    const keys = new Set(rows.flatMap((row) => Object.keys(row.metadata)));
    expect([...keys].sort()).toEqual(["email", "name", "role", "slug"]);
  });

  it("details are short strings: nothing long, nested or shaped unlike what the event names is stored", async () => {
    const a = await newTenant();
    const attempt = (metadata: unknown) => inTenant(a.ctx, (tx) => record(tx, { action: "member.removed", resourceType: "membership", resourceId: a.ctx.membership.id, metadata } as AuditEntry, a.ctx));
    for (const metadata of [{ memberName: "x".repeat(201), role: "viewer" }, { memberName: { name: "X" }, role: "viewer" }, { memberName: "X", role: "Not A Role!" }, { memberName: "", role: "viewer" }, null, "string", 7]) {
      await expect(attempt(metadata), JSON.stringify(metadata)).rejects.toBeInstanceOf(AuditEventError);
    }
    await attempt({ memberName: "  Padded Name  ", role: "viewer" });
    expect((await lastOf(a.org.id)).metadata).toEqual({ memberName: "Padded Name", role: "viewer" });
  });
});

describe("the log cannot be rewritten", () => {
  it("the application's database role can add to it and read it, and nothing else", async () => {
    const a = await newTenant();
    await updateOrganization(a.ctx, { name: "Recorded" });
    const before = await auditOf(a.org.id);
    const contexts = [
      (work: (tx: TenantTx) => Promise<unknown>) => withTenant({ orgId: a.org.id, userId: a.user.id }, work),
      (work: (tx: TenantTx) => Promise<unknown>) => withPlatform((tx) => work(tx as unknown as TenantTx)),
      (work: (tx: TenantTx) => Promise<unknown>) => withUser(a.user.id, (tx) => work(tx as unknown as TenantTx)),
    ];
    for (const within of contexts) {
      expect((await dbError(within((tx) => tx.update(t.auditLogs).set({ action: "nothing.happened" })))).code).toBe(PG.insufficientPrivilege);
      expect((await dbError(within((tx) => tx.update(t.auditLogs).set({ metadata: {} }).where(eq(t.auditLogs.id, before[0]!.id))))).code).toBe(PG.insufficientPrivilege);
      expect((await dbError(within((tx) => tx.delete(t.auditLogs)))).code).toBe(PG.insufficientPrivilege);
      expect((await dbError(within((tx) => tx.delete(t.auditLogs).where(eq(t.auditLogs.id, before[0]!.id))))).code).toBe(PG.insufficientPrivilege);
      expect((await dbError(within((tx) => tx.execute(sql`truncate audit_logs`)))).code).toBe(PG.insufficientPrivilege);
    }
    expect(await auditOf(a.org.id)).toEqual(before);
  });
});

describe("reading the activity log", () => {
  it("takes org.activity.read: Owners and Admins; everyone else is refused, in the query itself", async () => {
    const a = await newTenant();
    for (const role of ["owner", "admin"] as const) {
      const member = await addMember(a.org, role);
      expect((await listActivity(member.ctx)).items.length, role).toBeGreaterThan(0);
    }
    for (const role of ["editor", "author", "viewer"] as const) {
      const member = await addMember(a.org, role);
      const refusal = await refusalOf(() => listActivity(member.ctx, { action: "organization.created" }));
      expect({ kind: refusal.kind, message: refusal.message }, role).toEqual({ kind: "Forbidden", message: "You don't have permission to do that." });
    }
    // Nothing that is not a context from the resolver reads anything.
    for (const fake of [undefined, null, {}, { ...a.ctx }] as unknown as OrgContext[]) await expect(listActivity(fake)).rejects.toThrow(/must come from resolveOrgContext/);
  });

  it("shows this organization's events and no others: not another organization's, and not the account events that belong to none", async () => {
    const a = await newTenant("Alpha");
    const b = await newTenant("Beta");
    await updateOrganization(b.ctx, { name: "Beta Renamed" });
    // The same person is an Owner of both: their events in B are still B's.
    await addUser(b.org, a.user, "owner");
    await updateOrganization(await resolveOrgContext(a.actor, b.org.slug), { name: "Beta By Alpha's Owner" });
    // Account events (a login, a password change) belong to no organization.
    await recordPlatformEvent({ action: "auth.login", userId: a.user.id, userLabel: a.user.email, requestId: "req-login", ip: "203.0.113.1" });
    await recordPlatformEvent({ action: "auth.password_changed", userId: a.user.id, userLabel: a.user.email });

    const mine = await listActivity(a.ctx);
    expect(mine.items.map((item) => item.action)).toEqual(["organization.created"]);
    const text = JSON.stringify(mine);
    for (const foreign of [b.org.id, b.org.name, "Beta Renamed", "Beta By Alpha", "auth.login", "auth.password_changed", "req-login"]) expect(text).not.toContain(foreign);

    const theirs = await listActivity(b.ctx);
    expect(theirs.items.map((item) => item.action)).toEqual(["organization.updated", "organization.updated", "organization.created"]);
    expect(JSON.stringify(theirs)).not.toContain("auth.");
    // The same as the database sees it with no service in between: A's context, every row it can reach.
    const reachable = await withTenant({ orgId: a.org.id, userId: a.user.id }, (tx) => tx.select({ org: t.auditLogs.organizationId }).from(t.auditLogs));
    expect(new Set(reachable.map((row) => row.org))).toEqual(new Set([a.org.id]));
  });

  it("an item is what the page may show: no address of the request, no request id, no ids of users", async () => {
    const a = await newTenant();
    await updateOrganization(await withRequest(a.actor, a.org), { name: "Shown" });
    const { items } = await listActivity(a.ctx);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(["action", "actorName", "id", "metadata", "occurredAt", "resourceType"]);
      expect(item.actorName).toBe(a.user.name);
    }
    const text = JSON.stringify(items);
    for (const hidden of ["203.0.113.9", "req-audit-1", a.user.id, a.user.email]) expect(text).not.toContain(hidden);
    expect(describeEvent(items[0]!)).toBe(`${a.user.name} renamed the organization from “${a.org.name}” to “Shown”.`);
  });

  it("names the actor as they are now; someone whose account is gone keeps the address recorded at the time", async () => {
    const a = await newTenant();
    await withTenant({ orgId: a.org.id, userId: a.user.id }, (tx) =>
      tx.insert(t.auditLogs).values({ organizationId: a.org.id, actorType: "user", actorId: uuidv7(), actorLabel: "gone@example.test", action: "member.left", resourceType: "membership", metadata: { role: "viewer" } }),
    );
    await withPlatform((tx) => tx.update(t.users).set({ name: "Renamed Since" }).where(eq(t.users.id, a.user.id)));
    const { items } = await listActivity(a.ctx);
    expect(items.map((item) => item.actorName)).toEqual(["gone@example.test", "Renamed Since"]);
    expect(describeEvent(items[0]!)).toBe("gone@example.test left the organization.");
  });

  it("an event this code does not know is listed by its name, not hidden and not an error", async () => {
    const a = await newTenant();
    await withTenant({ orgId: a.org.id, userId: a.user.id }, (tx) =>
      tx.insert(t.auditLogs).values({ organizationId: a.org.id, actorType: "user", actorId: a.user.id, actorLabel: a.user.email, action: "entry.published", resourceType: "entry", metadata: { type: "post" } }),
    );
    const { items } = await listActivity(a.ctx);
    expect(items[0]!.action).toBe("entry.published");
    expect(describeEvent(items[0]!)).toBe(`${a.user.name} did something Forge cannot describe yet (entry.published).`);
    // It cannot be asked for by name through the page's filters, which know the catalog only.
    expect(parseActivityQuery({ action: "entry.published" })).toEqual({});
  });
});

describe("pages of activity", () => {
  /** `count` events for an organization, written the way a service would, each in its own transaction. */
  async function seed(ctx: OrgContext, count: number) {
    for (let i = 0; i < count; i++) {
      await inTenant(ctx, (tx) => record(tx, { action: "member.left", resourceType: "membership", resourceId: ctx.membership.id, metadata: { role: "viewer" } }, ctx));
    }
  }
  const idsOf = (page: { items: { id: string }[] }) => page.items.map((item) => item.id);

  it("newest first, 25 at a time, and following the cursor visits every event once", async () => {
    const a = await newTenant();
    await seed(a.ctx, 60);
    const all = (await auditOf(a.org.id)).reverse().map((row) => row.id); // newest first
    expect(all).toHaveLength(61);

    const first = await listActivity(a.ctx);
    expect(first.items).toHaveLength(25);
    expect(first.nextCursor).toMatch(/^\d{13,19}_[0-9a-f-]{36}$/);
    const second = await listActivity(a.ctx, { before: first.nextCursor! });
    const third = await listActivity(a.ctx, { before: second.nextCursor! });
    expect([second.items.length, third.items.length, third.nextCursor]).toEqual([25, 11, null]);
    expect([...idsOf(first), ...idsOf(second), ...idsOf(third)]).toEqual(all);

    // Something new at the top does not shift the pages below: the second page is the same events again.
    await updateOrganization(a.ctx, { name: "While Paging" });
    expect(idsOf(await listActivity(a.ctx, { before: first.nextCursor! }))).toEqual(idsOf(second));
    expect((await listActivity(a.ctx)).items[0]!.action).toBe("organization.updated");
  });

  it("events of one instant keep one order: their ids decide, and paging does not lose or repeat any", async () => {
    const a = await newTenant();
    // One transaction: one `now()`, so one `created_at` for all twelve.
    await inTenant(a.ctx, async (tx) => {
      for (let i = 0; i < 12; i++) await record(tx, { action: "member.left", resourceType: "membership", resourceId: a.ctx.membership.id, metadata: { role: "viewer" } }, a.ctx);
    });
    const rows = (await auditOf(a.org.id)).filter((row) => row.action === "member.left");
    expect(new Set(rows.map((row) => row.createdAt.getTime())).size).toBe(1);
    const expected = rows.map((row) => row.id).sort().reverse();

    const seen: string[] = [];
    let before: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await withTenant({ orgId: a.org.id, userId: a.user.id }, (tx) => queryActivity(tx, a.org.id, { action: "member.left", before }, 5));
      seen.push(...idsOf(page));
      if (!page.nextCursor) break;
      before = page.nextCursor;
    }
    expect(seen).toEqual(expected);
    // Asked twice, the same answer.
    expect(idsOf(await listActivity(a.ctx, { action: "member.left" }))).toEqual(expected);
  });

  it("events a few microseconds apart are not skipped: the cursor keeps the time exactly as the database has it", async () => {
    const a = await newTenant();
    const base = "2026-03-04 05:06:07.123";
    // Six events inside one millisecond, which a JavaScript date cannot tell apart.
    await withTenant({ orgId: a.org.id, userId: a.user.id }, async (tx) => {
      for (let micro = 1; micro <= 6; micro++) {
        await tx.execute(sql`insert into audit_logs (id, organization_id, actor_type, actor_id, action, resource_type, metadata, created_at)
          values (${uuidv7()}, ${a.org.id}, 'user', ${a.user.id}, 'member.left', 'membership', ${JSON.stringify({ role: `micro_${micro}` })}::jsonb, ${`${base}${String(micro).padStart(3, "0")}+00`}::timestamptz)`);
      }
    });
    const roles: string[] = [];
    let before: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await withTenant({ orgId: a.org.id, userId: a.user.id }, (tx) => queryActivity(tx, a.org.id, { action: "member.left", before }, 2));
      roles.push(...page.items.map((item) => String(item.metadata.role)));
      expect(new Set(page.items.map((item) => item.occurredAt.getTime())).size).toBe(1); // indistinguishable at millisecond precision
      if (!page.nextCursor) break;
      before = page.nextCursor;
    }
    expect(roles).toEqual(["micro_6", "micro_5", "micro_4", "micro_3", "micro_2", "micro_1"]);
  });

  it("a cursor that is not one is ignored, and a page size is kept within bounds", async () => {
    const a = await newTenant();
    await seed(a.ctx, 3);
    const newest = idsOf(await listActivity(a.ctx));
    for (const before of ["", "garbage", "1_2", `${"9".repeat(40)}_${uuidv7()}`, "'; drop table audit_logs; --", `1700000000000000_${uuidv7()}x`]) {
      expect(idsOf(await listActivity(a.ctx, parseActivityQuery({ before }))), before).toEqual(newest);
    }
    const within = (limit: number) => withTenant({ orgId: a.org.id, userId: a.user.id }, (tx) => queryActivity(tx, a.org.id, {}, limit));
    expect((await within(0)).items).toHaveLength(4); // no size given: the default
    expect((await within(-5)).items).toHaveLength(1); // never less than one
    expect((await within(2)).items).toHaveLength(2);
    expect((await within(1_000_000)).items).toHaveLength(4); // capped at 100 a page, whatever is asked
  });

  it("the query reads the log through its index: newest-first for one organization, without sorting the table", async () => {
    const a = await newTenant();
    await seed(a.ctx, 5);
    const plan = await withTenant({ orgId: a.org.id, userId: a.user.id }, async (tx) => {
      // A small table would be scanned whole whatever its indexes are. What is asked here is whether the index CAN serve the order.
      await tx.execute(sql`set local enable_seqscan = off`);
      await tx.execute(sql`set local enable_bitmapscan = off`);
      const result = await tx.execute<{ "QUERY PLAN": unknown }>(
        sql`explain (format json) select id from audit_logs where organization_id = ${a.org.id} order by created_at desc nulls last, id desc limit 26`,
      );
      return JSON.stringify(result.rows[0]!["QUERY PLAN"]);
    });
    expect(plan).toContain("audit_logs_org_created_idx");
    // Ordered by the index; at most the ids of one instant are sorted among themselves.
    expect(plan).not.toMatch(/"Node Type":"Sort"/);
  });
});

describe("filters", () => {
  it("by event, by member, by site and by day, alone and together; each narrows within the organization", async () => {
    const a = await newTenant();
    const admin = await addMember(a.org, "admin");
    const site = await createSite(a.org.id, a.user.id);
    await updateOrganization(a.ctx, { name: "Filtered" }); // by the Owner
    await inviteMember(admin.ctx, { email: address(), role: "viewer" }); // by the Admin
    await inviteMember(a.ctx, { email: address(), role: "editor" }); // by the Owner
    // A site-level event, as M4 will write them, and two events on known days.
    await withTenant({ orgId: a.org.id, userId: a.user.id }, async (tx) => {
      await tx.insert(t.auditLogs).values({ organizationId: a.org.id, siteId: site.id, actorType: "user", actorId: a.user.id, action: "member.left", resourceType: "membership", metadata: { role: "viewer" } });
      for (const [when, role] of [["2026-01-10T23:59:59.999Z", "january_tenth"], ["2026-01-11T00:00:00.000Z", "january_eleventh"], ["2026-01-12T12:00:00.000Z", "january_twelfth"]] as const) {
        await tx.insert(t.auditLogs).values({ organizationId: a.org.id, actorType: "user", actorId: admin.user.id, action: "member.left", resourceType: "membership", metadata: { role }, createdAt: new Date(when) });
      }
    });
    const actions = async (query: Parameters<typeof listActivity>[1]) => (await listActivity(a.ctx, query)).items.map((item) => item.action);
    const roles = async (query: Parameters<typeof listActivity>[1]) => (await listActivity(a.ctx, query)).items.map((item) => String(item.metadata.role));

    expect(await actions({ action: "member.invited" })).toEqual(["member.invited", "member.invited"]);
    expect(await actions({ action: "organization.updated" })).toEqual(["organization.updated"]);
    expect(await actions({ action: "invitation.revoked" })).toEqual([]);

    // By member: named by membership id, and it is that person's events only.
    expect(await actions({ member: admin.memberId, action: "member.invited" })).toEqual(["member.invited"]);
    expect((await actions({ member: a.ctx.membership.id })).sort()).toEqual(["member.invited", "member.left", "organization.created", "organization.updated"]);

    expect(await actions({ site: site.id })).toEqual(["member.left"]);
    expect(await actions({ site: uuidv7() })).toEqual([]);

    // Days are whole UTC days, both ends included.
    expect(await roles({ from: "2026-01-11", to: "2026-01-11" })).toEqual(["january_eleventh"]);
    expect(await roles({ from: "2026-01-10", to: "2026-01-11" })).toEqual(["january_eleventh", "january_tenth"]);
    expect(await roles({ to: "2026-01-10" })).toEqual(["january_tenth"]);
    expect(await roles({ from: "2026-01-11", to: "2026-01-31" })).toEqual(["january_twelfth", "january_eleventh"]);
    expect(await roles({ from: "2026-01-12", to: "2026-01-10" })).toEqual([]); // an empty span is empty, not everything
    expect(await roles({ member: admin.memberId, from: "2026-01-12", to: "2026-01-12", action: "member.left" })).toEqual(["january_twelfth"]);
    expect(await roles({ member: a.ctx.membership.id, from: "2026-01-01", to: "2026-01-31" })).toEqual([]);
  });

  it("a member filter that is not one of this organization's members matches nobody, rather than everybody", async () => {
    const a = await newTenant();
    const b = await newTenant();
    await updateOrganization(b.ctx, { name: "B's Business" });
    // A's Owner is also a member of B: B's membership id is still not a member of A.
    const inB = await addUser(b.org, a.user, "admin");
    for (const member of [b.ctx.membership.id, inB.memberId, uuidv7(), a.user.id, a.org.id]) {
      expect(await listActivity(a.ctx, { member }), member).toEqual({ items: [], nextCursor: null });
    }
    expect((await listActivity(a.ctx, { member: a.ctx.membership.id })).items).toHaveLength(1);
  });
});

describe("the same rules under concurrency", () => {
  it("two Owners demoting each other at once: one change, one record", async () => {
    for (let round = 0; round < 3; round++) {
      const a = await newTenant();
      const second = await addMember(a.org, "owner");
      const results = await Promise.allSettled([
        changeMemberRole(a.ctx, { memberId: second.memberId, role: "admin" }),
        changeMemberRole(second.ctx, { memberId: a.ctx.membership.id, role: "admin" }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      const changes = (await auditOf(a.org.id)).filter((row) => row.action === "member.role_changed");
      expect(changes).toHaveLength(1);
      // The record names the change that happened, by the one who made it.
      const winner = results[0]!.status === "fulfilled" ? a.user.id : second.user.id;
      expect(changes[0]).toMatchObject({ actorId: winner, metadata: { previousRole: "owner", newRole: "admin" } });
      expect(Object.values(await rolesOf(a.org.id)).sort()).toEqual(["admin", "owner"]);
    }
  });

  it("one invitation link submitted many times at once: one membership, one record", async () => {
    const a = await newTenant();
    const invitee = await createUser({ email: address() });
    const invitation = await inviteMember(a.ctx, { email: invitee.email, role: "editor" });
    const token = await tokenOf(invitation.id);
    await Promise.all(Array.from({ length: 6 }, () => acceptInvitation(actorOf(invitee), token)));
    expect((await auditOf(a.org.id)).filter((row) => row.action === "invitation.accepted")).toHaveLength(1);
  });

  it("two managers inviting one address at once: one invitation, one record", async () => {
    const a = await newTenant();
    const admin = await addMember(a.org, "admin");
    const email = address();
    await Promise.allSettled([inviteMember(a.ctx, { email, role: "editor" }), inviteMember(admin.ctx, { email, role: "viewer" })]);
    const invited = (await auditOf(a.org.id)).filter((row) => row.action === "member.invited");
    expect(invited).toHaveLength(1);
    const [row] = await invitationRows(a.org.id);
    expect(invited[0]).toMatchObject({ resourceId: row!.id, metadata: { email } });
  });

  it("accepted or revoked, never both: the log has the one that happened", async () => {
    for (let round = 0; round < 4; round++) {
      const a = await newTenant();
      const invitee = await createUser({ email: address() });
      const invitation = await inviteMember(a.ctx, { email: invitee.email, role: "viewer" });
      const token = await tokenOf(invitation.id);
      const [accepted] = await Promise.allSettled([acceptInvitation(actorOf(invitee), token), revokeInvitation(a.ctx, { invitationId: invitation.id })]);
      const after = (await actionsOf(a.org.id)).filter((action) => action.startsWith("invitation."));
      expect(after).toEqual([accepted.status === "fulfilled" ? "invitation.accepted" : "invitation.revoked"]);
    }
  });
});
