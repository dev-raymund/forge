import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `can()` and its guard, on contexts made the only way a context can be made:
 * by the resolver. The database behind the resolver is replaced, so what is
 * under test is the path membership → role → catalog → decision. The same
 * path on real Postgres is tests/integration/permissions.test.ts.
 */
const state = vi.hoisted(() => ({
  membership: null as null | { id: string; slug: string; name: string; status: string; role: string; membershipId: string },
  actor: { kind: "anonymous" } as { kind: "anonymous" } | { kind: "user"; userId: string; sessionId: string; emailVerified: boolean },
  headers: new Headers(),
  site: null as null | { id: string; organizationId: string; slug: string; name: string; status: string },
}));

vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("@/modules/auth", () => ({ getCurrentActor: async () => state.actor }));
vi.mock("@/modules/sites", () => ({ findSiteBySlug: async () => state.site }));
vi.mock("@/platform/db", () => ({
  withUser: (_userId: string, work: (tx: object) => unknown) => work({}),
  withTenant: (_context: object, work: (tx: object) => unknown) => work({}),
}));
vi.mock("@/platform/observability", () => ({ requestIdFrom: (h: Headers) => h.get("x-request-id") ?? "req-test" }));
vi.mock("./repository", () => ({ findMembershipBySlug: async () => state.membership }));

import { isAppError, problemResponse } from "@/platform/errors";
import { requireOrgContext, resolveOrgContext, resolveSiteWithin, type OrgContext } from "./context";
import { NO_PERMISSIONS, PERMISSIONS, permissionsForRole, type OwnedResource, type Permission } from "./permissions";
import {
  can, canActOn, canManageMembers, canReadActivity, canTransferOwnership, canUpdateOrganization, canViewOrganizationSettings, requirePermission,
} from "./policies";
import { ROLE_KEYS, type RoleKey } from "./schema";

const ORG = "0199a000-0000-7000-8000-00000000000a";
const OTHER_ORG = "0199a000-0000-7000-8000-00000000000b";
const ME = "0199a000-0000-7000-8000-0000000000a1";
const SOMEONE = "0199a000-0000-7000-8000-0000000000a2";
const actor = { kind: "user", userId: ME, sessionId: "s-1", emailVerified: true } as const;
const mine: OwnedResource = { organizationId: ORG, ownerId: ME };
const theirs: OwnedResource = { organizationId: ORG, ownerId: SOMEONE };

/** The context the resolver gives a member with this role. */
async function contextAs(role: string, status = "active"): Promise<OrgContext> {
  state.membership = { id: ORG, slug: "acme", name: "Acme", status, role, membershipId: "0199a000-0000-7000-8000-0000000000m1" };
  return resolveOrgContext(actor, "acme", { requestId: "req-1" });
}

async function failureOf(run: () => unknown) {
  try {
    await run();
  } catch (error) {
    return error as Error & { kind?: string };
  }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  state.membership = null;
  state.actor = { kind: "anonymous" };
  state.headers = new Headers();
  state.site = null;
});

