import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { describe, expect, it, vi } from "vitest";
import {
  chooseTheme, createSite, getSiteOverview, getSiteSettings, listSites, onboardingNext, submitCreateSite, submitUpdateSiteSettings, updateSiteSettings,
} from "@/modules/sites";
import { homeOrganization, resolveOrgContext, resolveSiteContext, type OrgContext } from "@/modules/tenancy";
import { tagsForAll } from "@/platform/cache";
import * as t from "@/platform/db/schema";
import { withTenant } from "@/platform/db/tenant";
import { dbError } from "../fixtures/db-error";
import { whileFailing } from "../fixtures/db-failure";
import { createPublishedEntry, createUser } from "../fixtures/factories";
import { actorOf, addMember, newSlug, newTenant, refusalOf } from "../fixtures/tenants";

vi.mock("next/cache", async (original) => ({ ...(await original<typeof import("next/cache")>()), cacheLife: () => {}, cacheTag: () => {} }));
const { loadPublicSite } = await import("@/modules/rendering");

/**
 * M4-2 against real Postgres, as forge_app through PgBouncer: a site's general,
 * reading and analytics settings (strict saves, optimistic version, the record
 * of what changed, a refusal leaving everything as it was), the overview, and
 * where onboarding resumes.
 */

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};
const siteCtx = (member: { actor: ReturnType<typeof actorOf>; ctx: OrgContext }, slug: string) => resolveSiteContext(member.actor, member.ctx.org.slug, slug);

async function newSite() {
  const tenant = await newTenant();
  const { site } = await createSite(tenant.ctx, { name: "Settings Site", address: newSlug("settings"), language: "en", timezone: "UTC" });
  return { tenant, site, ctx: await siteCtx(tenant, site.slug) };
}

/** Everything the settings touch, as one value to compare before and after. */
async function stateOf(orgId: string, siteId: string) {
  return withTenant({ orgId }, async (tx) => {
    const [site] = await tx.select().from(t.sites).where(and(eq(t.sites.organizationId, orgId), eq(t.sites.id, siteId)));
    const [settings] = await tx.select().from(t.siteSettings).where(eq(t.siteSettings.siteId, siteId));
    const events = await tx.select().from(t.auditLogs).where(and(eq(t.auditLogs.organizationId, orgId), eq(t.auditLogs.action, "site.settings_changed")));
    // `updated_at` moves with any write; everything else must not.
    return JSON.stringify({ site: { ...site!, updatedAt: null }, settings: { ...settings!, updatedAt: null }, events: events.length });
  });
}
async function lastEvent(orgId: string) {
  const rows = await withTenant({ orgId }, (tx) =>
    tx
      .select()
      .from(t.auditLogs)
      .where(and(eq(t.auditLogs.organizationId, orgId), eq(t.auditLogs.action, "site.settings_changed")))
      .orderBy(t.auditLogs.createdAt, t.auditLogs.id),
  );
  return rows.at(-1);
}

const general = { name: "Renamed", tagline: "Fresh bread daily", language: "fil", timezone: "Asia/Manila", instagram: "https://instagram.com/renamed", x: "" };

describe("a new site's settings", () => {
  it("start from the plan's defaults", async () => {
    const { ctx } = await newSite();
    expect(await getSiteSettings(ctx)).toEqual({
      version: 1,
      general: { name: "Settings Site", tagline: "", language: "en", timezone: "UTC", social: {} },
      reading: { blogPath: "blog", postsPerPage: 10 },
      analytics: {},
    });
  });
});

