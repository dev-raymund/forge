import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { describe, expect, it, vi } from "vitest";
import {
  canCreateSite, canDeleteSite, canManageSiteSettings, canOpenSiteSettings, changeSiteAddress, createSite, deleteSite, getSite, listSites, siteAllowance,
  submitChangeSiteAddress, submitCreateSite, submitDeleteSite,
} from "@/modules/sites";
import { listActivity, resolveSiteContext, type OrgContext } from "@/modules/tenancy";
import * as t from "@/platform/db/schema";
import { withPlatform, withTenant } from "@/platform/db/tenant";
import { dbError } from "../fixtures/db-error";
import { whileFailing } from "../fixtures/db-failure";
import { actorOf, addMember, newSlug, newTenant, refusalOf } from "../fixtures/tenants";

// The public resolver is a `'use cache'` function. Outside Next its cache calls have nothing to talk to: they are made
// to do nothing, and the query behind them runs as it does in production.
vi.mock("next/cache", async (original) => ({ ...(await original<typeof import("next/cache")>()), cacheLife: () => {}, cacheTag: () => {} }));
const { resolveSite } = await import("@spikes/rendering/queries");

/**
 * M4-1 against real Postgres, as forge_app through PgBouncer: creating a site
 * (with its settings, its address and its audit record, in one transaction),
 * the plan's limit, the address's uniqueness under concurrency, moving and
 * deleting a site, isolation between organizations, and what the public
 * resolver answers for an address afterwards.
 */

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};
const input = (address: string, name = "Acme Bakery") => ({ name, address, language: "en", timezone: "UTC" });

const sitesOf = (orgId: string) => withTenant({ orgId }, (tx) => tx.select().from(t.sites).where(eq(t.sites.organizationId, orgId)).orderBy(t.sites.createdAt));
const settingsOf = (orgId: string) => withTenant({ orgId }, (tx) => tx.select().from(t.siteSettings).where(eq(t.siteSettings.organizationId, orgId)));
const addressesOf = (orgId: string) => withPlatform((tx) => tx.select().from(t.domains).where(eq(t.domains.organizationId, orgId)));
const holderOf = async (address: string) => (await withPlatform((tx) => tx.select().from(t.domains).where(eq(t.domains.hostname, address))))[0] ?? null;
const auditOf = (orgId: string) =>
  withTenant({ orgId }, (tx) => tx.select().from(t.auditLogs).where(eq(t.auditLogs.organizationId, orgId)).orderBy(t.auditLogs.createdAt, t.auditLogs.id));
const siteEventsOf = async (orgId: string) => (await auditOf(orgId)).filter((row) => row.action.startsWith("site."));
/** Everything an organization has of sites, as one value to compare before and after. */
const snapshotOf = async (orgId: string) => JSON.stringify([await sitesOf(orgId), await settingsOf(orgId), await addressesOf(orgId), await siteEventsOf(orgId)]);
const setPlan = (orgId: string, planKey: "free" | "pro") =>
  withTenant({ orgId }, (tx) => tx.update(t.subscriptions).set({ planKey, status: planKey === "free" ? "free" : "trialing" }).where(eq(t.subscriptions.organizationId, orgId)));
/** A member's context for one site, as the resolver makes it from the URL. */
const siteCtx = (member: { actor: ReturnType<typeof actorOf>; ctx: OrgContext }, siteSlug: string) => resolveSiteContext(member.actor, member.ctx.org.slug, siteSlug);

