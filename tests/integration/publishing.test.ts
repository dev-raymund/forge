import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createSite, deleteSite, getSiteOverview, setSiteStatus, siteAllowance, submitSetSiteStatus } from "@/modules/sites";
import { resolveSiteContext, type OrgContext } from "@/modules/tenancy";
import { tagsForAll } from "@/platform/cache";
import * as t from "@/platform/db/schema";
import { withTenant } from "@/platform/db/tenant";
import { dbError } from "../fixtures/db-error";
import { whileFailing } from "../fixtures/db-failure";
import { actorOf, addMember, newSlug, newTenant, refusalOf } from "../fixtures/tenants";

// The renderer's data functions are `'use cache'`; outside Next their cache calls do nothing and the queries run as in
// production (as in renderer.test.ts). The cache itself is exercised by the production build in tests/e2e/publishing.spec.ts.
vi.mock("next/cache", async (original) => ({ ...(await original<typeof import("next/cache")>()), cacheLife: () => {}, cacheTag: () => {} }));
const { loadPublicSite, renderStateFor, resolveSite, robotsFor } = await import("@/modules/rendering");

/**
 * M4-5 against real Postgres, as forge_app through PgBouncer: publishing a
 * site, and switching it back to Coming soon. The status and its audit record
 * commit together or not at all; who may, and which site, come from the
 * context; a repeated or concurrent request leaves one consistent answer.
 */

type Tenant = Awaited<ReturnType<typeof newTenant>>;
type Member = { actor: ReturnType<typeof actorOf>; ctx: OrgContext };

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};
const siteCtx = (member: Member, siteSlug: string) => resolveSiteContext(member.actor, member.ctx.org.slug, siteSlug);
const unverified = <M extends Member & { user: { id: string } }>(member: M): M => ({
  ...member,
  actor: { kind: "user", userId: member.user.id, sessionId: "unverified-session", emailVerified: false } as ReturnType<typeof actorOf>,
});

async function newSite(tenant: Tenant) {
  const address = newSlug("launch");
  const { site } = await createSite(tenant.ctx, { name: "Launch", address, language: "en", timezone: "UTC" });
  return { site, slug: site.slug, address };
}

/** The site's row (but `updated_at`), its settings and its addresses. */
async function siteState(orgId: string, siteId: string) {
  return withTenant({ orgId }, async (tx) => {
    const [site] = await tx.select().from(t.sites).where(and(eq(t.sites.organizationId, orgId), eq(t.sites.id, siteId)));
    const [settings] = await tx.select().from(t.siteSettings).where(eq(t.siteSettings.siteId, siteId));
    const addresses = await tx.select().from(t.domains).where(eq(t.domains.siteId, siteId));
    const { status, ...rest } = site!;
    return { status, site: JSON.stringify({ ...rest, updatedAt: null }), settings: JSON.stringify(settings), addresses: JSON.stringify(addresses) };
  });
}
const statusOf = async (orgId: string, siteId: string) => (await siteState(orgId, siteId)).status;
const statusEvents = async (orgId: string) =>
  (await withTenant({ orgId }, (tx) => tx.select().from(t.auditLogs).where(eq(t.auditLogs.organizationId, orgId)).orderBy(t.auditLogs.createdAt, t.auditLogs.id))).filter(
    (row) => row.action === "site.status_changed",
  );
const setPlan = (orgId: string, planKey: "free" | "pro") =>
  withTenant({ orgId }, (tx) => tx.update(t.subscriptions).set({ planKey, status: planKey === "free" ? "free" : "trialing" }).where(eq(t.subscriptions.organizationId, orgId)));
const setStatusDirectly = (orgId: string, siteId: string, status: "coming_soon" | "live" | "suspended") =>
  withTenant({ orgId }, (tx) => tx.update(t.sites).set({ status }).where(and(eq(t.sites.organizationId, orgId), eq(t.sites.id, siteId))));

/** What a visitor of the address gets, through the renderer's own lookups (no session, no member). */
async function publicView(address: string) {
  const resolved = await resolveSite({ kind: "address", address });
  const site = resolved ? await loadPublicSite(resolved.orgId, resolved.siteId) : null;
  const { kind } = renderStateFor(site, []);
  return { state: kind, robots: robotsFor(kind), site };
}