describe("the context carries the member's permissions", () => {
  it.each(ROLE_KEYS)("%s: exactly the catalog's set for the role", async (role) => {
    const ctx = await contextAs(role);
    expect(ctx.membership.role).toBe(role);
    expect(ctx.permissions).toBe(permissionsForRole(role));
  });

  it("they come from the membership, and from nothing the caller passes along", async () => {
    state.membership = { id: ORG, slug: "acme", name: "Acme", status: "active", role: "viewer", membershipId: "m-1" };
    const loud = { requestId: "r", ip: "203.0.113.5", role: "owner", permissions: permissionsForRole("owner"), membership: { role: "owner" } };
    const ctx = await resolveOrgContext({ ...actor, role: "owner", permissions: ["org.manage"] } as typeof actor, "acme", loud);
    expect(ctx.permissions).toBe(permissionsForRole("viewer"));
    expect(ctx.membership.role).toBe("viewer");
    expect(Object.keys(ctx).sort()).toEqual(["actor", "ip", "membership", "org", "permissions", "requestId"]);
    expect(can(ctx, "org.manage")).toBe(false);
  });

  it("the current request: headers that claim a role, permissions or an organization change nothing", async () => {
    state.actor = actor;
    state.membership = { id: ORG, slug: "acme", name: "Acme", status: "active", role: "author", membershipId: "m-1" };
    state.headers = new Headers({
      "x-role": "owner", "x-permissions": PERMISSIONS.join(","), "x-forge-permissions": "org.manage", "x-organization-id": OTHER_ORG,
      "x-forge-org": OTHER_ORG, "x-user-id": SOMEONE, cookie: "role=owner; permissions=org.manage; org=other", "x-forwarded-for": "203.0.113.5",
    });
    const ctx = await requireOrgContext("acme");
    expect(ctx.permissions).toBe(permissionsForRole("author"));
    expect(ctx.org.id).toBe(ORG);
    expect(ctx.actor.userId).toBe(ME);
    expect(can(ctx, "org.manage")).toBe(false);
  });

  it("a site context is the same member with the same permissions", async () => {
    const ctx = await contextAs("editor");
    state.site = { id: "0199a000-0000-7000-8000-0000000000s1", organizationId: ORG, slug: "blog", name: "Blog", status: "active" };
    const site = await resolveSiteWithin(ctx, "blog");
    expect(site.permissions).toBe(ctx.permissions);
    expect(can(site, "entries.page.publish")).toBe(true);
    expect(can(site, "site.settings.manage")).toBe(false);
  });

  it("a role this code does not know holds nothing, even on a genuine context", async () => {
    const ctx = await contextAs("superuser");
    expect(ctx.permissions).toBe(NO_PERMISSIONS);
    for (const key of PERMISSIONS) expect(can(ctx, key, mine), key).toBe(false);
  });

  it("the context and what is in it cannot be edited afterwards", async () => {
    const ctx = await contextAs("viewer");
    const loose = ctx as unknown as { permissions: unknown; membership: { role: string } };
    expect(() => (loose.permissions = permissionsForRole("owner"))).toThrow(TypeError);
    expect(() => (loose.membership.role = "owner")).toThrow(TypeError);
    expect(() => ((ctx.permissions as { has: unknown }).has = () => true)).toThrow(TypeError);
    expect(can(ctx, "org.manage")).toBe(false);
  });
});

describe("nobody without a membership has a context to hold permissions in", () => {
  it("not signed in: Unauthenticated", async () => {
    state.membership = { id: ORG, slug: "acme", name: "Acme", status: "active", role: "owner", membershipId: "m-1" };
    expect((await failureOf(() => resolveOrgContext({ kind: "anonymous" }, "acme"))).kind).toBe("Unauthenticated");
    expect((await failureOf(() => requireOrgContext("acme"))).kind).toBe("Unauthenticated");
  });

  it("signed in, not a member: NotFound", async () => {
    state.membership = null;
    expect((await failureOf(() => resolveOrgContext(actor, "acme"))).kind).toBe("NotFound");
  });

  it("a suspended organization: Forbidden for every role, the Owner included", async () => {
    for (const role of ROLE_KEYS) expect((await failureOf(() => contextAs(role, "suspended"))).kind, role).toBe("Forbidden");
  });
});

