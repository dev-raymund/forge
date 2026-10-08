import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import type { Actor } from "@/modules/auth/shared";
import { TRIAL_DAYS } from "@/modules/billing";
import {
  canTransferOwnership, canUpdateOrganization, canViewOrganizationSettings, homeOrganization, homePath, listOrganizations, resolveOrgContext,
  submitChangeOrganizationSlug, submitCreateOrganization, submitRenameOrganization, submitTransferOwnership, type FormOutcome, type RoleKey,
} from "@/modules/tenancy";
import { ROLE_KEYS } from "@/modules/tenancy/shared";
import * as t from "@/platform/db/schema";
import { withTenant } from "@/platform/db/tenant";
import { safeNextPath } from "@/platform/routing/admin-access";
import { createUser } from "../fixtures/factories";
import { actorOf, addMember, addUser, newSlug, newTenant } from "../fixtures/tenants";

/**
 * M3-3: what the organization forms do when submitted, against real Postgres
 * (as forge_app through PgBouncer). These are the functions the Server Actions
 * call with the session's user and the slug from the page's URL
 * (modules/tenancy/organization-forms.ts); the actions add only the redirect
 * and the cache invalidation. The screens themselves are driven in
 * tests/e2e/organizations.spec.ts.
 */

const ANONYMOUS: Actor = { kind: "anonymous" };
const FORBIDDEN = "You don't have permission to do that.";
const NOT_FOUND = "Not found.";

/** The admin URLs of an organization that show its name, its URL or its people: what a change makes stale. */
const pages = (slug: string) => [`/${slug}/sites`, `/${slug}/settings`, `/${slug}/members`, `/${slug}/activity`];

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

const orgRow = async (orgId: string) => (await withTenant({ orgId }, (tx) => tx.select().from(t.organizations).where(eq(t.organizations.id, orgId))))[0]!;
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
const subscriptionOf = async (orgId: string) => (await withTenant({ orgId }, (tx) => tx.select().from(t.subscriptions)))[0];
const setStatus = (orgId: string, status: "active" | "suspended") =>
  withTenant({ orgId }, (tx) => tx.update(t.organizations).set({ status }).where(eq(t.organizations.id, orgId)));

/** A refusal: nothing to go to, nothing to invalidate. */
function expectRefused(outcome: FormOutcome, kind: string, message?: string) {
  expect(outcome.refused).toBe(kind);
  expect(outcome.state.status).toBe("error");
  if (message !== undefined) expect(outcome.state.message).toBe(message);
  expect(outcome.revalidate).toBeUndefined();
}