describe("creating a site", () => {
  it("an Owner creates one: the site, its settings, its address and its record, in one go", async () => {
    const a = await newTenant();
    const address = newSlug("acme");
    const { site, events } = await createSite(a.ctx, { name: "  Acme Bakery ", address, language: "fil", timezone: "Asia/Manila" });

    expect(site).toMatchObject({ name: "Acme Bakery", slug: address, address, status: "coming_soon", language: "fil", timezone: "Asia/Manila" });
    const [row] = await sitesOf(a.org.id);
    expect(row).toMatchObject({
      id: site.id, organizationId: a.org.id, name: "Acme Bakery", slug: address, status: "coming_soon", themeKey: "studio", defaultLocale: "fil",
      timezone: "Asia/Manila", createdBy: a.user.id, deletedAt: null,
    });
    // Settings: one row, the groups empty (their readers apply the defaults, M4-2).
    expect(await settingsOf(a.org.id)).toEqual([
      expect.objectContaining({ siteId: site.id, organizationId: a.org.id, general: {}, reading: {}, seo: {}, analytics: {}, theme: {}, version: 1, updatedBy: a.user.id }),
    ]);
    // The address: the platform's `subdomain` row, primary and active at once.
    expect(await addressesOf(a.org.id)).toEqual([
      expect.objectContaining({ organizationId: a.org.id, siteId: site.id, hostname: address, kind: "subdomain", isPrimary: true, status: "active", verificationToken: null }),
    ]);
    // The record, by the session's user, about this site.
    const [line] = await siteEventsOf(a.org.id);
    expect(line).toMatchObject({ action: "site.created", resourceType: "site", resourceId: site.id, siteId: site.id, actorId: a.user.id, metadata: { name: "Acme Bakery", address } });
    // What the public pages must forget: "no such site" may have been cached for this address.
    expect(events).toEqual([{ type: "domain.changed", siteId: site.id, hostnames: [address] }]);
  });

  it("an Admin may too; an Editor, an Author or a Viewer may not, and is told so before anything they sent is looked at", async () => {
    const a = await newTenant();
    const admin = await addMember(a.org, "admin");
    expect((await createSite(admin.ctx, input(newSlug("by-admin")))).site.status).toBe("coming_soon");

    const before = await snapshotOf(a.org.id);
    for (const role of ["editor", "author", "viewer"] as const) {
      const member = await addMember(a.org, role);
      for (const attempt of [input(newSlug("nope")), input("www"), input(""), { name: "", address: "--", language: "xx", timezone: "Mars/Base" }]) {
        expect((await refusalOf(() => createSite(member.ctx, attempt))).kind, role).toBe("Forbidden");
      }
    }
    expect(await snapshotOf(a.org.id)).toBe(before);
  });

  it("the address has one spelling: trimmed and lowercased", async () => {
    const a = await newTenant();
    const address = newSlug("mixed");
    const { site } = await createSite(a.ctx, input(`  ${address.toUpperCase()} `));
    expect(site.address).toBe(address);
    expect((await holderOf(address))?.siteId).toBe(site.id);
  });

  it("refuses an address that is not one, or is reserved, and writes nothing", async () => {
    const a = await newTenant();
    const before = await snapshotOf(a.org.id);
    const invalid = ["", "   ", "-acme", "acme-", "ac--me", "xn--bcher-kva", "a_b", "acme.com", "acme/x", "café", "ａｃｍｅ", "a".repeat(64), "acme!", "<script>"];
    for (const address of [...invalid, "www", "app", "api", "admin", "media", "WWW", " Media "]) {
      const refused = await refusalOf(() => createSite(a.ctx, input(address)));
      expect(refused.kind, address).toBe("Validation");
      expect(Object.keys(refused.fieldErrors ?? {}), address).toEqual(["address"]);
    }
    expect((await refusalOf(() => createSite(a.ctx, input("www")))).fieldErrors?.address).toEqual(["That address is reserved. Choose another."]);
    expect(await snapshotOf(a.org.id)).toBe(before);
  });

  it("checks the name, the language and the time zone", async () => {
    const a = await newTenant();
    const before = await snapshotOf(a.org.id);
    const cases: [Partial<ReturnType<typeof input>>, string][] = [
      [{ name: "   " }, "name"],
      [{ name: "x".repeat(81) }, "name"],
      [{ language: "xx" }, "language"],
      [{ language: "" }, "language"],
      [{ timezone: "Mars/Base" }, "timezone"],
      [{ timezone: "utc" }, "timezone"],
      [{ timezone: "+05:00" }, "timezone"],
    ];
    for (const [change, field] of cases) {
      const refused = await refusalOf(() => createSite(a.ctx, { ...input(newSlug("fields")), ...change }));
      expect(refused.kind, JSON.stringify(change)).toBe("Validation");
      expect(Object.keys(refused.fieldErrors ?? {}), JSON.stringify(change)).toEqual([field]);
    }
    expect(await snapshotOf(a.org.id)).toBe(before);
  });

  it("an address is unique on the whole platform: taken in this organization or another, the person is told, and the site that has it is untouched", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const address = newSlug("taken");
    const { site } = await createSite(a.ctx, input(address));
    const [aBefore, bBefore] = [await snapshotOf(a.org.id), await snapshotOf(b.org.id)];

    for (const [ctx, typed] of [[a.ctx, address], [b.ctx, address], [b.ctx, address.toUpperCase()], [b.ctx, ` ${address} `]] as [OrgContext, string][]) {
      const refused = await refusalOf(() => createSite(ctx, input(typed, "Copycat")));
      expect(refused.kind).toBe("Validation");
      expect(refused.fieldErrors).toEqual({ address: ["That address is already taken. Choose another."] });
    }
    expect(await snapshotOf(a.org.id)).toBe(aBefore);
    expect(await snapshotOf(b.org.id)).toBe(bBefore); // no site, no settings, no address, no record: the whole transaction is gone
    expect((await holderOf(address))?.siteId).toBe(site.id);
  });

  it("the site's slug is its address; when an older site of the organization holds that slug, a number is added", async () => {
    const a = await newTenant();
    const first = newSlug("first");
    const { site } = await createSite(a.ctx, input(first));
    expect(site.slug).toBe(first);
    // The first site moves to another address, and keeps its slug (its admin URLs keep working).
    await changeSiteAddress(await siteCtx(a, first), { address: newSlug("elsewhere") });
    // Its old address is free again, and a new site takes it. Its slug cannot be the same.
    const { site: second } = await createSite(a.ctx, input(first, "Second"));
    expect(second).toMatchObject({ address: first, slug: `${first}-2` });
    expect((await getSite(await siteCtx(a, first))).id).toBe(site.id);
    expect((await getSite(await siteCtx(a, `${first}-2`))).id).toBe(second.id);
  });
});

