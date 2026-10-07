import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/modules/auth/shared";
import {
  acceptInvitation, inviteMember, listInvitations, listMembers, listOrganizations, previewInvitation, resendInvitation, resolveOrgContext,
  revokeInvitation, submitAcceptInvitation, submitChangeMemberRole, submitInviteMember, submitLeaveOrganization, submitRemoveMember,
  submitResendInvitation, submitRevokeInvitation, submitTransferOwnership, type FormOutcome,
} from "@/modules/tenancy";
import * as t from "@/platform/db/schema";
import { withPlatform, withTenant } from "@/platform/db/tenant";
import { emailSend } from "@/platform/email";
import { setEmailProviderForTests } from "@/platform/email/get-provider";
import { CaptureEmailProvider } from "@/platform/email/providers/capture";
import { createJobRegistry, runJobs } from "@/platform/jobs";
import { jobs } from "@/platform/jobs/schema";
import { setLogSink } from "@/platform/observability/logger";
import { createUser, roleId } from "../fixtures/factories";
import { actorOf, addMember, addUser, newTenant, refusalOf } from "../fixtures/tenants";

/**
 * M3-4 against real Postgres (as forge_app through PgBouncer): invitations
 * from creation to acceptance, and the members page's forms. The email job is
 * run with a capturing provider, so what would be sent can be read.
 *
 * The raw token is never returned by the service. These tests get it where the
 * invited person gets it: from the link in the email that was queued.
 */

const APP = "http://localhost:3000"; // APP_ORIGIN in tests/setup/integration-env.ts
const DAY = 24 * 3600 * 1000;
const FORBIDDEN = "You don't have permission to do that.";
const capture = new CaptureEmailProvider();
const logs: string[] = [];

beforeAll(() => {
  setEmailProviderForTests(capture);
  setLogSink((_level, line) => logs.push(line));
});
afterAll(async () => {
  // Leave the worker's queue as we found it: other suites count the jobs they run.
  await withPlatform((tx) => tx.delete(jobs).where(eq(jobs.type, "email.send")));
  setEmailProviderForTests(null);
  setLogSink(null);
});
beforeEach(() => capture.clear());

const unique = () => uuidv7().slice(-12);
const address = (label = "invitee") => `${label}-${unique()}@example.test`;
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};
/** The admin URLs of an organization that a change makes stale, its activity log among them. */
const pages = (slug: string) => [`/${slug}`, `/${slug}/settings`, `/${slug}/members`, `/${slug}/activity`];
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const runEmails = () => runJobs({ registry: createJobRegistry([emailSend]), budgetMs: 20_000, random: () => 0.5 });

const invitationRows = (orgId: string) => withTenant({ orgId }, (tx) => tx.select().from(t.organizationInvitations).where(eq(t.organizationInvitations.organizationId, orgId)));
const invitationRow = async (orgId: string, id: string) => (await invitationRows(orgId)).find((row) => row.id === id)!;
const emailJobs = async (invitationId: string) =>
  (await withPlatform((tx) => tx.select().from(jobs).where(and(eq(jobs.type, "email.send"), sql`${jobs.payload}->>'invitationId' = ${invitationId}`)).orderBy(jobs.createdAt, jobs.id)));

/** The token in the link of the newest email queued for an invitation: what the invited person would click. */
async function tokenOf(invitationId: string): Promise<string> {
  const queued = await emailJobs(invitationId);
  const url = String(queued.at(-1)!.payload.url);
  expect(url.startsWith(`${APP}/invite/`)).toBe(true);
  return url.slice(`${APP}/invite/`.length);
}

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

/** Moves an invitation's dates, as time would. */
const setInvitation = (orgId: string, id: string, values: Partial<{ expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null }>) =>
  withTenant({ orgId }, (tx) => tx.update(t.organizationInvitations).set(values).where(eq(t.organizationInvitations.id, id)));
/** An invitation sent `minutesAgo`: its expiry is what says when it was sent. */
const sentMinutesAgo = (orgId: string, id: string, minutesAgo: number) => setInvitation(orgId, id, { expiresAt: new Date(Date.now() + 7 * DAY - minutesAgo * 60_000) });

/** An organization with an invitation for a new person, and that person's account and link. */
async function invited(role: "admin" | "editor" | "author" | "viewer" = "editor") {
  const a = await newTenant();
  const user = await createUser({ name: "Ivy Invitee", email: address() });
  const invitation = await inviteMember(a.ctx, { email: user.email, role });
  return { a, user, actor: actorOf(user), invitation, token: await tokenOf(invitation.id) };
}

function expectRefused(outcome: FormOutcome, kind: string, message?: string) {
  expect(outcome.refused).toBe(kind);
  expect(outcome.state.status).toBe("error");
  if (message !== undefined) expect(outcome.state.message).toBe(message);
  expect(outcome.revalidate).toBeUndefined();
  expect(outcome.emailQueued).toBeUndefined();
}