describe("publishing a site", () => {
  it("coming soon → live: the status and its record commit together; only the status changes; the site's cache tag is flushed; the public renderer follows", async () => {
    const a = await newTenant();
    const { site, slug, address } = await newSite(a);
    const before = await siteState(a.org.id, site.id);
    expect(before.status).toBe("coming_soon");
    expect(await publicView(address)).toMatchObject({ state: "coming-soon", robots: { index: false, follow: false } });

    const admin = await addMember(a.org, "admin");
    const result = await setSiteStatus(await siteCtx(admin, slug), { status: "live" });
    expect(result).toMatchObject({ changed: true, site: { id: site.id, status: "live", address }, events: [{ type: "site.statusChanged", siteId: site.id }] });
    expect(tagsForAll(result.events)).toEqual({ immediate: [`site:${site.id}`], stale: [] });

    const after = await siteState(a.org.id, site.id);
    expect(after.status).toBe("live");
    expect({ ...after, status: "coming_soon" }).toEqual(before);
    const events = await statusEvents(a.org.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      resourceType: "site", resourceId: site.id, siteId: site.id, actorId: admin.user.id, organizationId: a.org.id,
      metadata: { name: "Launch", previousStatus: "coming_soon", newStatus: "live" },
    });
    expect(Object.keys(events[0]!.metadata as object).sort()).toEqual(["name", "newStatus", "previousStatus"]);

    // The same address, now live: the home page, indexable; the theme and name as before.
    expect(await publicView(address)).toMatchObject({ state: "home", robots: { index: true, follow: true }, site: { id: site.id, name: "Launch", status: "live", themeKey: "studio" } });
    expect((await getSiteOverview(await siteCtx(a, slug))).checklist.find((item) => item.key === "publish")).toMatchObject({ done: true, note: "Your site is live." });
  });

  it("live → coming soon (the issue's ↔): recorded the same way, and the public site is a Coming soon page again", async () => {
    const a = await newTenant();
    const { site, slug, address } = await newSite(a);
    await setSiteStatus(await siteCtx(a, slug), { status: "live" });
    const result = await setSiteStatus(await siteCtx(a, slug), { status: "coming_soon" });
    expect(result).toMatchObject({ changed: true, site: { status: "coming_soon" }, events: [{ type: "site.statusChanged", siteId: site.id }] });
    expect((await statusEvents(a.org.id)).map((row) => row.metadata)).toEqual([
      { name: "Launch", previousStatus: "coming_soon", newStatus: "live" },
      { name: "Launch", previousStatus: "live", newStatus: "coming_soon" },
    ]);
    expect(await publicView(address)).toMatchObject({ state: "coming-soon", robots: { index: false, follow: false } });
  });

  it("the form: reads the status and nothing else; the message comes after the commit; repeating it changes and records nothing more", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const { site, slug } = await newSite(a);
    const before = await siteState(a.org.id, site.id);
    const forged = form({ status: "live", organizationId: b.org.id, siteId: b.org.id, role: "owner", permissions: "site.settings.manage", address: "elsewhere", name: "Renamed" });

    const outcome = await submitSetSiteStatus(a.actor, a.org.slug, slug, forged);
    expect(outcome).toMatchObject({ state: { status: "success", message: "Launch is live.", values: { status: "live" } }, invalidate: [{ type: "site.statusChanged", siteId: site.id }] });
    expect(outcome.revalidate).toContain(`/${a.org.slug}/sites/${slug}`);
    expect({ ...(await siteState(a.org.id, site.id)), status: "coming_soon" }).toEqual(before);

    // Submitted again (a double click, a resent request, a second tab): the same answer, nothing new.
    for (let i = 0; i < 3; i++) {
      const again = await submitSetSiteStatus(a.actor, a.org.slug, slug, form({ status: "live" }));
      expect(again).toMatchObject({ state: { status: "success", message: "Launch is already live." }, invalidate: [] });
    }
    expect(await statusEvents(a.org.id)).toHaveLength(1);
    expect(await statusOf(a.org.id, site.id)).toBe("live");

    for (const status of ["suspended", "published", "", "LIVE"]) {
      const refused = await submitSetSiteStatus(a.actor, a.org.slug, slug, form({ status }));
      expect(refused, status).toMatchObject({ refused: "Validation", state: { status: "error", fieldErrors: { status: ["Choose Coming soon or Live."] } } });
      expect(refused.invalidate, status).toBeUndefined();
    }
    expect(await statusOf(a.org.id, site.id)).toBe("live");
  });

  it("a stale page: two members each publish from the page they loaded earlier; one change, one record", async () => {
    const a = await newTenant();
    const { slug } = await newSite(a);
    const admin = await addMember(a.org, "admin");
    const [first, second] = [await siteCtx(a, slug), await siteCtx(admin, slug)];
    expect((await setSiteStatus(first, { status: "live" })).changed).toBe(true);
    expect((await setSiteStatus(second, { status: "live" })).changed).toBe(false);
    expect(await statusEvents(a.org.id)).toHaveLength(1);
  });

  it("concurrent requests: the row lock makes them take turns; the final status matches the last record, and the records form one unbroken chain", async () => {
    const a = await newTenant();
    const { site, slug } = await newSite(a);
    const admin = await addMember(a.org, "admin");
    const contexts = [await siteCtx(a, slug), await siteCtx(admin, slug)];

    // Eight requests to publish at once: exactly one change.
    const publishes = await Promise.all(Array.from({ length: 8 }, (_, i) => setSiteStatus(contexts[i % 2]!, { status: "live" })));
    expect(publishes.filter((result) => result.changed)).toHaveLength(1);
    expect(await statusOf(a.org.id, site.id)).toBe("live");
    expect(await statusEvents(a.org.id)).toHaveLength(1);

    // Both directions at once: whatever the order, each record starts where the previous one ended, and the site is where the last one left it.
    const mixed = await Promise.all(Array.from({ length: 10 }, (_, i) => setSiteStatus(contexts[i % 2]!, { status: i % 2 ? "live" : "coming_soon" })));
    // In the order the lock was granted: the id is a UUIDv7 made by record(), after the lock (monotonic in one process).
    // `created_at` is the transaction's start (`now()`), which is not that order when transactions overlap (ADR 0015 §8).
    const chain = (await statusEvents(a.org.id)).sort((x, y) => (x.id < y.id ? -1 : 1)).map((row) => row.metadata as { previousStatus: string; newStatus: string });
    expect(chain.length).toBe(1 + mixed.filter((result) => result.changed).length);
    for (let i = 1; i < chain.length; i++) expect(chain[i]!.previousStatus, `record ${i}`).toBe(chain[i - 1]!.newStatus);
    expect(await statusOf(a.org.id, site.id)).toBe(chain.at(-1)!.newStatus);
  });

  it("if the record cannot be written, the site stays Coming soon and nothing is recorded; the same if the commit itself is refused", async () => {
    const a = await newTenant();
    const { site, slug, address } = await newSite(a);
    const ctx = await siteCtx(a, slug);
    const before = await siteState(a.org.id, site.id);
    expect((await dbError(whileFailing("audit_logs", "insert", () => setSiteStatus(ctx, { status: "live" })))).message).toMatch(/forced failure on audit_logs/);
    expect(await siteState(a.org.id, site.id)).toEqual(before);
    expect((await dbError(whileFailing("audit_logs", "insert", () => setSiteStatus(ctx, { status: "live" }), { atCommit: true }))).message).toMatch(/forced failure/);
    expect(await siteState(a.org.id, site.id)).toEqual(before);
    // The status write itself refused: the same.
    expect((await dbError(whileFailing("sites", "update", () => setSiteStatus(ctx, { status: "live" })))).message).toMatch(/forced failure on sites/);
    expect(await siteState(a.org.id, site.id)).toEqual(before);
    expect(await statusEvents(a.org.id)).toEqual([]);
    expect(await publicView(address)).toMatchObject({ state: "coming-soon" });

    // Through the form: an error, never "is live".
    const outcome = await whileFailing("audit_logs", "insert", () => submitSetSiteStatus(a.actor, a.org.slug, slug, form({ status: "live" })));
    expect(outcome.state.status).toBe("error");
    expect(outcome.state.message).not.toMatch(/live/i);
    expect(outcome.invalidate).toBeUndefined();
    expect(await statusOf(a.org.id, site.id)).toBe("coming_soon");
  });
});