describe("who may do what with sites", () => {
  it("by role, from the permissions in the context (ADR 0009): list every member; create and move Owner and Admin; delete Owner", async () => {
    const a = await newTenant();
    const table: Record<string, boolean[]> = {};
    for (const role of ["owner", "admin", "editor", "author", "viewer"] as const) {
      const ctx = role === "owner" ? a.ctx : (await addMember(a.org, role)).ctx;
      table[role] = [canCreateSite(ctx), canManageSiteSettings(ctx), canDeleteSite(ctx), canOpenSiteSettings(ctx)];
      expect(Array.isArray(await listSites(ctx)), role).toBe(true);
    }
    expect(table).toEqual({
      owner: [true, true, true, true],
      admin: [true, true, false, true],
      editor: [false, false, false, false],
      author: [false, false, false, false],
      viewer: [false, false, false, false],
    });
  });
});

describe("the site and its record commit together, or not at all", () => {
  it("if the record cannot be written, there is no site: no row, no settings, no address", async () => {
    const a = await newTenant();
    const address = newSlug("unrecorded");
    const before = await snapshotOf(a.org.id);
    const error = await dbError(whileFailing("audit_logs", "insert", () => createSite(a.ctx, input(address))));
    expect(error.message).toMatch(/forced failure on audit_logs/);
    expect(await snapshotOf(a.org.id)).toBe(before);
    expect(await holderOf(address)).toBeNull();
    // Nothing was held back for it either: the address is free.
    expect((await createSite(a.ctx, input(address))).site.address).toBe(address);
  });

  it("if the commit itself is refused after everything was written, none of it stays", async () => {
    const a = await newTenant();
    const address = newSlug("at-commit");
    const before = await snapshotOf(a.org.id);
    for (const table of ["audit_logs", "domains", "site_settings"]) {
      const error = await dbError(whileFailing(table, "insert", () => createSite(a.ctx, input(address)), { atCommit: true }));
      expect(error.message, table).toMatch(new RegExp(`forced failure on ${table}`));
      expect(await snapshotOf(a.org.id), table).toBe(before);
    }
    expect(await holderOf(address)).toBeNull();
  });

  it("if the address cannot be written, there is no site and no record", async () => {
    const a = await newTenant();
    const before = await snapshotOf(a.org.id);
    expect((await dbError(whileFailing("domains", "insert", () => createSite(a.ctx, input(newSlug("no-address")))))).message).toMatch(/forced failure on domains/);
    expect(await snapshotOf(a.org.id)).toBe(before);
  });

  it("moving and deleting: if the record cannot be written, the site keeps its address, and is not deleted", async () => {
    const a = await newTenant();
    const address = newSlug("kept");
    await createSite(a.ctx, input(address));
    const before = await snapshotOf(a.org.id);
    const ctx = await siteCtx(a, address);
    await whileFailing("audit_logs", "insert", async () => {
      expect((await dbError(changeSiteAddress(ctx, { address: newSlug("lost") }))).message).toMatch(/forced failure on audit_logs/);
      expect((await dbError(deleteSite(ctx))).message).toMatch(/forced failure on audit_logs/);
    });
    expect(await snapshotOf(a.org.id)).toBe(before);
    expect((await holderOf(address))?.organizationId).toBe(a.org.id);
  });
});