describe("inviting someone", () => {
  it("stores the invitation with a hashed token and a 7-day expiry, and queues its email in the same transaction", async () => {
    const a = await newTenant();
    const email = address();
    const before = Date.now();
    const invitation = await inviteMember(a.ctx, { email: `  ${email.toUpperCase()} `, role: "editor" });

    expect(invitation).toMatchObject({ email, role: "editor", invitedByName: a.user.name, expired: false });
    const days = (invitation.expiresAt.getTime() - before) / DAY;
    expect(days).toBeGreaterThan(6.999);
    expect(days).toBeLessThan(7.001);

    // The row: this organization's, one spelling of the address, and a hash where a token would be.
    const row = await invitationRow(a.org.id, invitation.id);
    expect(row).toMatchObject({ organizationId: a.org.id, email, invitedBy: a.user.id, acceptedAt: null, revokedAt: null, roleId: await withTenant({ orgId: a.org.id }, (tx) => roleId(tx, "editor")) });
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    // The job: queued by the same transaction, for this organization, carrying the only copy of the link.
    const [job] = await emailJobs(invitation.id);
    expect(job).toMatchObject({ type: "email.send", status: "queued", organizationId: a.org.id });
    expect(job!.payload).toMatchObject({ template: "organization-invitation", invitationId: invitation.id });
    const token = await tokenOf(invitation.id);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row.tokenHash).toBe(sha256(token));
    // Nothing in the invitation's row is the token, or contains it.
    expect(JSON.stringify(row)).not.toContain(token);
    // Nor is it in what the service returned, or in any log line.
    expect(JSON.stringify(invitation)).not.toContain(token);
    expect(logs.join("\n")).not.toContain(token);

    expect(await listInvitations(a.ctx)).toEqual([invitation]);
  });

  it("the email names the organization, the inviter and the role, carries the link, and the stored job forgets the link once sent", async () => {
    const a = await newTenant("Acme");
    const email = address();
    const invitation = await inviteMember(a.ctx, { email, role: "author" });
    const token = await tokenOf(invitation.id);
    const [job] = await emailJobs(invitation.id);

    expect(capture.messages).toHaveLength(0); // nothing is sent inside the transaction
    await runEmails();
    const [mail] = capture.to(email);
    expect(mail).toMatchObject({ subject: `${a.user.name} invited you to ${a.org.name} on Forge`, idempotencyKey: job!.id, tags: { template: "organization-invitation" } });
    expect(mail!.text).toContain(`${a.user.name} invited you to join ${a.org.name} as Author.`);
    expect(mail!.text).toContain(`${APP}/invite/${token}`);
    expect(mail!.text).toContain("This invitation expires on");
    expect(mail!.html).toContain(`${APP}/invite/${token}`);
    // To the invited address and nobody else.
    expect(capture.messages.filter((m) => m.text.includes(token)).map((m) => m.to)).toEqual([email]);

    // Once delivered, the link is erased from the job: the database holds the hash and nothing else.
    const [finished] = await emailJobs(invitation.id);
    expect(finished).toMatchObject({ status: "succeeded" });
    expect(finished!.payload).toMatchObject({ url: "[redacted]", invitationId: invitation.id });
    expect(JSON.stringify(finished)).not.toContain(token);
    expect(logs.join("\n")).not.toContain(token);
    // The link still works: redacting the job did not touch the invitation.
    expect((await previewInvitation(token)).status).toBe("open");
  });

  it("takes org.members.manage: Owners and Admins invite; everyone else is refused before their input is read", async () => {
    const a = await newTenant();
    const admin = await addMember(a.org, "admin");
    expect((await inviteMember(admin.ctx, { email: address(), role: "viewer" })).invitedByName).toBe("A admin");

    for (const role of ["editor", "author", "viewer"] as const) {
      const member = await addMember(a.org, role);
      const answers = new Set<string>();
      for (const input of [{ email: address(), role: "viewer" }, { email: "not an email", role: "nonsense" }, { email: "", role: "owner" }]) {
        const refusal = await refusalOf(() => inviteMember(member.ctx, input));
        answers.add(`${refusal.kind}: ${refusal.message}`);
      }
      expect([...answers], role).toEqual([`Forbidden: ${FORBIDDEN}`]);
      expect((await refusalOf(() => listInvitations(member.ctx))).kind, role).toBe("Forbidden");
    }
    expect(await listInvitations(a.ctx)).toHaveLength(1);
  });

  it("takes a verified email of the inviter's own (plan §12), for an Owner too", async () => {
    const user = await createUser({ emailVerified: false });
    const a = await newTenant();
    await addUser(a.org, user, "owner");
    const unverified = { ...actorOf(user), emailVerified: false } as Actor;
    const ctx = await resolveOrgContext(unverified, a.org.slug);

    const email = address();
    const refusal = await refusalOf(() => inviteMember(ctx, { email, role: "editor" }));
    expect({ kind: refusal.kind, message: refusal.message }).toEqual({ kind: "Forbidden", message: "Verify your email address before inviting people." });
    expect(await invitationRows(a.org.id)).toEqual([]);
    // Once verified (their next request says so), the same invitation goes out.
    const verified = await resolveOrgContext(actorOf(user), a.org.slug);
    expect((await inviteMember(verified, { email, role: "editor" })).email).toBe(email);
  });

  it("nobody is invited as an Owner, by anyone; and only a real role and a real address are accepted", async () => {
    const a = await newTenant();
    const admin = await addMember(a.org, "admin");
    for (const ctx of [a.ctx, admin.ctx]) {
      const refusal = await refusalOf(() => inviteMember(ctx, { email: address(), role: "owner" }));
      expect({ kind: refusal.kind, fieldErrors: refusal.fieldErrors }).toEqual({ kind: "Validation", fieldErrors: { role: ["Choose a role."] } });
    }
    const invalid: [{ email: string; role: string }, string, string][] = [
      [{ email: address(), role: "" }, "role", "Choose a role."],
      [{ email: address(), role: "superuser" }, "role", "Choose a role."],
      [{ email: address(), role: "Admin" }, "role", "Choose a role."],
      [{ email: "", role: "viewer" }, "email", "Enter an email address."],
      [{ email: "   ", role: "viewer" }, "email", "Enter an email address."],
      [{ email: "not-an-email", role: "viewer" }, "email", "Enter a valid email address."],
      [{ email: "two@addresses.test, three@addresses.test", role: "viewer" }, "email", "Enter a valid email address."],
      [{ email: `${"x".repeat(250)}@example.test`, role: "viewer" }, "email", "Enter a valid email address."],
    ];
    for (const [input, field, message] of invalid) {
      const refusal = await refusalOf(() => inviteMember(a.ctx, input));
      expect(refusal.kind, JSON.stringify(input)).toBe("Validation");
      expect(refusal.fieldErrors).toEqual({ [field]: [message] });
    }
    expect(await invitationRows(a.org.id)).toEqual([]);
    expect(await emailJobs(uuidv7())).toEqual([]);
  });
});