describe("onboarding: creating the first organization", () => {
  it("creates the organization, makes the caller its Owner, starts the trial, and goes to its home", async () => {
    const user = await createUser();
    const actor = actorOf(user);
    expect(await homeOrganization(actor)).toBeNull();
    expect(homePath(await homeOrganization(actor))).toBe("/onboarding");

    const slug = newSlug("first");
    const before = Date.now();
    const outcome = await submitCreateOrganization(actor, form({ name: "  First Org ", slug: ` ${slug.toUpperCase()} ` }));

    expect(outcome).toEqual({ state: { status: "success" }, redirectTo: `/${slug}/sites`, revalidate: pages(slug) });
    const [organization] = await listOrganizations(actor);
    expect(organization).toEqual({ id: expect.any(String), slug, name: "First Org", status: "active", role: "owner" });
    expect(await rolesOf(organization!.id)).toEqual({ [user.id]: "owner" });
    expect(await orgRow(organization!.id)).toMatchObject({ createdBy: user.id, deletedAt: null });

    const subscription = (await subscriptionOf(organization!.id))!;
    expect(subscription).toMatchObject({ organizationId: organization!.id, planKey: "pro", status: "trialing" });
    const days = (subscription.trialEndsAt!.getTime() - before) / (24 * 3600 * 1000);
    expect(days).toBeGreaterThan(TRIAL_DAYS - 0.01);
    expect(days).toBeLessThan(TRIAL_DAYS + 0.01);

    // From now on `/` is that organization's sites (M4-1), and its context is an Owner's.
    expect(homePath(await homeOrganization(actor))).toBe(`/${slug}/sites`);
    expect((await resolveOrgContext(actor, slug)).membership.role).toBe("owner");
  });

  it("says what is wrong with the name or the URL, keeps what was typed, and creates nothing", async () => {
    const user = await createUser();
    const actor = actorOf(user);
    const taken = await newTenant();
    const cases: [Record<string, string>, string, string][] = [
      [{ name: "Acme", slug: "login" }, "slug", "That URL is reserved. Choose another."],
      [{ name: "Acme", slug: "settings" }, "slug", "That URL is reserved. Choose another."],
      [{ name: "Acme", slug: "Acme Studio" }, "slug", "Use lowercase letters, numbers and single hyphens, e.g. acme-studio."],
      [{ name: "Acme", slug: "ab" }, "slug", "Use at least 3 characters."],
      [{ name: "Acme", slug: "" }, "slug", "Enter a URL for the organization."],
      [{ name: "Acme", slug: "../acme" }, "slug", "Use lowercase letters, numbers and single hyphens, e.g. acme-studio."],
      [{ name: "   ", slug: newSlug() }, "name", "Enter a name for the organization."],
      [{ name: "x".repeat(81), slug: newSlug() }, "name", "Use at most 80 characters."],
      [{ name: "Acme", slug: taken.org.slug }, "slug", "That URL is already taken."],
      [{ name: "Acme", slug: taken.org.slug.toUpperCase() }, "slug", "That URL is already taken."],
    ];
    for (const [fields, field, message] of cases) {
      const outcome = await submitCreateOrganization(actor, form(fields));
      expectRefused(outcome, "Validation");
      expect(outcome.state.fieldErrors, JSON.stringify(fields)).toEqual({ [field]: [message] });
      expect(outcome.state.values).toEqual(fields);
      expect(outcome.redirectTo).toBeUndefined();
    }
    // Missing fields are empty fields, not a crash.
    expect((await submitCreateOrganization(actor, new FormData())).state.fieldErrors).toMatchObject({ name: expect.any(Array), slug: expect.any(Array) });
    expect(await listOrganizations(actor)).toEqual([]);
    expect(await homeOrganization(actor)).toBeNull();
    expect((await orgRow(taken.org.id)).name).toBe(taken.org.name);
  });

  it("takes who the Owner is from the session and nothing from the form: no id, owner, role, status or plan can be sent along", async () => {
    const user = await createUser();
    const someoneElse = await createUser();
    const victim = await newTenant();
    const slug = newSlug("claims");
    const outcome = await submitCreateOrganization(
      actorOf(user),
      form({
        name: "Claims", slug, id: victim.org.id, organizationId: victim.org.id, ownerId: someoneElse.id, userId: someoneElse.id, createdBy: someoneElse.id,
        role: "viewer", status: "suspended", planKey: "free", permissions: "org.manage",
      }),
    );
    expect(outcome.redirectTo).toBe(`/${slug}/sites`);
    const [organization] = await listOrganizations(actorOf(user));
    expect(organization).toMatchObject({ slug, status: "active", role: "owner" });
    expect(organization!.id).not.toBe(victim.org.id);
    expect(await rolesOf(organization!.id)).toEqual({ [user.id]: "owner" });
    expect(await orgRow(organization!.id)).toMatchObject({ createdBy: user.id });
    expect(await subscriptionOf(organization!.id)).toMatchObject({ planKey: "pro", status: "trialing" });
    expect(await listOrganizations(actorOf(someoneElse))).toEqual([]);
    expect(await orgRow(victim.org.id)).toMatchObject({ name: victim.org.name, slug: victim.org.slug });
  });

  it("without a session nothing is created, and the browser is sent to log in and come back", async () => {
    const slug = newSlug("anon");
    const outcome = await submitCreateOrganization(ANONYMOUS, form({ name: "Anonymous", slug }));
    expect(outcome.refused).toBe("Unauthenticated");
    expect(outcome.redirectTo).toBe("/login?next=%2Fonboarding&reason=session");
    // The slug is still free: nothing was written.
    const user = await createUser();
    expect((await submitCreateOrganization(actorOf(user), form({ name: "Real", slug }))).redirectTo).toBe(`/${slug}/sites`);
  });
});