describe("the plan's limit", () => {
  it("Pro, and the trial every organization starts with: 5 sites. The 6th is refused, and nothing of it is written", async () => {
    const a = await newTenant();
    for (let n = 1; n <= 5; n++) await createSite(a.ctx, input(newSlug(`pro${n}`)));
    expect(await siteAllowance(a.ctx)).toEqual({ plan: "pro", key: "sites", used: 5, limit: 5 });

    const before = await snapshotOf(a.org.id);
    const address = newSlug("sixth");
    const refused = await refusalOf(() => createSite(a.ctx, input(address)));
    expect(refused).toMatchObject({ kind: "LimitExceeded", message: "The Pro plan includes 5 sites, and this organization has reached it." });
    expect(await snapshotOf(a.org.id)).toBe(before);
    expect(await holderOf(address)).toBeNull();
  });

  it("Free: 1 site. A deleted site no longer counts", async () => {
    const a = await newTenant();
    await setPlan(a.org.id, "free");
    const first = newSlug("free");
    await createSite(a.ctx, input(first));
    expect(await refusalOf(() => createSite(a.ctx, input(newSlug("second"))))).toMatchObject({
      kind: "LimitExceeded", message: "The Free plan includes 1 site, and this organization has reached it.",
    });
    await deleteSite(await siteCtx(a, first));
    expect(await siteAllowance(a.ctx)).toEqual({ plan: "free", key: "sites", used: 0, limit: 1 });
    expect((await createSite(a.ctx, input(newSlug("again")))).site.status).toBe("coming_soon");
  });

  it("an organization with no subscription row has the Free plan's limit", async () => {
    const a = await newTenant();
    await withTenant({ orgId: a.org.id }, (tx) => tx.delete(t.subscriptions).where(eq(t.subscriptions.organizationId, a.org.id)));
    await createSite(a.ctx, input(newSlug("unbilled")));
    expect((await refusalOf(() => createSite(a.ctx, input(newSlug("unbilled-2"))))).kind).toBe("LimitExceeded");
  });

  it("the role is asked first: someone who may not create sites is told that, not that the plan is full", async () => {
    const a = await newTenant();
    await setPlan(a.org.id, "free");
    await createSite(a.ctx, input(newSlug("full")));
    const editor = await addMember(a.org, "editor");
    expect((await refusalOf(() => createSite(editor.ctx, input(newSlug("x"))))).kind).toBe("Forbidden");
  });

  it("ten at once on a Free plan: exactly one site is created, and the other nine are refused by the limit", async () => {
    const a = await newTenant();
    await setPlan(a.org.id, "free");
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, n) => createSite(a.ctx, input(newSlug(`race${n}`)))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const result of results.filter((r) => r.status === "rejected")) expect((result as PromiseRejectedResult).reason).toMatchObject({ kind: "LimitExceeded" });
    expect(await sitesOf(a.org.id)).toHaveLength(1);
    expect(await addressesOf(a.org.id)).toHaveLength(1);
    expect(await siteEventsOf(a.org.id)).toHaveLength(1);
  });

  it("four at once with one place left on Pro: exactly one", async () => {
    const a = await newTenant();
    for (let n = 1; n <= 4; n++) await createSite(a.ctx, input(newSlug(`fill${n}`)));
    const results = await Promise.allSettled(Array.from({ length: 4 }, (_, n) => createSite(a.ctx, input(newSlug(`last${n}`)))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await sitesOf(a.org.id)).toHaveLength(5);
  });
});