describe("the same address, more than once", () => {
  it("someone who is already a member is not invited, whatever the spelling", async () => {
    const a = await newTenant();
    // An account's address has one spelling in the database (a CHECK constraint); what is typed into the form may not.
    const member = await createUser({ email: `mixed.case-${unique()}@example.test` });
    await addUser(a.org, member, "viewer");
    for (const email of [member.email, member.email.toUpperCase(), `  ${member.email} `, `Mixed.Case${member.email.slice(10)}`, a.user.email]) {
      const refusal = await refusalOf(() => inviteMember(a.ctx, { email, role: "editor" }));
      expect(refusal.fieldErrors, email).toEqual({ email: ["That person is already a member of this organization."] });
    }
    expect(await invitationRows(a.org.id)).toEqual([]);
  });

  it("an address with an invitation pending is not invited again: one invitation, one email", async () => {
    const a = await newTenant();
    const admin = await addMember(a.org, "admin");
    const email = address();
    const first = await inviteMember(a.ctx, { email, role: "editor" });
    for (const [ctx, input] of [[a.ctx, { email, role: "editor" }], [a.ctx, { email: email.toUpperCase(), role: "viewer" }], [admin.ctx, { email: ` ${email} `, role: "admin" }]] as const) {
      const refusal = await refusalOf(() => inviteMember(ctx, input));
      expect(refusal.fieldErrors).toEqual({ email: ["There is already an invitation for this address. You can send it again or revoke it."] });
    }
    const rows = await invitationRows(a.org.id);
    expect(rows.map((row) => row.id)).toEqual([first.id]);
    expect(await emailJobs(first.id)).toHaveLength(1);
    // The role first chosen stands: a refused repeat changes nothing.
    expect((await listInvitations(a.ctx))[0]!.role).toBe("editor");
  });

  it("an invitation that expired unused gives way to a new one, and its link stays dead", async () => {
    const a = await newTenant();
    const email = address();
    const first = await inviteMember(a.ctx, { email, role: "editor" });
    const oldToken = await tokenOf(first.id);
    await setInvitation(a.org.id, first.id, { expiresAt: new Date(Date.now() - 60_000) });

    const second = await inviteMember(a.ctx, { email, role: "viewer" });
    expect(second.id).not.toBe(first.id);
    expect((await invitationRow(a.org.id, first.id)).revokedAt).toBeInstanceOf(Date);
    expect((await listInvitations(a.ctx)).map((i) => [i.id, i.role])).toEqual([[second.id, "viewer"]]);
    expect(await previewInvitation(oldToken)).toEqual({ status: "invalid" });
    expect((await previewInvitation(await tokenOf(second.id))).status).toBe("open");
  });

  it("the same person can be invited to two organizations: each invitation is its own", async () => {
    const [a, b] = [await newTenant(), await newTenant()];
    const email = address();
    const [inA, inB] = [await inviteMember(a.ctx, { email, role: "editor" }), await inviteMember(b.ctx, { email, role: "viewer" })];
    expect((await listInvitations(a.ctx)).map((i) => i.id)).toEqual([inA.id]);
    expect((await listInvitations(b.ctx)).map((i) => i.id)).toEqual([inB.id]);
    expect(await tokenOf(inA.id)).not.toBe(await tokenOf(inB.id));
  });

  it("holds under concurrency: two managers inviting one address at once make one invitation", async () => {
    for (let round = 0; round < 3; round++) {
      const a = await newTenant();
      const admin = await addMember(a.org, "admin");
      const email = address();
      const results = await Promise.allSettled([inviteMember(a.ctx, { email, role: "editor" }), inviteMember(admin.ctx, { email, role: "viewer" })]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ kind: "Validation" });
      const rows = await invitationRows(a.org.id);
      expect(rows).toHaveLength(1);
      expect(await emailJobs(rows[0]!.id)).toHaveLength(1);
    }
  });
});

describe("sending an invitation again, and revoking one", () => {
  it("a re-send is a new link for another 7 days; the link sent before stops working", async () => {
    const { a, invitation, token } = await invited();
    // Sent a moment ago: not yet.
    expect((await refusalOf(() => resendInvitation(a.ctx, { invitationId: invitation.id }))).kind).toBe("RateLimited");
    expect(await emailJobs(invitation.id)).toHaveLength(1);

    await sentMinutesAgo(a.org.id, invitation.id, 5);
    const before = Date.now();
    const resent = await resendInvitation(a.ctx, { invitationId: invitation.id });
    expect(resent).toMatchObject({ id: invitation.id, email: invitation.email, role: "editor", expired: false });
    expect((resent.expiresAt.getTime() - before) / DAY).toBeGreaterThan(6.999);

    const newToken = await tokenOf(invitation.id);
    expect(newToken).not.toBe(token);
    expect((await invitationRow(a.org.id, invitation.id)).tokenHash).toBe(sha256(newToken));
    expect(await previewInvitation(token)).toEqual({ status: "invalid" });
    expect((await previewInvitation(newToken)).status).toBe("open");
    expect(await emailJobs(invitation.id)).toHaveLength(2);
    // Still one invitation for the address.
    expect(await invitationRows(a.org.id)).toHaveLength(1);
  });

  it("an expired invitation can be sent again, and is pending once more", async () => {
    const { a, invitation, token, actor } = await invited();
    await setInvitation(a.org.id, invitation.id, { expiresAt: new Date(Date.now() - DAY) });
    expect((await listInvitations(a.ctx))[0]).toMatchObject({ id: invitation.id, expired: true });
    expect(await previewInvitation(token)).toEqual({ status: "expired" });

    await resendInvitation(a.ctx, { invitationId: invitation.id });
    expect((await listInvitations(a.ctx))[0]).toMatchObject({ id: invitation.id, expired: false });
    // The expired link does not come back to life; the new one works.
    expect((await refusalOf(() => acceptInvitation(actor, token))).kind).toBe("NotFound");
    expect((await acceptInvitation(actor, await tokenOf(invitation.id))).joined).toBe(true);
  });

  it("revoking: the link stops working at once, the invitation leaves the list, and the address can be invited again", async () => {
    const { a, invitation, token, actor, user } = await invited();
    await revokeInvitation(a.ctx, { invitationId: invitation.id });

    expect((await invitationRow(a.org.id, invitation.id)).revokedAt).toBeInstanceOf(Date);
    expect(await listInvitations(a.ctx)).toEqual([]);
    expect(await previewInvitation(token)).toEqual({ status: "invalid" });
    expect((await refusalOf(() => acceptInvitation(actor, token))).kind).toBe("NotFound");
    expect(await rolesOf(a.org.id)).toEqual({ [a.user.id]: "owner" });
    // Done once: a second revoke, or a re-send, finds nothing open.
    expect((await refusalOf(() => revokeInvitation(a.ctx, { invitationId: invitation.id }))).kind).toBe("NotFound");
    expect((await refusalOf(() => resendInvitation(a.ctx, { invitationId: invitation.id }))).kind).toBe("NotFound");
    // An email already on its way when the invitation is revoked is not sent.
    await runEmails();
    expect(capture.to(user.email)).toEqual([]);

    const again = await inviteMember(a.ctx, { email: user.email, role: "viewer" });
    expect((await acceptInvitation(actor, await tokenOf(again.id))).joined).toBe(true);
    expect((await rolesOf(a.org.id))[user.id]).toBe("viewer");
  });

  it("both take org.members.manage, and an invitation of another organization is not found", async () => {
    const { a, invitation } = await invited();
    const b = await invited();
    await sentMinutesAgo(a.org.id, invitation.id, 5);
    for (const role of ["editor", "author", "viewer"] as const) {
      const member = await addMember(a.org, role);
      for (const invitationId of [invitation.id, b.invitation.id, uuidv7(), "not-a-uuid"]) {
        expect((await refusalOf(() => resendInvitation(member.ctx, { invitationId }))).kind, role).toBe("Forbidden");
        expect((await refusalOf(() => revokeInvitation(member.ctx, { invitationId }))).kind, role).toBe("Forbidden");
      }
    }
    // With the permission, in A: B's invitation, an invitation that never was, and things that are not ids.
    for (const invitationId of [b.invitation.id, uuidv7(), a.org.id, a.user.id, "not-a-uuid", ""]) {
      expect((await refusalOf(() => resendInvitation(a.ctx, { invitationId }))).kind, invitationId).toBe("NotFound");
      expect((await refusalOf(() => revokeInvitation(a.ctx, { invitationId }))).kind, invitationId).toBe("NotFound");
    }
    expect((await invitationRow(b.a.org.id, b.invitation.id)).revokedAt).toBeNull();
    expect(await emailJobs(b.invitation.id)).toHaveLength(1);
    expect(await emailJobs(invitation.id)).toHaveLength(1);

    // An Admin manages invitations like an Owner does.
    const admin = await addMember(a.org, "admin");
    await resendInvitation(admin.ctx, { invitationId: invitation.id });
    await revokeInvitation(admin.ctx, { invitationId: invitation.id });
    expect(await listInvitations(a.ctx)).toEqual([]);
  });
});