describe("saving each group", () => {
  it("general: the site's columns and its tagline and links, one record naming what changed, the settings tag flushed", async () => {
    const { tenant, site, ctx } = await newSite();
    const change = await updateSiteSettings(ctx, "general", general, 1);
    expect(change.changed).toEqual(["name", "tagline", "language", "timezone", "instagram"]);
    expect(change.version).toBe(2);
    expect(tagsForAll(change.events)).toEqual({ immediate: [`site:${site.id}:config`], stale: [] });

    const reloaded = await getSiteSettings(await siteCtx(tenant, site.slug));
    expect(reloaded.general).toEqual({ name: "Renamed", tagline: "Fresh bread daily", language: "fil", timezone: "Asia/Manila", social: { instagram: "https://instagram.com/renamed" } });
    expect(reloaded.version).toBe(2);
    expect(await lastEvent(tenant.org.id)).toMatchObject({
      resourceId: site.id, siteId: site.id, actorId: tenant.user.id, metadata: { name: "Renamed", group: "general", fields: ["name", "tagline", "language", "timezone", "instagram"] },
    });
    // The public side reads the same: its name, words, language and links.
    expect(await loadPublicSite(tenant.org.id, site.id)).toMatchObject({
      name: "Renamed", tagline: "Fresh bread daily", language: "fil", timezone: "Asia/Manila", social: [{ label: "Instagram", href: "https://instagram.com/renamed" }],
    });
  });

  it("reading and analytics: saved, normalised, read back; the record names fields, never their values", async () => {
    const { tenant, site, ctx } = await newSite();
    await updateSiteSettings(ctx, "reading", { blogPath: " News ", postsPerPage: "12" }, 1);
    await updateSiteSettings(ctx, "analytics", { ga4MeasurementId: "g-abc1234567", plausibleDomain: "Example.com" }, 2);
    const reloaded = await getSiteSettings(ctx);
    expect(reloaded.reading).toEqual({ blogPath: "news", postsPerPage: 12 });
    expect(reloaded.analytics).toEqual({ ga4MeasurementId: "G-ABC1234567", plausibleDomain: "example.com" });
    const event = (await lastEvent(tenant.org.id))!;
    expect(event.metadata).toEqual({ name: "Settings Site", group: "analytics", fields: ["ga4MeasurementId", "plausibleDomain"] });
    expect(JSON.stringify(event.metadata)).not.toContain("G-ABC1234567");
    expect((await loadPublicSite(tenant.org.id, site.id))!.analytics).toEqual({ ga4MeasurementId: "G-ABC1234567", plausibleDomain: "example.com" });

    // Turning analytics off again is a change too.
    await updateSiteSettings(ctx, "analytics", { ga4MeasurementId: "", plausibleDomain: "example.com" }, 3);
    expect((await getSiteSettings(ctx)).analytics).toEqual({ plausibleDomain: "example.com" });
  });

  it("the same values again: nothing written, recorded or flushed, and the version stays", async () => {
    const { tenant, site, ctx } = await newSite();
    await updateSiteSettings(ctx, "general", general, 1);
    const before = await stateOf(tenant.org.id, site.id);
    const again = await updateSiteSettings(ctx, "general", { ...general, name: "  Renamed " }, 2);
    expect(again).toMatchObject({ changed: [], version: 2, events: [] });
    expect(await stateOf(tenant.org.id, site.id)).toBe(before);
  });
});