describe("one address, asked for at the same moment", () => {
  it("ten organizations ask for the same address at once: exactly one gets it, and the other nine are told it is taken, with nothing written", async () => {
    const tenants = await Promise.all(Array.from({ length: 10 }, () => newTenant("Racer")));
    const address = newSlug("contested");
    const results = await Promise.allSettled(tenants.map((tenant) => createSite(tenant.ctx, input(address))));

    const winners = results.flatMap((result, i) => (result.status === "fulfilled" ? [i] : []));
    expect(winners).toHaveLength(1);
    for (const [i, result] of results.entries()) {
      if (result.status === "fulfilled") continue;
      expect(result.reason, `tenant ${i}`).toMatchObject({ kind: "Validation", fieldErrors: { address: ["That address is already taken. Choose another."] } });
      expect(await sitesOf(tenants[i]!.org.id)).toEqual([]);
      expect(await siteEventsOf(tenants[i]!.org.id)).toEqual([]);
    }
    const holder = await holderOf(address);
    expect(holder?.organizationId).toBe(tenants[winners[0]!]!.org.id);
  });
});

describe("moving a site to another address", () => {
  it("the old address is free at once, the new one points at the site, the slug stays, and it is recorded", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const [from, to] = [newSlug("from"), newSlug("to")];
    const { site } = await createSite(a.ctx, input(from));
    const admin = await addMember(a.org, "admin");

    const moved = await changeSiteAddress(await siteCtx(admin, from), { address: ` ${to.toUpperCase()} ` });
    expect(moved).toMatchObject({ changed: true, site: { id: site.id, slug: from, address: to }, events: [{ type: "domain.changed", siteId: site.id, hostnames: [from, to] }] });
    expect(await addressesOf(a.org.id)).toEqual([expect.objectContaining({ siteId: site.id, hostname: to, kind: "subdomain", isPrimary: true, status: "active" })]);
    expect((await sitesOf(a.org.id))[0]).toMatchObject({ id: site.id, slug: from });
    expect((await siteEventsOf(a.org.id)).at(-1)).toMatchObject({
      action: "site.address_changed", resourceId: site.id, siteId: site.id, actorId: admin.user.id, metadata: { name: "Acme Bakery", previousAddress: from, newAddress: to },
    });
    // Anyone may now have the old one.
    expect((await createSite(b.ctx, input(from))).site.address).toBe(from);
  });

  it("the same address again changes nothing and records nothing; a taken, reserved or malformed one is refused", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const [mine, theirs] = [newSlug("mine"), newSlug("theirs")];
    await createSite(a.ctx, input(mine));
    await createSite(b.ctx, input(theirs));
    const ctx = await siteCtx(a, mine);
    const before = await snapshotOf(a.org.id);

    expect(await changeSiteAddress(ctx, { address: mine.toUpperCase() })).toMatchObject({ changed: false, events: [] });
    expect((await refusalOf(() => changeSiteAddress(ctx, { address: theirs }))).fieldErrors).toEqual({ address: ["That address is already taken. Choose another."] });
    for (const address of ["www", "api", "-x", "a--b", ""]) expect((await refusalOf(() => changeSiteAddress(ctx, { address }))).kind, address).toBe("Validation");
    expect(await snapshotOf(a.org.id)).toBe(before);
  });

  it("takes site.settings.manage: an Editor may not", async () => {
    const a = await newTenant();
    const address = newSlug("guarded");
    await createSite(a.ctx, input(address));
    const editor = await addMember(a.org, "editor");
    const before = await snapshotOf(a.org.id);
    expect((await refusalOf(async () => changeSiteAddress(await siteCtx(editor, address), { address: newSlug("x") }))).kind).toBe("Forbidden");
    expect(await snapshotOf(a.org.id)).toBe(before);
  });
});