describe("what an invitation link shows", () => {
  it("an open invitation: the organization, the role, the address it was sent to, and who sent it", async () => {
    const { a, invitation, token } = await invited("author");
    expect(await previewInvitation(token)).toEqual({
      status: "open", email: invitation.email, role: "author", organizationName: a.org.name, inviterName: a.user.name, expiresAt: invitation.expiresAt,
    });
  });

  it("anything else names nothing: unknown, malformed, used, revoked, expired, or an organization that cannot be joined", async () => {
    const nothing = [
      "", "x", "not-a-token", uuidv7(), "a".repeat(43), "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}!`, "../../etc/passwd", "%00", " ".repeat(43),
      undefined, null, 7, {}, [],
    ];
    for (const token of nothing as unknown as string[]) expect(await previewInvitation(token), String(token)).toEqual({ status: "invalid" });

    // The invitation's id, or its hash, is not its token.
    const one = await invited();
    expect(await previewInvitation(one.invitation.id)).toEqual({ status: "invalid" });
    expect(await previewInvitation((await invitationRow(one.a.org.id, one.invitation.id)).tokenHash.slice(0, 43))).toEqual({ status: "invalid" });

    const used = await invited();
    await acceptInvitation(used.actor, used.token);
    expect(await previewInvitation(used.token)).toEqual({ status: "invalid" });

    const revoked = await invited();
    await revokeInvitation(revoked.a.ctx, { invitationId: revoked.invitation.id });
    expect(await previewInvitation(revoked.token)).toEqual({ status: "invalid" });

    const expired = await invited();
    await setInvitation(expired.a.org.id, expired.invitation.id, { expiresAt: new Date(Date.now() - 1000) });
    expect(await previewInvitation(expired.token)).toEqual({ status: "expired" });

    const suspended = await invited();
    await withTenant({ orgId: suspended.a.org.id }, (tx) => tx.update(t.organizations).set({ status: "suspended" }).where(eq(t.organizations.id, suspended.a.org.id)));
    expect(await previewInvitation(suspended.token)).toEqual({ status: "invalid" });

    const deleted = await invited();
    await withTenant({ orgId: deleted.a.org.id }, (tx) => tx.update(t.organizations).set({ deletedAt: new Date() }).where(eq(t.organizations.id, deleted.a.org.id)));
    expect(await previewInvitation(deleted.token)).toEqual({ status: "invalid" });
  });
});