describe("where `/` goes", () => {
  it("no organizations: onboarding. One: that one. Several: the one joined last", async () => {
    const user = await createUser();
    const actor = actorOf(user);
    expect(await homeOrganization(actor)).toBeNull();

    const [a, b, c] = [await newTenant("Alpha"), await newTenant("Beta"), await newTenant("Gamma")];
    await addUser(b.org, user, "viewer");
    expect(await homeOrganization(actor)).toEqual({ id: b.org.id, slug: b.org.slug, name: b.org.name, status: "active", role: "viewer" });

    await addUser(a.org, user, "editor"); // joined later, though the organization is older
    expect((await homeOrganization(actor))!.slug).toBe(a.org.slug);
    await addUser(c.org, user, "admin");
    expect((await homeOrganization(actor))!.slug).toBe(c.org.slug);
    // The same answer every time it is asked.
    for (let i = 0; i < 3; i++) expect((await homeOrganization(actor))!.slug).toBe(c.org.slug);
    // It is about this user's memberships only: the others' homes are their own.
    expect((await homeOrganization(a.actor))!.slug).toBe(a.org.slug);
    expect((await homeOrganization(b.actor))!.slug).toBe(b.org.slug);
  });

  it("prefers an organization that can be used; a deleted one is never the answer", async () => {
    const user = await createUser();
    const actor = actorOf(user);
    const [older, newer] = [await newTenant("Older"), await newTenant("Newer")];
    await addUser(older.org, user, "viewer");
    await addUser(newer.org, user, "owner");
    expect((await homeOrganization(actor))!.slug).toBe(newer.org.slug);

    await setStatus(newer.org.id, "suspended");
    expect((await homeOrganization(actor))!.slug).toBe(older.org.slug);
    // Every organization suspended: the last one anyway, whose page will say so.
    await setStatus(older.org.id, "suspended");
    expect(await homeOrganization(actor)).toMatchObject({ slug: newer.org.slug, status: "suspended" });

    await withTenant({ orgId: newer.org.id }, (tx) => tx.update(t.organizations).set({ deletedAt: new Date() }).where(eq(t.organizations.id, newer.org.id)));
    expect((await homeOrganization(actor))!.slug).toBe(older.org.slug);
    await withTenant({ orgId: older.org.id }, (tx) => tx.update(t.organizations).set({ deletedAt: new Date() }).where(eq(t.organizations.id, older.org.id)));
    expect(await homeOrganization(actor)).toBeNull();
    expect(homePath(null)).toBe("/onboarding");
  });

  it("needs a signed-in user, and someone removed is back to onboarding", async () => {
    const a = await newTenant();
    const member = await addMember(a.org, "editor");
    await expect(homeOrganization(ANONYMOUS)).rejects.toMatchObject({ kind: "Unauthenticated" });
    expect((await homeOrganization(member.actor))!.slug).toBe(a.org.slug);
    await withTenant({ orgId: a.org.id }, (tx) => tx.delete(t.organizationMembers).where(eq(t.organizationMembers.id, member.memberId)));
    expect(await homeOrganization(member.actor)).toBeNull();
  });
});

describe("the switcher's list", () => {
  it("is the caller's organizations and nobody else's", async () => {
    const [a, b, c] = [await newTenant("Alpha"), await newTenant("Beta"), await newTenant("Gamma")];
    const user = await createUser();
    await addUser(a.org, user, "admin");
    await addUser(b.org, user, "viewer");
    const listed = await listOrganizations(actorOf(user));
    expect(listed.map((o) => [o.slug, o.role])).toEqual([[a.org.slug, "admin"], [b.org.slug, "viewer"]]); // by name
    expect(JSON.stringify(listed)).not.toContain(c.org.id);
    expect(JSON.stringify(listed)).not.toContain(c.org.slug);
    expect((await listOrganizations(c.actor)).map((o) => o.id)).toEqual([c.org.id]);
  });
});