describe("deleting a site", () => {
  it("an Owner deletes it: out of every list, its address and slug free, recorded; its rows kept", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const address = newSlug("doomed");
    const { site } = await createSite(a.ctx, input(address, "Doomed"));
    const { events } = await deleteSite(await siteCtx(a, address));

    expect(events).toEqual([{ type: "domain.changed", siteId: site.id, hostnames: [address] }]);
    expect((await sitesOf(a.org.id))[0]).toMatchObject({ id: site.id, deletedAt: expect.any(Date) });
    expect(await settingsOf(a.org.id)).toHaveLength(1); // a soft delete: the content stays
    expect(await addressesOf(a.org.id)).toEqual([]);
    expect(await listSites(a.ctx)).toEqual([]);
    expect((await siteEventsOf(a.org.id)).at(-1)).toMatchObject({ action: "site.deleted", resourceId: site.id, siteId: site.id, metadata: { name: "Doomed", address } });
    // Its admin URL leads nowhere now, and twice is not a thing.
    expect((await refusalOf(() => siteCtx(a, address))).kind).toBe("NotFound");
    // Its address and its slug are free.
    expect((await createSite(b.ctx, input(address))).site.address).toBe(address);
    expect((await createSite(a.ctx, input(newSlug("next"), "Next"))).site.status).toBe("coming_soon");
  });

  it("only an Owner: an Admin is refused, and the site is as it was", async () => {
    const a = await newTenant();
    const address = newSlug("kept");
    await createSite(a.ctx, input(address));
    const admin = await addMember(a.org, "admin");
    const before = await snapshotOf(a.org.id);
    expect((await refusalOf(async () => deleteSite(await siteCtx(admin, address)))).kind).toBe("Forbidden");
    expect(await snapshotOf(a.org.id)).toBe(before);
  });
});