describe("accepting an invitation", () => {
  it("the invited account joins with the invited role, the invitation is used, and nothing else about them changes", async () => {
    const elsewhere = await newTenant("Elsewhere");
    const { a, user, actor, invitation, token } = await invited("author");
    await addUser(elsewhere.org, user, "admin"); // already a member of another organization
    const before = (await withPlatform((tx) => tx.select().from(t.users).where(eq(t.users.id, user.id))))[0];

    const accepted = await acceptInvitation(actor, token);
    expect(accepted).toEqual({ organization: { slug: a.org.slug, name: a.org.name }, joined: true });

    expect(await rolesOf(a.org.id)).toEqual({ [a.user.id]: "owner", [user.id]: "author" });
    const ctx = await resolveOrgContext(actor, a.org.slug);
    expect(ctx.membership.role).toBe("author");
    expect((await listMembers(a.ctx)).find((m) => m.userId === user.id)).toMatchObject({ name: "Ivy Invitee", email: user.email, role: "author" });

    const row = await invitationRow(a.org.id, invitation.id);
    expect(row.acceptedAt).toBeInstanceOf(Date);
    expect(row.revokedAt).toBeNull();
    expect(await listInvitations(a.ctx)).toEqual([]);

    // Their account, and their other membership, are as they were.
    expect((await withPlatform((tx) => tx.select().from(t.users).where(eq(t.users.id, user.id))))[0]).toEqual(before);
    expect((await rolesOf(elsewhere.org.id))[user.id]).toBe("admin");
    expect((await listOrganizations(actor)).map((o) => [o.slug, o.role]).sort()).toEqual([[a.org.slug, "author"], [elsewhere.org.slug, "admin"]].sort());
  });

  it("goes to the account the invitation was sent to, and to no other account that holds the link", async () => {
    const { a, user, actor, invitation, token } = await invited();
    const other = await createUser({ email: address("someone-else") });
    const elsewhereOwner = await newTenant();

    for (const holder of [actorOf(other), elsewhereOwner.actor, a.actor]) {
      const refusal = await refusalOf(() => acceptInvitation(holder, token));
      expect({ kind: refusal.kind, message: refusal.message }).toEqual({
        kind: "Forbidden", message: "This invitation was sent to a different email address. Log in with that address to accept it.",
      });
    }
    expect(await rolesOf(a.org.id)).toEqual({ [a.user.id]: "owner" });
    expect((await invitationRow(a.org.id, invitation.id)).acceptedAt).toBeNull();
    expect(await listOrganizations(actorOf(other))).toEqual([]);

    // The link is not spent by someone else trying it: the person invited can still use it.
    expect((await acceptInvitation(actor, token)).joined).toBe(true);
    expect((await rolesOf(a.org.id))[user.id]).toBe("editor");
  });

  it("whose account it is comes from the database: the address is matched in one spelling, and nothing the caller sends is read", async () => {
    const a = await newTenant();
    const user = await createUser({ email: `mixed.case-${unique()}@example.test` });
    const invitation = await inviteMember(a.ctx, { email: `  ${user.email.toUpperCase()} `, role: "viewer" });
    expect(invitation.email).toBe(user.email);
    const token = await tokenOf(invitation.id);

    // Another account claiming the invited address in its actor gets nowhere: the actor carries an id, and the id's own row is what is read.
    const impostor = await createUser({ email: address("impostor") });
    const claiming = { ...actorOf(impostor), email: user.email, userEmail: user.email } as unknown as Actor;
    expect((await refusalOf(() => acceptInvitation(claiming, token))).kind).toBe("Forbidden");

    expect((await acceptInvitation(actorOf(user), token)).joined).toBe(true);
    expect(await rolesOf(a.org.id)).toEqual({ [a.user.id]: "owner", [user.id]: "viewer" });
  });

  it("needs a signed-in user, and a link that can still be accepted", async () => {
    const { a, actor, invitation, token } = await invited();
    expect((await refusalOf(() => acceptInvitation({ kind: "anonymous" }, token))).kind).toBe("Unauthenticated");
    for (const junk of ["", "not-a-token", invitation.id, "a".repeat(43), undefined, null] as unknown as string[]) {
      expect((await refusalOf(() => acceptInvitation(actor, junk))).kind, String(junk)).toBe("NotFound");
    }

    await setInvitation(a.org.id, invitation.id, { expiresAt: new Date(Date.now() - 1000) });
    const expired = await refusalOf(() => acceptInvitation(actor, token));
    expect({ kind: expired.kind, message: expired.message }).toEqual({ kind: "Conflict", message: "This invitation has expired. Ask the person who invited you to send a new one." });

    await setInvitation(a.org.id, invitation.id, { expiresAt: new Date(Date.now() + DAY), revokedAt: new Date() });
    expect((await refusalOf(() => acceptInvitation(actor, token))).kind).toBe("NotFound");
    expect(await rolesOf(a.org.id)).toEqual({ [a.user.id]: "owner" });
  });

  it("is used once: opening their own link again changes nothing, and nobody else can use it afterwards", async () => {
    const { a, user, actor, token } = await invited("viewer");
    expect((await acceptInvitation(actor, token)).joined).toBe(true);
    // Promoted since. The used link is not a way back to the role it once carried.
    await submitChangeMemberRole(a.actor, a.org.slug, form({ memberId: (await resolveOrgContext(actor, a.org.slug)).membership.id, role: "admin" }));

    expect(await acceptInvitation(actor, token)).toEqual({ organization: { slug: a.org.slug, name: a.org.name }, joined: false });
    expect((await rolesOf(a.org.id))[user.id]).toBe("admin");
    expect(await withTenant({ orgId: a.org.id }, (tx) => tx.select().from(t.organizationMembers).where(eq(t.organizationMembers.userId, user.id)))).toHaveLength(1);

    // Removed from the organization: the old link does not let them back in.
    await submitRemoveMember(a.actor, a.org.slug, form({ memberId: (await resolveOrgContext(actor, a.org.slug)).membership.id }));
    expect((await refusalOf(() => acceptInvitation(actor, token))).kind).toBe("NotFound");
    expect(await rolesOf(a.org.id)).toEqual({ [a.user.id]: "owner" });
  });

  it("holds under concurrency: one link submitted many times at once makes one membership", async () => {
    const { a, user, actor, token } = await invited();
    const results = await Promise.all(Array.from({ length: 6 }, () => acceptInvitation(actor, token)));
    expect(results.filter((r) => r.joined)).toHaveLength(1);
    expect(await withTenant({ orgId: a.org.id }, (tx) => tx.select().from(t.organizationMembers).where(eq(t.organizationMembers.userId, user.id)))).toHaveLength(1);
    expect(await rolesOf(a.org.id)).toEqual({ [a.user.id]: "owner", [user.id]: "editor" });
  });

  it("holds under concurrency: accepted or revoked, never both", async () => {
    for (let round = 0; round < 4; round++) {
      const { a, user, actor, invitation, token } = await invited();
      const [accepted, revoked] = await Promise.allSettled([acceptInvitation(actor, token), revokeInvitation(a.ctx, { invitationId: invitation.id })]);
      const row = await invitationRow(a.org.id, invitation.id);
      const isMember = user.id in (await rolesOf(a.org.id));
      expect([accepted.status, revoked.status].sort()).toEqual(["fulfilled", "rejected"]);
      if (accepted.status === "fulfilled") {
        expect({ isMember, accepted: row.acceptedAt !== null, revoked: row.revokedAt !== null }).toEqual({ isMember: true, accepted: true, revoked: false });
      } else {
        expect({ isMember, accepted: row.acceptedAt !== null, revoked: row.revokedAt !== null }).toEqual({ isMember: false, accepted: false, revoked: true });
      }
    }
  });

  it("someone who became a member some other way keeps their role: the invitation is used up and changes nothing", async () => {
    const { a, user, actor, invitation, token } = await invited("viewer");
    await addUser(a.org, user, "editor"); // joined meanwhile, as an Editor
    expect(await acceptInvitation(actor, token)).toMatchObject({ joined: false });
    expect((await rolesOf(a.org.id))[user.id]).toBe("editor");
    expect((await invitationRow(a.org.id, invitation.id)).acceptedAt).toBeInstanceOf(Date);
  });

  it("a row that names a role no invitation may carry gives nothing, even with a valid link", async () => {
    const a = await newTenant();
    const user = await createUser({ email: address() });
    const token = "T".repeat(43);
    const id = uuidv7();
    // Written straight into the table: the service would never make it.
    await withTenant({ orgId: a.org.id }, async (tx) =>
      tx.insert(t.organizationInvitations).values({
        id, organizationId: a.org.id, email: user.email, roleId: await roleId(tx, "owner"), tokenHash: sha256(`${token}${id}`), invitedBy: a.user.id, expiresAt: new Date(Date.now() + DAY),
      }),
    );
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.organizationInvitations).set({ tokenHash: sha256(token) }).where(eq(t.organizationInvitations.id, id)));
    try {
      expect(await previewInvitation(token)).toEqual({ status: "invalid" });
      expect((await refusalOf(() => acceptInvitation(actorOf(user), token))).kind).toBe("NotFound");
      expect(await rolesOf(a.org.id)).toEqual({ [a.user.id]: "owner" });
    } finally {
      await withTenant({ orgId: a.org.id }, (tx) => tx.delete(t.organizationInvitations).where(eq(t.organizationInvitations.id, id)));
    }
  });

  it("an organization that is suspended or gone cannot be joined", async () => {
    const suspended = await invited();
    await withTenant({ orgId: suspended.a.org.id }, (tx) => tx.update(t.organizations).set({ status: "suspended" }).where(eq(t.organizations.id, suspended.a.org.id)));
    expect((await refusalOf(() => acceptInvitation(suspended.actor, suspended.token))).kind).toBe("NotFound");
    expect(suspended.user.id in (await rolesOf(suspended.a.org.id))).toBe(false);
  });

  it("an invitation is for its own organization only", async () => {
    const [a, b] = [await newTenant("Alpha"), await newTenant("Beta")];
    const user = await createUser({ email: address() });
    const inB = await inviteMember(b.ctx, { email: user.email, role: "viewer" });
    const accepted = await acceptInvitation(actorOf(user), await tokenOf(inB.id));
    expect(accepted.organization.slug).toBe(b.org.slug);
    expect(await rolesOf(b.org.id)).toEqual({ [b.user.id]: "owner", [user.id]: "viewer" });
    expect(await rolesOf(a.org.id)).toEqual({ [a.user.id]: "owner" });
    await expect(resolveOrgContext(actorOf(user), a.org.slug)).rejects.toMatchObject({ kind: "NotFound" });
  });
});