describe("who may open the settings, and who may change what", () => {
  const TABLE: Record<RoleKey, { open: boolean; update: boolean; transfer: boolean }> = {
    owner: { open: true, update: true, transfer: true },
    admin: { open: true, update: false, transfer: false },
    editor: { open: false, update: false, transfer: false },
    author: { open: false, update: false, transfer: false },
    viewer: { open: false, update: false, transfer: false },
  };

  it.each(ROLE_KEYS)("%s", async (role) => {
    const a = await newTenant();
    const member = await addMember(a.org, role);
    const target = await addMember(a.org, "editor");
    const expected = TABLE[role];

    // What the page shows…
    expect({ open: canViewOrganizationSettings(member.ctx), update: canUpdateOrganization(member.ctx), transfer: canTransferOwnership(member.ctx) }).toEqual(expected);

    // …and what the forms do, whatever was shown.
    const renamed = await submitRenameOrganization(member.actor, a.org.slug, form({ name: `By ${role}` }));
    const moved = await submitChangeOrganizationSlug(member.actor, a.org.slug, form({ slug: a.org.slug }));
    if (expected.update) {
      expect(renamed.state).toEqual({ status: "success", message: "The organization's name has been updated.", values: { name: `By ${role}` } });
      expect(moved.state.status).toBe("success");
    } else {
      expectRefused(renamed, "Forbidden", FORBIDDEN);
      expectRefused(moved, "Forbidden", FORBIDDEN);
    }
    expect((await orgRow(a.org.id)).name).toBe(expected.update ? `By ${role}` : a.org.name);

    const handed = await submitTransferOwnership(member.actor, a.org.slug, form({ memberId: target.memberId, confirm: a.org.slug }));
    if (expected.transfer) {
      expect(handed.redirectTo).toBe(`/${a.org.slug}/settings?changed=owner`);
      expect(await rolesOf(a.org.id)).toMatchObject({ [member.user.id]: "admin", [target.user.id]: "owner", [a.user.id]: "owner" });
    } else {
      expectRefused(handed, "Forbidden", FORBIDDEN);
      expect(await rolesOf(a.org.id)).toMatchObject({ [member.user.id]: role, [target.user.id]: "editor", [a.user.id]: "owner" });
    }
  });
});