describe("what is refused leaves everything as it was", () => {
  it("invalid input, in each group, is refused at its field", async () => {
    const { tenant, site, ctx } = await newSite();
    const before = await stateOf(tenant.org.id, site.id);
    const cases: [Parameters<typeof updateSiteSettings>[1], Record<string, unknown>, string][] = [
      ["general", { ...general, name: "" }, "name"],
      ["general", { ...general, instagram: "javascript:alert(1)" }, "instagram"],
      ["general", { ...general, timezone: "Mars/Base" }, "timezone"],
      ["general", { ...general, status: "live" }, "_form"],
      ["reading", { blogPath: "my blog", postsPerPage: "10" }, "blogPath"],
      ["reading", { blogPath: "blog", postsPerPage: "500" }, "postsPerPage"],
      ["analytics", { ga4MeasurementId: "UA-12345-1", plausibleDomain: "" }, "ga4MeasurementId"],
      ["analytics", { ga4MeasurementId: "", plausibleDomain: "https://example.com" }, "plausibleDomain"],
    ];
    for (const [group, input, field] of cases) {
      const refused = await refusalOf(() => updateSiteSettings(ctx, group, input, 1));
      expect(refused.kind, `${group} ${field}`).toBe("Validation");
      if (field !== "_form") expect(Object.keys(refused.fieldErrors ?? {}), `${group} ${field}`).toContain(field);
    }
    expect(await stateOf(tenant.org.id, site.id)).toBe(before);
  });

  it("someone else saved since the page was rendered: Conflict, and their save stands", async () => {
    const { tenant, site, ctx } = await newSite();
    await updateSiteSettings(ctx, "general", general, 1);
    const before = await stateOf(tenant.org.id, site.id);
    const refused = await refusalOf(() => updateSiteSettings(ctx, "reading", { blogPath: "late", postsPerPage: "5" }, 1));
    expect(refused).toMatchObject({ kind: "Conflict", message: expect.stringContaining("Reload the page") });
    expect(await stateOf(tenant.org.id, site.id)).toBe(before);
  });

  it("if the record cannot be written, or the commit is refused, no setting changes", async () => {
    const { tenant, site, ctx } = await newSite();
    const before = await stateOf(tenant.org.id, site.id);
    expect((await dbError(whileFailing("audit_logs", "insert", () => updateSiteSettings(ctx, "general", general, 1)))).message).toMatch(/forced failure/);
    expect(await stateOf(tenant.org.id, site.id)).toBe(before);
    expect((await dbError(whileFailing("audit_logs", "insert", () => updateSiteSettings(ctx, "reading", { blogPath: "x", postsPerPage: "3" }, 1), { atCommit: true }))).message).toMatch(/forced failure/);
    expect(await stateOf(tenant.org.id, site.id)).toBe(before);
  });

  it("site.settings.manage: Editors, Authors and Viewers are refused before their input is looked at", async () => {
    const { tenant, site } = await newSite();
    const before = await stateOf(tenant.org.id, site.id);
    for (const role of ["editor", "author", "viewer"] as const) {
      const member = await addMember(tenant.org, role);
      const ctx = await siteCtx(member, site.slug);
      for (const input of [general, { garbage: true }]) expect((await refusalOf(() => updateSiteSettings(ctx, "general", input, 1))).kind, role).toBe("Forbidden");
    }
    const admin = await addMember(tenant.org, "admin");
    expect((await updateSiteSettings(await siteCtx(admin, site.slug), "reading", { blogPath: "news", postsPerPage: "8" }, 1)).changed).toEqual(["blogPath", "postsPerPage"]);
    expect(before).not.toBe(await stateOf(tenant.org.id, site.id));
  });
});

describe("the settings form", () => {
  it("reads its group's fields and the version, and nothing else: no site, organization, theme or status from the form", async () => {
    const { tenant, site } = await newSite();
    const b = await newTenant();
    const outcome = await submitUpdateSiteSettings(
      tenant.actor,
      tenant.org.slug,
      site.slug,
      "general",
      form({ ...general, version: "1", organizationId: b.org.id, siteId: uuidv7(), themeKey: "journal", status: "live", theme: '{"tokens":{}}' }),
    );
    expect(outcome).toMatchObject({ state: { status: "success", message: "General settings saved." }, invalidate: [{ type: "site.configChanged", siteId: site.id }] });
    const [row] = await withTenant({ orgId: tenant.org.id }, (tx) => tx.select().from(t.sites).where(eq(t.sites.id, site.id)));
    expect(row).toMatchObject({ name: "Renamed", status: "coming_soon", themeKey: "studio", organizationId: tenant.org.id });
  });

  it("an unknown group, a missing or wrong version: refused, nothing saved", async () => {
    const { tenant, site } = await newSite();
    const before = await stateOf(tenant.org.id, site.id);
    expect(await submitUpdateSiteSettings(tenant.actor, tenant.org.slug, site.slug, "seo", form({ version: "1" }))).toMatchObject({ refused: "NotFound" });
    for (const version of ["", "x", "0", "99", "1.5"]) {
      const outcome = await submitUpdateSiteSettings(tenant.actor, tenant.org.slug, site.slug, "general", form({ ...general, version }));
      expect(outcome.refused, version).toBe("Conflict");
    }
    expect(await stateOf(tenant.org.id, site.id)).toBe(before);
  });

  it("another organization's site, by slug or id, from either URL: not found, and nothing of it changes", async () => {
    const a = await newSite();
    const b = await newSite();
    const before = await stateOf(b.tenant.org.id, b.site.id);
    for (const [orgSlug, siteSlug] of [[b.tenant.org.slug, b.site.slug], [a.tenant.org.slug, b.site.slug], [a.tenant.org.slug, b.site.id]]) {
      expect(await submitUpdateSiteSettings(a.tenant.actor, orgSlug!, siteSlug!, "general", form({ ...general, version: "1" }))).toMatchObject({ refused: "NotFound" });
    }
    expect(await stateOf(b.tenant.org.id, b.site.id)).toBe(before);
  });
});