describe("the members page's forms", () => {
  it("invite: says who it went to, clears the address, and asks for the email job to be started", async () => {
    const a = await newTenant();
    const email = address();
    const outcome = await submitInviteMember(a.actor, a.org.slug, form({ email: ` ${email.toUpperCase()}`, role: "editor" }));
    expect(outcome).toEqual({
      state: { status: "success", message: `Invitation sent to ${email}.`, values: { email: "", role: "editor" } },
      revalidate: pages(a.org.slug),
      emailQueued: true,
    });
    const [invitation] = await listInvitations(a.ctx);
    expect(JSON.stringify(outcome)).not.toContain(await tokenOf(invitation!.id));

    // What is wrong goes to its field, with what was typed kept.
    const repeat = await submitInviteMember(a.actor, a.org.slug, form({ email, role: "viewer" }));
    expectRefused(repeat, "Validation");
    expect(repeat.state).toMatchObject({ fieldErrors: { email: [expect.stringContaining("already an invitation")] }, values: { email, role: "viewer" } });
    expectRefused(await submitInviteMember(a.actor, a.org.slug, form({ email: address(), role: "owner" })), "Validation");
    expectRefused(await submitInviteMember(a.actor, a.org.slug, new FormData()), "Validation");

    // Extra fields a form does not have are not read: the organization is the URL's, the inviter the session's.
    const b = await newTenant();
    const smuggled = form({ email: address(), role: "viewer", organizationId: b.org.id, orgSlug: b.org.slug, invitedBy: b.user.id, tokenHash: "x".repeat(64), expiresAt: "2099-01-01" });
    expect((await submitInviteMember(a.actor, a.org.slug, smuggled)).state.status).toBe("success");
    expect(await invitationRows(b.org.id)).toEqual([]);
    const newest = (await listInvitations(a.ctx))[0]!;
    expect((await invitationRow(a.org.id, newest.id)).invitedBy).toBe(a.user.id);
    expect((newest.expiresAt.getTime() - Date.now()) / DAY).toBeLessThan(7.001);
  });

  it("re-send and revoke: named by the invitation's id, inside the organization the URL names", async () => {
    const { a, invitation } = await invited();
    expectRefused(await submitResendInvitation(a.actor, a.org.slug, form({ invitationId: invitation.id })), "RateLimited", "This invitation was sent a moment ago. Wait a minute before sending it again.");
    await sentMinutesAgo(a.org.id, invitation.id, 5);
    expect(await submitResendInvitation(a.actor, a.org.slug, form({ invitationId: invitation.id }))).toMatchObject({
      state: { status: "success", message: `Invitation sent again to ${invitation.email}.` }, emailQueued: true,
    });
    expect(await submitRevokeInvitation(a.actor, a.org.slug, form({ invitationId: invitation.id }))).toMatchObject({
      state: { status: "success", message: "The invitation has been revoked." },
    });
    const gone = "That invitation is no longer open. Reload the page to see the current list.";
    expectRefused(await submitRevokeInvitation(a.actor, a.org.slug, form({ invitationId: invitation.id })), "NotFound", gone);
    expectRefused(await submitResendInvitation(a.actor, a.org.slug, form({ invitationId: "" })), "NotFound", gone);
  });

  it("change role: to one of the assignable roles; ownership is not a role this form gives", async () => {
    const a = await newTenant();
    const admin = await addMember(a.org, "admin");
    const target = await addMember(a.org, "viewer");
    for (const role of ["author", "editor", "admin", "viewer"] as const) {
      const outcome = await submitChangeMemberRole(admin.actor, a.org.slug, form({ memberId: target.memberId, role }));
      expect(outcome.state).toEqual({ status: "success", message: "The role has been changed." });
      expect((await rolesOf(a.org.id))[target.user.id]).toBe(role);
    }
    // Not to Owner: not by an Admin, and not by the Owner either. That is the transfer in the settings.
    for (const actor of [admin.actor, a.actor]) {
      const outcome = await submitChangeMemberRole(actor, a.org.slug, form({ memberId: target.memberId, role: "owner" }));
      expectRefused(outcome, "Validation");
      expect(outcome.state.fieldErrors).toEqual({ role: ["Choose a role."] });
    }
    expectRefused(await submitChangeMemberRole(a.actor, a.org.slug, form({ memberId: target.memberId, role: "superuser" })), "Validation");
    // An Admin cannot change the Owner; the Owner cannot be demoted while they are the only one.
    expectRefused(await submitChangeMemberRole(admin.actor, a.org.slug, form({ memberId: a.ctx.membership.id, role: "viewer" })), "Forbidden", FORBIDDEN);
    expectRefused(await submitChangeMemberRole(a.actor, a.org.slug, form({ memberId: a.ctx.membership.id, role: "admin" })), "Conflict");
    expect(await rolesOf(a.org.id)).toEqual({ [a.user.id]: "owner", [admin.user.id]: "admin", [target.user.id]: "viewer" });
  });

  it("remove and leave: the member is gone from the next request; the only Owner stays", async () => {
    const a = await newTenant();
    const admin = await addMember(a.org, "admin");
    const [one, two] = [await addMember(a.org, "editor"), await addMember(a.org, "author")];

    expect((await submitRemoveMember(admin.actor, a.org.slug, form({ memberId: one.memberId }))).state).toEqual({
      status: "success", message: "They have been removed from the organization.",
    });
    await expect(resolveOrgContext(one.actor, a.org.slug)).rejects.toMatchObject({ kind: "NotFound" });
    expectRefused(await submitRemoveMember(admin.actor, a.org.slug, form({ memberId: one.memberId })), "NotFound", "That person is not a member of this organization. Reload the page to see the current list.");

    // Leaving: a member takes themselves out, and goes on to wherever they belong next. Here, nowhere yet: onboarding.
    expect(await submitLeaveOrganization(two.actor, a.org.slug, new FormData())).toEqual({
      state: { status: "success" }, redirectTo: "/onboarding", revalidate: pages(a.org.slug),
    });
    await expect(resolveOrgContext(two.actor, a.org.slug)).rejects.toMatchObject({ kind: "NotFound" });
    expectRefused(await submitLeaveOrganization(two.actor, a.org.slug, new FormData()), "NotFound", "Not found.");

    // Naming oneself in the remove form is leaving, too. Someone with another organization goes on to that one.
    const elsewhere = await newTenant("Elsewhere");
    await addUser(elsewhere.org, admin.user, "viewer");
    expect((await submitRemoveMember(admin.actor, a.org.slug, form({ memberId: admin.memberId }))).redirectTo).toBe(`/${elsewhere.org.slug}`);

    // The only Owner: cannot leave, cannot be removed, and is told what to do instead.
    const lastOwner = "You are the only Owner of this organization. Transfer ownership to another member first.";
    expectRefused(await submitLeaveOrganization(a.actor, a.org.slug, new FormData()), "Conflict", lastOwner);
    expectRefused(await submitRemoveMember(a.actor, a.org.slug, form({ memberId: a.ctx.membership.id })), "Conflict", lastOwner);
    expect(await rolesOf(a.org.id)).toEqual({ [a.user.id]: "owner" });
  });

  it("members who may not manage are refused before anything they sent is looked at", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const target = await addMember(a.org, "viewer");
    const { invitation } = await invited();
    for (const role of ["editor", "author", "viewer"] as const) {
      const member = await addMember(a.org, role);
      const attempts = [
        submitInviteMember(member.actor, a.org.slug, form({ email: address(), role: "viewer" })),
        submitInviteMember(member.actor, a.org.slug, form({ email: "nonsense", role: "owner" })),
        submitResendInvitation(member.actor, a.org.slug, form({ invitationId: invitation.id })),
        submitRevokeInvitation(member.actor, a.org.slug, form({ invitationId: "not-a-uuid" })),
        submitChangeMemberRole(member.actor, a.org.slug, form({ memberId: target.memberId, role: "admin" })),
        submitChangeMemberRole(member.actor, a.org.slug, form({ memberId: member.memberId, role: "owner" })),
        submitChangeMemberRole(member.actor, a.org.slug, form({ memberId: b.ctx.membership.id, role: "nonsense" })),
        submitRemoveMember(member.actor, a.org.slug, form({ memberId: target.memberId })),
        submitRemoveMember(member.actor, a.org.slug, form({ memberId: b.ctx.membership.id })),
      ];
      const answers = new Set((await Promise.all(attempts)).map((o) => `${o.refused}: ${o.state.message} ${JSON.stringify(o.state.fieldErrors ?? null)}`));
      expect([...answers], role).toEqual([`Forbidden: ${FORBIDDEN} null`]);
    }
    expect(await rolesOf(a.org.id)).toMatchObject({ [a.user.id]: "owner", [target.user.id]: "viewer" });
    expect(await invitationRows(a.org.id)).toEqual([]);
  });

  it("accept: on to the organization; not signed in, to the login page and back to the invitation", async () => {
    const { a, actor, token } = await invited();
    const anonymous = await submitAcceptInvitation({ kind: "anonymous" }, token);
    expect(anonymous.refused).toBe("Unauthenticated");
    expect(anonymous.redirectTo).toBe(`/login?next=${encodeURIComponent(`/invite/${token}`)}&reason=session`);
    // Something that is not a token is never put into a URL.
    for (const junk of ["//evil.example", "https://evil.example", "../../login", "x".repeat(500)]) {
      expect((await submitAcceptInvitation({ kind: "anonymous" }, junk)).redirectTo, junk).toBe("/login?reason=session");
    }

    const stranger = actorOf(await createUser({ email: address("stranger") }));
    expectRefused(await submitAcceptInvitation(stranger, token), "Forbidden", "This invitation was sent to a different email address. Log in with that address to accept it.");
    expectRefused(await submitAcceptInvitation(actor, "a".repeat(43)), "NotFound", "This invitation is no longer valid. Ask the person who invited you to send a new one.");

    expect(await submitAcceptInvitation(actor, token)).toEqual({
      state: { status: "success" }, redirectTo: `/${a.org.slug}`, revalidate: pages(a.org.slug),
    });
  });

  it("invite → accept → transfer: an Owner hands the organization to someone who joined by invitation", async () => {
    const { a, user, actor, token } = await invited("editor");
    await acceptInvitation(actor, token);
    const joined = await resolveOrgContext(actor, a.org.slug);

    const outcome = await submitTransferOwnership(a.actor, a.org.slug, form({ memberId: joined.membership.id, confirm: a.org.slug }));
    expect(outcome.redirectTo).toBe(`/${a.org.slug}/settings?changed=owner`);
    expect(await rolesOf(a.org.id)).toEqual({ [a.user.id]: "admin", [user.id]: "owner" });
    // The new Owner manages the former one, who is now an Admin like any other.
    expect((await submitChangeMemberRole(actor, a.org.slug, form({ memberId: a.ctx.membership.id, role: "viewer" }))).state.status).toBe("success");
    expectRefused(await submitInviteMember(a.actor, a.org.slug, form({ email: address(), role: "viewer" })), "Forbidden", FORBIDDEN);
  });
});