describe("renaming an organization and changing its URL", () => {
  it("renames: trimmed, validated, and nothing else about the organization changes", async () => {
    const a = await newTenant();
    const outcome = await submitRenameOrganization(a.actor, a.org.slug, form({ name: "  New Name  " }));
    expect(outcome).toEqual({
      state: { status: "success", message: "The organization's name has been updated.", values: { name: "New Name" } },
      revalidate: pages(a.org.slug),
    });
    expect(await orgRow(a.org.id)).toMatchObject({ name: "New Name", slug: a.org.slug, status: "active" });

    for (const name of ["", "   ", "x".repeat(81)]) {
      const refused = await submitRenameOrganization(a.actor, a.org.slug, form({ name }));
      expectRefused(refused, "Validation");
      expect(Object.keys(refused.state.fieldErrors ?? {})).toEqual(["name"]);
    }
    expect((await orgRow(a.org.id)).name).toBe("New Name");
  });

  it("the name form changes the name only: a slug, an id or a status sent with it is not read", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const smuggled = form({ name: "Just The Name", slug: newSlug("smuggled"), id: b.org.id, organizationId: b.org.id, orgSlug: b.org.slug, status: "suspended", role: "owner" });
    expect((await submitRenameOrganization(a.actor, a.org.slug, smuggled)).state.status).toBe("success");
    expect(await orgRow(a.org.id)).toMatchObject({ name: "Just The Name", slug: a.org.slug, status: "active" });
    expect(await orgRow(b.org.id)).toMatchObject({ name: b.org.name, slug: b.org.slug, status: "active" });
  });

  it("changes the URL: one spelling, and the browser is sent to the new one", async () => {
    const a = await newTenant();
    const next = newSlug("moved");
    const outcome = await submitChangeOrganizationSlug(a.actor, a.org.slug, form({ slug: `  ${next.toUpperCase()} ` }));
    expect(outcome).toEqual({
      state: { status: "success" },
      redirectTo: `/${next}/settings?changed=url`,
      revalidate: [...pages(a.org.slug), ...pages(next)],
    });
    expect(await orgRow(a.org.id)).toMatchObject({ slug: next, name: a.org.name });
    // The new URL is the organization; the old one is nobody's.
    expect((await resolveOrgContext(a.actor, next)).org.id).toBe(a.org.id);
    await expect(resolveOrgContext(a.actor, a.org.slug)).rejects.toMatchObject({ kind: "NotFound" });
    expectRefused(await submitRenameOrganization(a.actor, a.org.slug, form({ name: "Through The Old URL" })), "NotFound", NOT_FOUND);
    expect((await homeOrganization(a.actor))!.slug).toBe(next);

    // Asking for the URL it already has is not a change, and goes nowhere.
    const same = await submitChangeOrganizationSlug(a.actor, next, form({ slug: next }));
    expect(same).toEqual({ state: { status: "success", message: "That is already this organization's URL.", values: { slug: next } } });
  });

  it("holds the URL to the slug rules, reserved words included, and to being free", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const cases: [string, string][] = [
      ["account", "That URL is reserved. Choose another."],
      ["onboarding", "That URL is reserved. Choose another."],
      ["api", "That URL is reserved. Choose another."],
      ["s", "Use at least 3 characters."],
      ["two words", "Use lowercase letters, numbers and single hyphens, e.g. acme-studio."],
      ["-leading", "Use lowercase letters, numbers and single hyphens, e.g. acme-studio."],
      ["", "Enter a URL for the organization."],
      [b.org.slug, "That URL is already taken."],
      [b.org.slug.toUpperCase(), "That URL is already taken."],
    ];
    for (const [slug, message] of cases) {
      const outcome = await submitChangeOrganizationSlug(a.actor, a.org.slug, form({ slug }));
      expectRefused(outcome, "Validation");
      expect(outcome.state.fieldErrors, slug).toEqual({ slug: [message] });
      expect(outcome.redirectTo).toBeUndefined();
    }
    expect((await orgRow(a.org.id)).slug).toBe(a.org.slug);
    expect((await orgRow(b.org.id)).slug).toBe(b.org.slug);
  });
});