describe("who may, and which sites", () => {
  it("site.settings.manage: Owners and Admins; Editors, Authors and Viewers are refused in both directions, and nothing changes", async () => {
    const a = await newTenant();
    const { site, slug } = await newSite(a);
    for (const role of ["editor", "author", "viewer"] as const) {
      const member = await addMember(a.org, role);
      for (const status of ["live", "coming_soon"]) {
        expect((await refusalOf(async () => setSiteStatus(await siteCtx(member, slug), { status }))).kind, `${role} ${status}`).toBe("Forbidden");
        expect(await submitSetSiteStatus(member.actor, a.org.slug, slug, form({ status })), `${role} ${status}`).toMatchObject({ refused: "Forbidden" });
      }
    }
    expect(await statusOf(a.org.id, site.id)).toBe("coming_soon");
    expect(await statusEvents(a.org.id)).toEqual([]);
  });

  it("publishing needs a verified email address; switching back to Coming soon does not", async () => {
    const a = await newTenant();
    const { site, slug } = await newSite(a);
    const owner = unverified(a);
    const refused = await refusalOf(async () => setSiteStatus(await siteCtx(owner, slug), { status: "live" }));
    expect(refused).toMatchObject({ kind: "Forbidden", message: "Verify your email address to publish this site." });
    expect(await submitSetSiteStatus(owner.actor, a.org.slug, slug, form({ status: "live" }))).toMatchObject({
      refused: "Forbidden", state: { status: "error", message: "Verify your email address to publish this site." },
    });
    expect(await statusOf(a.org.id, site.id)).toBe("coming_soon");
    expect(await statusEvents(a.org.id)).toEqual([]);

    await setSiteStatus(await siteCtx(a, slug), { status: "live" });
    expect((await setSiteStatus(await siteCtx(owner, slug), { status: "coming_soon" })).changed).toBe(true);
  });

  it("a suspended site: neither direction through the tenant's action; nothing written or recorded; the public site stays unavailable", async () => {
    const a = await newTenant();
    const { site, slug, address } = await newSite(a);
    await setStatusDirectly(a.org.id, site.id, "suspended");
    const before = await siteState(a.org.id, site.id);
    for (const status of ["live", "coming_soon"]) {
      expect(await refusalOf(async () => setSiteStatus(await siteCtx(a, slug), { status })), status).toMatchObject({
        kind: "Conflict", message: "This site is unavailable, so its status cannot be changed here. Contact Forge support.",
      });
      expect(await submitSetSiteStatus(a.actor, a.org.slug, slug, form({ status })), status).toMatchObject({ refused: "Conflict" });
    }
    expect(await siteState(a.org.id, site.id)).toEqual(before);
    expect(await statusEvents(a.org.id)).toEqual([]);
    expect(await publicView(address)).toMatchObject({ state: "site-unavailable", robots: { index: false, follow: false } });
  });

  it("another organization's site, by slug or by id, from either URL, is not found; nothing of it changes", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const { site, slug } = await newSite(b);
    const before = await siteState(b.org.id, site.id);
    for (const named of [slug, site.id]) {
      expect((await refusalOf(() => siteCtx(a, named))).kind).toBe("NotFound");
      expect(await submitSetSiteStatus(a.actor, a.org.slug, named, form({ status: "live" }))).toMatchObject({ refused: "NotFound" });
    }
    expect(await submitSetSiteStatus(a.actor, b.org.slug, slug, form({ status: "live" }))).toMatchObject({ refused: "NotFound" });
    expect(await siteState(b.org.id, site.id)).toEqual(before);
    expect(await statusEvents(b.org.id)).toEqual([]);
  });

  it("a deleted site cannot be published", async () => {
    const a = await newTenant();
    const { site, slug } = await newSite(a);
    const ctx = await siteCtx(a, slug);
    await deleteSite(await siteCtx(a, slug));
    expect((await refusalOf(() => setSiteStatus(ctx, { status: "live" }))).kind).toBe("NotFound");
    expect(await statusEvents(a.org.id)).toEqual([]);
    expect(await withTenant({ orgId: a.org.id }, async (tx) => (await tx.select({ status: t.sites.status }).from(t.sites).where(eq(t.sites.id, site.id)))[0]?.status)).toBe("coming_soon");
  });

  it("only the site asked about: another site of the same organization is untouched", async () => {
    const a = await newTenant();
    const one = await newSite(a);
    const two = await newSite(a);
    const result = await setSiteStatus(await siteCtx(a, one.slug), { status: "live" });
    expect(result.events).toEqual([{ type: "site.statusChanged", siteId: one.site.id }]);
    expect(await statusOf(a.org.id, two.site.id)).toBe("coming_soon");
  });
});

describe("plans and limits", () => {
  it("publishing is not a paid feature, and a live site still counts once against the plan: the Free plan's one site is published, and a second still cannot be created", async () => {
    const a = await newTenant();
    await setPlan(a.org.id, "free");
    const { slug } = await newSite(a);
    const before = await siteAllowance(a.ctx);
    await setSiteStatus(await siteCtx(a, slug), { status: "live" });
    expect(await siteAllowance(a.ctx)).toEqual(before);
    expect(before).toMatchObject({ plan: "free", used: 1, limit: 1 });
    expect((await refusalOf(() => createSite(a.ctx, { name: "Second", address: newSlug("second"), language: "en", timezone: "UTC" }))).kind).toBe("LimitExceeded");
  });
});