describe("members changed by two people at once", () => {
  const outcomeOf = (result: PromiseSettledResult<FormOutcome>) => (result.status === "fulfilled" ? (result.value.refused ?? "ok") : "threw");

  it("two Admins on one member: both changes are applied one after the other, never half of each", async () => {
    for (let round = 0; round < 3; round++) {
      const a = await newTenant();
      const [one, two] = [await addMember(a.org, "admin"), await addMember(a.org, "admin")];
      const target = await addMember(a.org, "viewer");
      const results = await Promise.allSettled([
        submitChangeMemberRole(one.actor, a.org.slug, form({ memberId: target.memberId, role: "editor" })),
        submitChangeMemberRole(two.actor, a.org.slug, form({ memberId: target.memberId, role: "author" })),
      ]);
      expect(results.map(outcomeOf)).toEqual(["ok", "ok"]);
      expect(["editor", "author"]).toContain((await rolesOf(a.org.id))[target.user.id]);
    }
  });

  it("one Admin removes a member while another changes their role: the member is gone, and the late change finds nobody", async () => {
    for (let round = 0; round < 3; round++) {
      const a = await newTenant();
      const [one, two] = [await addMember(a.org, "admin"), await addMember(a.org, "admin")];
      const target = await addMember(a.org, "viewer");
      const [removed, changed] = await Promise.allSettled([
        submitRemoveMember(one.actor, a.org.slug, form({ memberId: target.memberId })),
        submitChangeMemberRole(two.actor, a.org.slug, form({ memberId: target.memberId, role: "editor" })),
      ]);
      expect(outcomeOf(removed)).toBe("ok");
      expect(["ok", "NotFound"]).toContain(outcomeOf(changed));
      expect(target.user.id in (await rolesOf(a.org.id))).toBe(false);
    }
  });

  it("an Admin demoted while they act: what they did before the demotion stands, and nothing after it", async () => {
    for (let round = 0; round < 4; round++) {
      const a = await newTenant();
      const admin = await addMember(a.org, "admin");
      const target = await addMember(a.org, "viewer");
      const email = address();
      const [demoted, removal, invitation] = await Promise.allSettled([
        submitChangeMemberRole(a.actor, a.org.slug, form({ memberId: admin.memberId, role: "viewer" })),
        submitRemoveMember(admin.actor, a.org.slug, form({ memberId: target.memberId })),
        submitInviteMember(admin.actor, a.org.slug, form({ email, role: "admin" })),
      ]);
      expect(outcomeOf(demoted)).toBe("ok");
      const roles = await rolesOf(a.org.id);
      expect(roles[admin.user.id]).toBe("viewer");
      // Each of the Admin's two actions either happened, whole, or was refused: the database agrees with the answer.
      expect(["ok", "Forbidden"]).toContain(outcomeOf(removal));
      expect(target.user.id in roles).toBe(outcomeOf(removal) !== "ok");
      expect(["ok", "Forbidden"]).toContain(outcomeOf(invitation));
      expect((await invitationRows(a.org.id)).some((row) => row.email === email)).toBe(outcomeOf(invitation) === "ok");
      // And whatever the order, the Owner is untouched.
      expect(roles[a.user.id]).toBe("owner");
    }
  });

  it("two Admins cannot, between them, remove or demote the Owner", async () => {
    const a = await newTenant();
    const [one, two] = [await addMember(a.org, "admin"), await addMember(a.org, "admin")];
    const results = await Promise.allSettled([
      submitRemoveMember(one.actor, a.org.slug, form({ memberId: a.ctx.membership.id })),
      submitChangeMemberRole(two.actor, a.org.slug, form({ memberId: a.ctx.membership.id, role: "viewer" })),
      submitRemoveMember(two.actor, a.org.slug, form({ memberId: a.ctx.membership.id })),
      submitChangeMemberRole(one.actor, a.org.slug, form({ memberId: a.ctx.membership.id, role: "admin" })),
    ]);
    expect(results.map(outcomeOf)).toEqual(["Forbidden", "Forbidden", "Forbidden", "Forbidden"]);
    expect((await rolesOf(a.org.id))[a.user.id]).toBe("owner");
  });
});

describe("where a member's forms may send the browser", () => {
  it("only to `/`, the organization, or the login page with a way back that is a path of this app", async () => {
    const hostile = ["//evil.example", "https://evil.example", "/\\evil.example", "javascript:alert(1)", "s/some-site"];
    for (const orgSlug of ["acme-studio", ...hostile]) {
      for (const submit of [submitInviteMember, submitResendInvitation, submitRevokeInvitation, submitChangeMemberRole, submitRemoveMember, submitLeaveOrganization]) {
        const outcome = await submit({ kind: "anonymous" }, orgSlug, form({ email: address(), role: "viewer", memberId: uuidv7(), invitationId: uuidv7() }));
        expect(outcome.refused).toBe("Unauthenticated");
        const destination = new URL(outcome.redirectTo!, "https://forge.test");
        expect(destination.origin, orgSlug).toBe("https://forge.test");
        expect(destination.pathname).toBe("/login");
        const back = destination.searchParams.get("next");
        if (orgSlug === "acme-studio") expect(back).toBe("/acme-studio/members");
        else if (back !== null) expect(back.startsWith("/") && !back.startsWith("//")).toBe(true);
      }
    }
  });
});