describe("can()", () => {
  it.each(ROLE_KEYS)("%s: the catalog's answer for every key", async (role) => {
    const ctx = await contextAs(role);
    for (const key of PERMISSIONS) {
      const held = permissionsForRole(role).has(key);
      expect(can(ctx, key, mine), key).toBe(held);
      expect(can(ctx, key), `${key} without a resource`).toBe(key.endsWith(".own") ? false : held);
    }
  });

  it("`.own` is the member's own things only", async () => {
    const author = await contextAs("author");
    expect(can(author, "entries.post.update.own", mine)).toBe(true);
    expect(can(author, "entries.post.update.own", theirs)).toBe(false);
    expect(can(author, "entries.post.update.own")).toBe(false);
    expect(can(author, "entries.post.update.own", null)).toBe(false);
    expect(can(author, "entries.post.update.any", mine)).toBe(false);
    const editor = await contextAs("editor");
    expect(can(editor, "entries.post.update.any", theirs)).toBe(true);
    expect(can(editor, "entries.post.update.own", theirs)).toBe(false); // still not theirs; `.any` is what lets them
  });

  it("a resource of another organization is refused, for an Owner and for its own author", async () => {
    const owner = await contextAs("owner");
    const foreign: OwnedResource = { organizationId: OTHER_ORG, ownerId: ME };
    for (const key of PERMISSIONS) expect(can(owner, key, foreign), key).toBe(false);
  });

  it("an unknown permission is refused", async () => {
    const owner = await contextAs("owner");
    for (const key of ["platform.admin", "org", "entries.*.read", "*", "", null, undefined, 3, {}]) {
      expect(can(owner, key as Permission), String(key)).toBe(false);
    }
  });

  it("returns false, and never throws, for anything that is not a context the resolver returned", async () => {
    const real = await contextAs("viewer");
    const owner = permissionsForRole("owner");
    const notContexts = [
      undefined,
      null,
      "ctx",
      42,
      {},
      { permissions: owner },
      { requestId: "", actor, org: { id: ORG, slug: "acme", name: "Acme" }, membership: { id: "m", role: "owner" }, permissions: owner },
      { ...real }, // a copy of a real context
      { ...real, permissions: owner }, // … with the Owner's permissions put in
      { ...real, membership: { ...real.membership, role: "owner" } },
      JSON.parse(JSON.stringify(real)) as unknown,
      Object.create(real) as unknown, // a real context as the prototype
      { permissions: { has: () => true, list: [...PERMISSIONS] } },
    ] as unknown as OrgContext[];
    for (const fake of notContexts) {
      for (const key of PERMISSIONS) expect(can(fake, key, mine)).toBe(false);
      expect(canManageMembers(fake)).toBe(false);
      expect(canUpdateOrganization(fake)).toBe(false);
      expect(canTransferOwnership(fake)).toBe(false);
      expect(canViewOrganizationSettings(fake)).toBe(false);
      expect(canActOn(fake, "media.delete", mine)).toBe(false);
    }
  });
});

describe("requirePermission()", () => {
  it("returns when allowed and throws Forbidden (403) when not", async () => {
    for (const role of ROLE_KEYS) {
      const ctx = await contextAs(role);
      for (const key of PERMISSIONS) {
        if (can(ctx, key, mine)) {
          expect(requirePermission(ctx, key, mine)).toBeUndefined();
        } else {
          const error = await failureOf(() => requirePermission(ctx, key, mine));
          expect(isAppError(error), `${role}: ${key}`).toBe(true);
          expect(error.kind).toBe("Forbidden");
          expect(problemResponse(error, "req-1").status).toBe(403);
        }
      }
    }
  });

  it("says nothing about what was asked for: one message whatever the key", async () => {
    const viewer = await contextAs("viewer");
    const messages = new Set<string>();
    for (const key of ["org.manage", "sites.delete", "media.upload", "nonsense"] as Permission[]) messages.add((await failureOf(() => requirePermission(viewer, key))).message);
    expect(messages.size).toBe(1);
    expect([...messages][0]).toBe("You don't have permission to do that.");
  });

  it("refuses an unknown permission and an `.own` key without its resource, for an Owner too", async () => {
    const owner = await contextAs("owner");
    expect((await failureOf(() => requirePermission(owner, "platform.admin" as Permission))).kind).toBe("Forbidden");
    expect((await failureOf(() => requirePermission(owner, "media.delete.own"))).kind).toBe("Forbidden");
    expect((await failureOf(() => requirePermission(owner, "media.delete.own", theirs))).kind).toBe("Forbidden");
  });

  it("without a genuine context nothing is allowed: it stops as a fault, not as a decision", async () => {
    const real = await contextAs("owner");
    for (const fake of [undefined, null, {}, { ...real }, { ...real, permissions: permissionsForRole("owner") }] as unknown as OrgContext[]) {
      const error = await failureOf(() => requirePermission(fake, "entries.page.read"));
      expect(error.message).toMatch(/must come from resolveOrgContext/);
    }
  });
});