describe("transferring ownership", () => {
  it("makes the chosen member an Owner and the caller an Admin, together, and only when confirmed", async () => {
    const a = await newTenant();
    const target = await addMember(a.org, "viewer");
    const bystander = await addMember(a.org, "editor");

    // No member, or the confirmation missing, wrong, or another organization's slug: nothing happens.
    const unconfirmed: [Record<string, string>, string][] = [
      [{ memberId: "", confirm: a.org.slug }, "memberId"],
      [{ confirm: a.org.slug }, "memberId"],
      [{ memberId: target.memberId }, "confirm"],
      [{ memberId: target.memberId, confirm: "" }, "confirm"],
      [{ memberId: target.memberId, confirm: "yes" }, "confirm"],
      [{ memberId: target.memberId, confirm: a.org.name }, "confirm"],
      [{ memberId: target.memberId, confirm: `${a.org.slug}x` }, "confirm"],
    ];
    for (const [fields, field] of unconfirmed) {
      const outcome = await submitTransferOwnership(a.actor, a.org.slug, form(fields));
      expectRefused(outcome, "Validation");
      expect(Object.keys(outcome.state.fieldErrors ?? {}), JSON.stringify(fields)).toEqual([field]);
      expect(outcome.redirectTo).toBeUndefined();
    }
    expect(await rolesOf(a.org.id)).toEqual({ [a.user.id]: "owner", [target.user.id]: "viewer", [bystander.user.id]: "editor" });

    const outcome = await submitTransferOwnership(a.actor, a.org.slug, form({ memberId: target.memberId, confirm: ` ${a.org.slug.toUpperCase()} ` }));
    expect(outcome).toEqual({
      state: { status: "success" },
      redirectTo: `/${a.org.slug}/settings?changed=owner`,
      revalidate: pages(a.org.slug),
    });
    expect(await rolesOf(a.org.id)).toEqual({ [a.user.id]: "admin", [target.user.id]: "owner", [bystander.user.id]: "editor" });

    // The former Owner is an Admin from this moment: every Owner-only form refuses them.
    const after = await resolveOrgContext(a.actor, a.org.slug);
    expect({ open: canViewOrganizationSettings(after), update: canUpdateOrganization(after), transfer: canTransferOwnership(after) }).toEqual({ open: true, update: false, transfer: false });
    expectRefused(await submitRenameOrganization(a.actor, a.org.slug, form({ name: "Still Mine" })), "Forbidden", FORBIDDEN);
    expectRefused(await submitChangeOrganizationSlug(a.actor, a.org.slug, form({ slug: newSlug() })), "Forbidden", FORBIDDEN);
    expectRefused(await submitTransferOwnership(a.actor, a.org.slug, form({ memberId: bystander.memberId, confirm: a.org.slug })), "Forbidden", FORBIDDEN);
    expect(await orgRow(a.org.id)).toMatchObject({ name: a.org.name, slug: a.org.slug });

    // And the new Owner is one: on their next request they can do all of it, including handing it back.
    expect((await submitRenameOrganization(target.actor, a.org.slug, form({ name: "Under New Ownership" }))).state.status).toBe("success");
    const back = await submitTransferOwnership(target.actor, a.org.slug, form({ memberId: after.membership.id, confirm: a.org.slug }));
    expect(back.redirectTo).toBe(`/${a.org.slug}/settings?changed=owner`);
    expect(await rolesOf(a.org.id)).toEqual({ [a.user.id]: "owner", [target.user.id]: "admin", [bystander.user.id]: "editor" });
  });

  it("only to a member of this organization: not to oneself, a stranger, a user id, or a member of another organization", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const colleague = await addMember(a.org, "admin");
    const stranger = await createUser();
    const confirm = a.org.slug;

    // To oneself: refused as not allowed.
    expectRefused(await submitTransferOwnership(a.actor, a.org.slug, form({ memberId: a.ctx.membership.id, confirm })), "Forbidden", FORBIDDEN);

    // Everything that is not a membership of THIS organization is the same "not a member", whatever it really is.
    const notMembers = [b.ctx.membership.id, stranger.id, colleague.user.id, b.org.id, a.org.id, uuidv7(), "not-a-uuid", "1; drop table organization_members"];
    const answers = new Set<string>();
    for (const memberId of notMembers) {
      const outcome = await submitTransferOwnership(a.actor, a.org.slug, form({ memberId, confirm }));
      expectRefused(outcome, "NotFound");
      expect(outcome.redirectTo).toBeUndefined();
      answers.add(outcome.state.message!);
    }
    expect([...answers]).toEqual(["That person is not a member of this organization. Reload the page and choose again."]);
    expect(await rolesOf(a.org.id)).toEqual({ [a.user.id]: "owner", [colleague.user.id]: "admin" });
    expect(await rolesOf(b.org.id)).toEqual({ [b.user.id]: "owner" });
  });

  it("someone who may not transfer is refused before anything they sent is looked at", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const target = await addMember(a.org, "viewer");
    for (const role of ["admin", "editor", "author", "viewer"] as const) {
      const member = await addMember(a.org, role);
      const attempts = [
        { memberId: target.memberId, confirm: a.org.slug },
        { memberId: member.memberId, confirm: a.org.slug }, // to themselves
        { memberId: b.ctx.membership.id, confirm: a.org.slug },
        { memberId: "", confirm: "" },
        { memberId: "not-a-uuid", confirm: "nonsense" },
      ];
      const answers = new Set<string>();
      for (const fields of attempts) {
        const outcome = await submitTransferOwnership(member.actor, a.org.slug, form(fields));
        answers.add(`${outcome.refused}: ${outcome.state.message} ${JSON.stringify(outcome.state.fieldErrors ?? null)}`);
      }
      expect([...answers], role).toEqual([`Forbidden: ${FORBIDDEN} null`]);
    }
    expect((await rolesOf(a.org.id))[a.user.id]).toBe("owner");
    expect((await rolesOf(a.org.id))[target.user.id]).toBe("viewer");
  });
});