describe("the theme and the settings stay apart", () => {
  it("a settings save leaves the theme; a theme switch leaves the settings", async () => {
    const { tenant, site, ctx } = await newSite();
    await updateSiteSettings(ctx, "general", general, 1);
    const settingsBefore = await getSiteSettings(ctx);
    await chooseTheme(ctx, { theme: "journal" });
    expect(await getSiteSettings(ctx)).toEqual(settingsBefore);
    await updateSiteSettings(ctx, "reading", { blogPath: "news", postsPerPage: "5" }, settingsBefore.version);
    const [row] = await withTenant({ orgId: tenant.org.id }, (tx) => tx.select({ themeKey: t.sites.themeKey }).from(t.sites).where(eq(t.sites.id, site.id)));
    expect(row!.themeKey).toBe("journal");
  });
});

describe("the overview", () => {
  it("reads the site, its theme, its settings and a checklist from what the database holds", async () => {
    const { tenant, site, ctx } = await newSite();
    await chooseTheme(ctx, { theme: "journal" });
    await updateSiteSettings(ctx, "analytics", { ga4MeasurementId: "G-ABC1234567", plausibleDomain: "" }, 1);
    let overview = await getSiteOverview(ctx);
    expect(overview).toMatchObject({ theme: { key: "journal", name: "Journal" }, analytics: { ga4: true, plausible: false }, reading: { blogPath: "blog", postsPerPage: 10 } });
    expect(overview.checklist.map((item) => [item.key, item.done])).toEqual([["pages", false], ["menu", false], ["seo", false], ["domain", true], ["publish", false]]);

    // A published page and a menu with items: those items are done (as M5 and M8 will make them).
    await createPublishedEntry({ orgId: tenant.org.id, siteId: site.id, userId: tenant.user.id });
    await withTenant({ orgId: tenant.org.id }, async (tx) => {
      await tx.insert(t.entries).values({ organizationId: tenant.org.id, siteId: site.id, type: "page", status: "draft", title: "Draft", slug: "draft", path: "/draft", locale: "en" });
      await tx.insert(t.menus).values({ organizationId: tenant.org.id, siteId: site.id, location: "header", items: [{ label: "Home" }] });
      await tx.update(t.sites).set({ status: "live" }).where(eq(t.sites.id, site.id));
    });
    overview = await getSiteOverview(ctx);
    expect(overview.checklist.map((item) => [item.key, item.done])).toEqual([["pages", true], ["menu", true], ["seo", false], ["domain", true], ["publish", true]]);
    expect(overview.checklist[0]!.note).toBe("1 published page.");
  });
});

describe("onboarding", () => {
  it("resumes from what exists: an organization without a site is at step 2, one with a site is done; a Viewer has nothing to do", async () => {
    const user = await createUser();
    const actor = actorOf(user);
    expect(onboardingNext({ home: await homeOrganization(actor), sitesInHome: 0, canCreateSites: true })).toEqual({ step: "organization" });

    const tenant = await newTenant();
    const progress = async (member: { actor: ReturnType<typeof actorOf> }) => {
      const home = (await homeOrganization(member.actor))!;
      const ctx = await resolveOrgContext(member.actor, home.slug);
      return onboardingNext({ home, sitesInHome: (await listSites(ctx)).length, canCreateSites: ctx.permissions.has("sites.create") });
    };
    expect(await progress(tenant)).toEqual({ step: "site", orgSlug: tenant.org.slug });
    const viewer = await addMember(tenant.org, "viewer");
    expect(await progress(viewer)).toEqual({ step: "done", orgSlug: tenant.org.slug });

    // Step 2 is the create-site form with its own action; in onboarding it goes on to step 3.
    const address = newSlug("onboarded");
    const outcome = await submitCreateSite(tenant.actor, tenant.org.slug, form({ name: "First", address, language: "en", timezone: "UTC" }), {}, "onboarding");
    expect(outcome.redirectTo).toBe(`/onboarding/${tenant.org.slug}/${address}`);
    expect(await progress(tenant)).toEqual({ step: "done", orgSlug: tenant.org.slug });

    // Any other flow is the admin's: the site's page.
    const other = newSlug("admin-flow");
    expect((await submitCreateSite(tenant.actor, tenant.org.slug, form({ name: "Second", address: other, language: "en", timezone: "UTC" }), {}, "elsewhere")).redirectTo).toBe(
      `/${tenant.org.slug}/sites/${other}`,
    );
  });
});