describe("the site forms", () => {
  it("create: to the new site's page; the pages that list it are refreshed, and the public cache is told", async () => {
    const a = await newTenant();
    const address = newSlug("formed");
    const outcome = await submitCreateSite(a.actor, a.org.slug, form({ name: "Formed", address, language: "de", timezone: "Europe/Berlin" }), { requestId: "req-site-1", ip: "203.0.113.4" });
    const [site] = await sitesOf(a.org.id);
    const slug = a.org.slug;
    expect(outcome).toEqual({
      state: { status: "success" },
      redirectTo: `/${slug}/sites/${address}`,
      revalidate: [
        `/${slug}/sites`, `/${slug}/settings`, `/${slug}/members`, `/${slug}/activity`,
        `/${slug}/sites/${address}`, `/${slug}/sites/${address}/settings`, `/${slug}/sites/${address}/appearance`,
      ],
      invalidate: [{ type: "domain.changed", siteId: site!.id, hostnames: [address] }],
    });
    expect((await siteEventsOf(a.org.id))[0]).toMatchObject({ requestId: "req-site-1", ip: "203.0.113.4" });
  });

  it("create: who it is for comes from the session and the URL, never the form; refused, the form keeps what was typed", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const [bBefore] = [await snapshotOf(b.org.id)];
    const address = newSlug("mine");
    await submitCreateSite(
      a.actor,
      a.org.slug,
      form({ ...input(address), organizationId: b.org.id, orgSlug: b.org.slug, createdBy: b.user.id, status: "live", themeKey: "evil", slug: "chosen" }),
    );
    expect((await sitesOf(a.org.id))[0]).toMatchObject({ organizationId: a.org.id, createdBy: a.user.id, status: "coming_soon", themeKey: "studio", slug: address });
    expect(await snapshotOf(b.org.id)).toBe(bBefore);

    const refused = await submitCreateSite(a.actor, a.org.slug, form({ name: "Again", address, language: "en", timezone: "UTC" }));
    expect(refused).toMatchObject({
      refused: "Validation",
      state: { status: "error", fieldErrors: { address: ["That address is already taken. Choose another."] }, values: { name: "Again", address, language: "en", timezone: "UTC" } },
    });
    expect(refused.redirectTo).toBeUndefined();
    expect(refused.invalidate).toBeUndefined();
  });

  it("without a session nothing is created, and the browser is sent to log in and come back to the form", async () => {
    const a = await newTenant();
    const outcome = await submitCreateSite({ kind: "anonymous" }, a.org.slug, form(input(newSlug("anon"))));
    expect(outcome).toMatchObject({ refused: "Unauthenticated", redirectTo: `/login?next=${encodeURIComponent(`/${a.org.slug}/sites/new`)}&reason=session` });
    expect(await sitesOf(a.org.id)).toEqual([]);
  });

  it("change address: says where the site is now, and refreshes both addresses", async () => {
    const a = await newTenant();
    const [from, to] = [newSlug("old"), newSlug("new")];
    const { site } = await createSite(a.ctx, input(from));
    const outcome = await submitChangeSiteAddress(a.actor, a.org.slug, from, form({ address: to }));
    expect(outcome).toMatchObject({
      state: { status: "success", message: `The site is now at /s/${to}.`, values: { address: to } },
      invalidate: [{ type: "domain.changed", siteId: site.id, hostnames: [from, to] }],
    });
    expect(outcome.redirectTo).toBeUndefined();
  });

  it("delete: asks for the address typed out, and an Admin is refused before that is even looked at", async () => {
    const a = await newTenant();
    const address = newSlug("typed");
    await createSite(a.ctx, input(address));
    const admin = await addMember(a.org, "admin");
    const before = await snapshotOf(a.org.id);

    expect(await submitDeleteSite(admin.actor, a.org.slug, address, form({ confirm: address }))).toMatchObject({ refused: "Forbidden" });
    expect(await submitDeleteSite(admin.actor, a.org.slug, address, form({ confirm: "wrong" }))).toMatchObject({ refused: "Forbidden" });
    for (const confirm of ["", "wrong", address.slice(0, -1)]) {
      expect(await submitDeleteSite(a.actor, a.org.slug, address, form({ confirm }))).toMatchObject({
        refused: "Validation", state: { fieldErrors: { confirm: [`Type ${address} to confirm.`] } },
      });
    }
    expect(await snapshotOf(a.org.id)).toBe(before);

    const done = await submitDeleteSite(a.actor, a.org.slug, address, form({ confirm: ` ${address.toUpperCase()} ` }));
    expect(done).toMatchObject({ state: { status: "success" }, redirectTo: `/${a.org.slug}/sites?done=deleted` });
    expect(await listSites(a.ctx)).toEqual([]);
  });
});

describe("between organizations", () => {
  it("each organization lists its own sites, and nothing of another's", async () => {
    const a = await newTenant();
    const b = await newTenant();
    await createSite(a.ctx, input(newSlug("a1"), "A one"));
    await createSite(a.ctx, input(newSlug("a2"), "A two"));
    await createSite(b.ctx, input(newSlug("b1"), "B one"));
    expect((await listSites(a.ctx)).map((site) => site.name)).toEqual(["A one", "A two"]);
    expect((await listSites(b.ctx)).map((site) => site.name)).toEqual(["B one"]);
    const viewer = await addMember(a.org, "viewer");
    expect(await listSites(viewer.ctx)).toHaveLength(2); // every member sees the sites
  });

  it("another organization's site, by its slug or its id, is not found, whatever the role; nothing of it changes", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const theirs = newSlug("theirs");
    const { site } = await createSite(b.ctx, input(theirs));
    const before = await snapshotOf(b.org.id);
    for (const named of [theirs, site.id]) {
      expect((await refusalOf(() => siteCtx(a, named))).kind).toBe("NotFound");
      expect(await submitChangeSiteAddress(a.actor, a.org.slug, named, form({ address: newSlug("hijack") }))).toMatchObject({ refused: "NotFound" });
      expect(await submitDeleteSite(a.actor, a.org.slug, named, form({ confirm: theirs }))).toMatchObject({ refused: "NotFound" });
    }
    expect(await submitCreateSite(a.actor, b.org.slug, form(input(newSlug("planted"))))).toMatchObject({ refused: "NotFound" });
    expect(await submitChangeSiteAddress(a.actor, b.org.slug, theirs, form({ address: newSlug("hijack") }))).toMatchObject({ refused: "NotFound" });
    expect(await submitDeleteSite(a.actor, b.org.slug, theirs, form({ confirm: theirs }))).toMatchObject({ refused: "NotFound" });
    expect(await snapshotOf(b.org.id)).toBe(before);
  });

  it("the activity page's site filter narrows to one site's events, and a site of another organization matches nothing", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const { site: one } = await createSite(a.ctx, input(newSlug("one")));
    const { site: two } = await createSite(a.ctx, input(newSlug("two")));
    const { site: theirs } = await createSite(b.ctx, input(newSlug("theirs")));
    const actions = async (site: string) => (await listActivity(a.ctx, { site })).items.map((item) => item.action);
    expect(await actions(one.id)).toEqual(["site.created"]);
    expect(await actions(two.id)).toEqual(["site.created"]);
    expect(await actions(theirs.id)).toEqual([]);
  });
});