describe("the slug in the URL names an organization; it does not grant one", () => {
  it("another organization's slug is NotFound for every form, exactly like a slug that does not exist, and that organization is untouched", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const victim = await addMember(b.org, "viewer");
    const missing = newSlug("nobody");

    const submissions = (orgSlug: string) => [
      submitRenameOrganization(a.actor, orgSlug, form({ name: "Hijacked" })),
      submitChangeOrganizationSlug(a.actor, orgSlug, form({ slug: newSlug("hijacked") })),
      submitTransferOwnership(a.actor, orgSlug, form({ memberId: victim.memberId, confirm: orgSlug })),
      submitTransferOwnership(a.actor, orgSlug, form({ memberId: a.ctx.membership.id, confirm: orgSlug })),
    ];
    const [aboutB, aboutNothing] = [await Promise.all(submissions(b.org.slug)), await Promise.all(submissions(missing))];
    for (const outcome of [...aboutB, ...aboutNothing]) {
      expectRefused(outcome, "NotFound", NOT_FOUND);
      expect(outcome.redirectTo).toBeUndefined();
    }
    expect(aboutB.map((o) => o.state.message)).toEqual(aboutNothing.map((o) => o.state.message));

    expect(await orgRow(b.org.id)).toMatchObject({ name: b.org.name, slug: b.org.slug });
    expect(await rolesOf(b.org.id)).toEqual({ [b.user.id]: "owner", [victim.user.id]: "viewer" });
    // And nothing of A's moved either: the slug sent did not fall back to "their own organization".
    expect(await orgRow(a.org.id)).toMatchObject({ name: a.org.name, slug: a.org.slug });
  });

  it("a user in two organizations acts in the one the URL names, with the role they hold there", async () => {
    const a = await newTenant("Alpha");
    const b = await newTenant("Beta");
    await addUser(b.org, a.user, "viewer"); // Owner of Alpha, Viewer of Beta
    expectRefused(await submitRenameOrganization(a.actor, b.org.slug, form({ name: "Alpha Took Over" })), "Forbidden", FORBIDDEN);
    expectRefused(await submitChangeOrganizationSlug(a.actor, b.org.slug, form({ slug: newSlug() })), "Forbidden", FORBIDDEN);
    expectRefused(await submitTransferOwnership(a.actor, b.org.slug, form({ memberId: b.ctx.membership.id, confirm: b.org.slug })), "Forbidden", FORBIDDEN);
    expect(await orgRow(b.org.id)).toMatchObject({ name: b.org.name, slug: b.org.slug });
    // The same forms, on their own organization's URL, work.
    expect((await submitRenameOrganization(a.actor, a.org.slug, form({ name: "Alpha Renamed" }))).state.status).toBe("success");
    expect((await orgRow(a.org.id)).name).toBe("Alpha Renamed");
  });

  it("things that are not slugs are NotFound without a query: other spellings, paths, ids, nothing at all", async () => {
    const a = await newTenant();
    const junk = [a.org.slug.toUpperCase(), ` ${a.org.slug}`, `${a.org.slug}/settings`, `../${a.org.slug}`, a.org.id, "", "%2e%2e", "x".repeat(200), undefined, null, 7, { slug: a.org.slug }, [a.org.slug]];
    for (const orgSlug of junk as unknown as string[]) {
      expectRefused(await submitRenameOrganization(a.actor, orgSlug, form({ name: "Junk" })), "NotFound", NOT_FOUND);
      expectRefused(await submitTransferOwnership(a.actor, orgSlug, form({ memberId: a.ctx.membership.id, confirm: String(orgSlug) })), "NotFound", NOT_FOUND);
    }
    expect((await orgRow(a.org.id)).name).toBe(a.org.name);
  });

  it("a suspended organization refuses every form, its Owner's included, and tells its members why", async () => {
    const a = await newTenant();
    const target = await addMember(a.org, "admin");
    const outsider = actorOf(await createUser());
    await setStatus(a.org.id, "suspended");

    const message = "This organization has been suspended.";
    expectRefused(await submitRenameOrganization(a.actor, a.org.slug, form({ name: "Thawed" })), "Forbidden", message);
    expectRefused(await submitChangeOrganizationSlug(a.actor, a.org.slug, form({ slug: newSlug() })), "Forbidden", message);
    expectRefused(await submitTransferOwnership(a.actor, a.org.slug, form({ memberId: target.memberId, confirm: a.org.slug })), "Forbidden", message);
    // Someone who is not a member still learns nothing, not even that.
    expectRefused(await submitRenameOrganization(outsider, a.org.slug, form({ name: "Thawed" })), "NotFound", NOT_FOUND);
    expect(await orgRow(a.org.id)).toMatchObject({ name: a.org.name, slug: a.org.slug, status: "suspended" });
    expect(await rolesOf(a.org.id)).toEqual({ [a.user.id]: "owner", [target.user.id]: "admin" });

    await setStatus(a.org.id, "active");
    expect((await submitRenameOrganization(a.actor, a.org.slug, form({ name: "Back" }))).state.status).toBe("success");
  });
});