describe("policies", () => {
  const allowed = async (policy: (ctx: OrgContext) => boolean) => {
    const roles: RoleKey[] = [];
    for (const role of ROLE_KEYS) if (policy(await contextAs(role))) roles.push(role);
    return roles;
  };

  it("the organization is the Owner's to rename and to hand over; members are an Owner's or an Admin's to manage", async () => {
    expect(await allowed(canUpdateOrganization)).toEqual(["owner"]);
    expect(await allowed(canTransferOwnership)).toEqual(["owner"]);
    expect(await allowed(canManageMembers)).toEqual(["owner", "admin"]);
  });

  it("organization settings: Owners and Admins may open them; changing anything there is still each form's own permission", async () => {
    expect(await allowed(canViewOrganizationSettings)).toEqual(["owner", "admin"]);
    // Opening the page is not a permission to change it: an Admin gets in and may change nothing.
    const admin = await contextAs("admin");
    expect({ open: canViewOrganizationSettings(admin), update: canUpdateOrganization(admin), transfer: canTransferOwnership(admin) }).toEqual({ open: true, update: false, transfer: false });
    // Whoever may change the organization may also open the page to do it.
    for (const role of ROLE_KEYS) {
      const ctx = await contextAs(role);
      if (canUpdateOrganization(ctx) || canTransferOwnership(ctx)) expect(canViewOrganizationSettings(ctx), role).toBe(true);
    }
    // An unknown role opens nothing.
    expect(canViewOrganizationSettings(await contextAs("superuser"))).toBe(false);
  });

  it("the activity log is for those who hold org.activity.read: Owners and Admins", async () => {
    expect(await allowed(canReadActivity)).toEqual(["owner", "admin"]);
    for (const role of ROLE_KEYS) {
      const ctx = await contextAs(role);
      expect(canReadActivity(ctx), role).toBe(can(ctx, "org.activity.read"));
    }
    expect(canReadActivity(await contextAs("superuser"))).toBe(false);
    for (const fake of [undefined, null, {}, { permissions: permissionsForRole("owner") }] as unknown as OrgContext[]) expect(canReadActivity(fake)).toBe(false);
  });

  it("canActOn: anyone's with `.any`, one's own with `.own`, nothing without either", async () => {
    for (const scope of ["entries.post.update", "entries.post.publish", "entries.post.delete", "media.update", "media.delete"] as const) {
      for (const role of ROLE_KEYS) {
        const ctx = await contextAs(role);
        const [any, own] = [permissionsForRole(role).has(`${scope}.any`), permissionsForRole(role).has(`${scope}.own`)];
        expect(canActOn(ctx, scope, theirs), `${role} ${scope} theirs`).toBe(any);
        expect(canActOn(ctx, scope, mine), `${role} ${scope} mine`).toBe(any || own);
        expect(canActOn(ctx, scope, { organizationId: OTHER_ORG, ownerId: ME }), `${role} ${scope} foreign`).toBe(false);
      }
    }
    const author = await contextAs("author");
    expect(canActOn(author, "media.delete", mine)).toBe(true);
    expect(canActOn(author, "media.delete", theirs)).toBe(false);
    expect(canActOn(await contextAs("viewer"), "media.delete", mine)).toBe(false);
  });
});