describe("the public address resolves to the site, and only while it is the site's", () => {
  it("created → the same site and organization; unknown → nothing; moved → only the new one; deleted → nothing", async () => {
    const a = await newTenant();
    const [address, moved] = [newSlug("public"), newSlug("public-moved")];
    const { site } = await createSite(a.ctx, input(address));
    const at = (value: string) => resolveSite({ kind: "address", address: value });

    expect(await at(address)).toEqual({ siteId: site.id, orgId: a.org.id });
    expect(await at(newSlug("nobody"))).toBeNull();

    await changeSiteAddress(await siteCtx(a, address), { address: moved });
    expect(await at(address)).toBeNull();
    expect(await at(moved)).toEqual({ siteId: site.id, orgId: a.org.id });

    await deleteSite(await siteCtx(a, address));
    expect(await at(moved)).toBeNull();
  });

  it("it reads only the address: no session, no organization, no context of the visitor's goes in", async () => {
    // The resolver's whole input is the locator; a signed-in member of another organization asks exactly the same question.
    expect(resolveSite.length).toBe(1);
    const a = await newTenant();
    const address = newSlug("same-for-all");
    const { site } = await createSite(a.ctx, input(address));
    const b = await newTenant();
    await createSite(b.ctx, input(newSlug("other")));
    expect(await resolveSite({ kind: "address", address })).toEqual({ siteId: site.id, orgId: a.org.id });
  });
});

describe("what the database itself refuses, whatever the code does", () => {
  it("an address row for another organization's site, written from inside this one", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const { site } = await createSite(b.ctx, input(newSlug("b-site")));
    const attempt = withTenant({ orgId: a.org.id, userId: a.user.id }, (tx) =>
      tx.insert(t.domains).values({ organizationId: a.org.id, siteId: site.id, hostname: newSlug("stolen"), kind: "subdomain", status: "active" }),
    );
    expect((await dbError(attempt)).message).toMatch(/domains_site_fk/);
    const settings = withTenant({ orgId: a.org.id, userId: a.user.id }, (tx) => tx.insert(t.siteSettings).values({ siteId: uuidv7(), organizationId: a.org.id }));
    expect((await dbError(settings)).message).toMatch(/site_settings_site_fk/);
    expect(await addressesOf(b.org.id)).toHaveLength(1);
  });

  it("two sites with one address, and an address in capitals", async () => {
    const a = await newTenant();
    const address = newSlug("dup");
    const { site } = await createSite(a.ctx, input(address));
    const { site: other } = await createSite(a.ctx, input(newSlug("other")));
    const twice = withTenant({ orgId: a.org.id }, (tx) => tx.insert(t.domains).values({ organizationId: a.org.id, siteId: other.id, hostname: address, kind: "subdomain", status: "active" }));
    expect((await dbError(twice)).message).toMatch(/domains_hostname_unique/);
    const upper = withTenant({ orgId: a.org.id }, (tx) =>
      tx.update(t.domains).set({ hostname: address.toUpperCase() }).where(and(eq(t.domains.siteId, site.id), eq(t.domains.organizationId, a.org.id))),
    );
    expect((await dbError(upper)).message).toMatch(/domains_hostname_normalised/);
  });
});