describe("where a form may send the browser", () => {
  it("only to this app's own pages: the organization's sites, its settings, or the login page with a way back", async () => {
    const a = await newTenant();
    const target = await addMember(a.org, "viewer");
    const next = newSlug("safe");
    const destinations = [
      (await submitCreateOrganization(actorOf(await createUser()), form({ name: "Safe", slug: newSlug("created") }))).redirectTo,
      (await submitTransferOwnership(a.actor, a.org.slug, form({ memberId: target.memberId, confirm: a.org.slug }))).redirectTo,
      (await submitChangeOrganizationSlug(target.actor, a.org.slug, form({ slug: next }))).redirectTo,
    ];
    for (const destination of destinations) {
      expect(destination).toMatch(/^\/[a-z0-9-]+(\/sites|\/settings\?changed=(url|owner))$/);
      expect(safeNextPath(destination)).toBe(destination); // a path of this app, by the same rule the login redirect uses
    }
  });

  it("a session that ended sends the browser to log in, and a hostile slug cannot turn the way back into somewhere else", async () => {
    const hostile = ["//evil.example", "https://evil.example", "/\\evil.example", "evil.example/%2f..", "javascript:alert(1)", "s/some-site", "login", "\r\nLocation: https://evil.example"];
    for (const orgSlug of ["acme-studio", ...hostile]) {
      for (const submit of [submitRenameOrganization, submitChangeOrganizationSlug, submitTransferOwnership]) {
        const outcome = await submit(ANONYMOUS, orgSlug, form({ name: "x", slug: "xyz", memberId: uuidv7(), confirm: orgSlug }));
        expect(outcome.refused).toBe("Unauthenticated");
        const destination = new URL(outcome.redirectTo!, "https://forge.test");
        expect(destination.origin, orgSlug).toBe("https://forge.test");
        expect(destination.pathname).toBe("/login");
        expect(destination.searchParams.get("reason")).toBe("session");
        const back = destination.searchParams.get("next");
        // Either no way back at all, or a path the login page itself would accept.
        if (back !== null) expect(safeNextPath(back), orgSlug).toBe(back);
        if (orgSlug === "acme-studio") expect(back).toBe("/acme-studio/settings");
      }
    }
  });
});
