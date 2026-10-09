import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  canManageAppearance, chooseTheme, createSite, deleteSite, getAppearance, siteNavItems, submitChooseTheme,
} from "@/modules/sites";
import { resolveSiteContext, type OrgContext } from "@/modules/tenancy";
import { tagsForAll } from "@/platform/cache";
import * as t from "@/platform/db/schema";
import { withTenant } from "@/platform/db/tenant";
import { THEME_KEYS } from "@/themes/registry";
import { dbError } from "../fixtures/db-error";
import { whileFailing } from "../fixtures/db-failure";
import { actorOf, addMember, newSlug, newTenant, refusalOf } from "../fixtures/tenants";

/**
 * M4-4 against real Postgres, as forge_app through PgBouncer: a site's theme.
 * Choosing one changes `sites.theme_key` and records it, in one transaction;
 * nothing else about the site changes. Who may, and on which site, come from
 * the context.
 */

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};
const siteCtx = (member: { actor: ReturnType<typeof actorOf>; ctx: OrgContext }, siteSlug: string) => resolveSiteContext(member.actor, member.ctx.org.slug, siteSlug);

async function newSite(tenant: Awaited<ReturnType<typeof newTenant>>) {
  const address = newSlug("themed");
  const { site } = await createSite(tenant.ctx, { name: "Themed", address, language: "en", timezone: "UTC" });
  return { site, slug: site.slug };
}

/** Everything of the site's that a theme switch must leave alone, and its key. */
async function siteState(orgId: string, siteId: string) {
  return withTenant({ orgId }, async (tx) => {
    const [site] = await tx.select().from(t.sites).where(and(eq(t.sites.organizationId, orgId), eq(t.sites.id, siteId)));
    const [settings] = await tx.select().from(t.siteSettings).where(eq(t.siteSettings.siteId, siteId));
    const addresses = await tx.select().from(t.domains).where(eq(t.domains.siteId, siteId));
    const { themeKey, ...rest } = site!;
    // `updated_at` moves with any write; everything else about the row must not.
    return { themeKey, site: JSON.stringify({ ...rest, updatedAt: null }), settings: JSON.stringify(settings), addresses: JSON.stringify(addresses) };
  });
}
const themeEvents = async (orgId: string) =>
  (await withTenant({ orgId }, (tx) => tx.select().from(t.auditLogs).where(eq(t.auditLogs.organizationId, orgId)).orderBy(t.auditLogs.createdAt, t.auditLogs.id))).filter(
    (row) => row.action === "site.theme_changed",
  );

describe("a site's theme", () => {
  it("a new site is drawn with Studio, and its appearance lists the registry's themes", async () => {
    const a = await newTenant();
    const { site, slug } = await newSite(a);
    expect(site.theme).toBe("studio");
    const appearance = await getAppearance(await siteCtx(a, slug));
    expect(appearance.theme).toBe("studio");
    expect(appearance.themes.map((theme) => theme.key)).toEqual(THEME_KEYS);
    expect(appearance.settings.tokens.fonts).toEqual({ heading: "manrope", body: "inter" });
  });

  it("an Owner or an Admin chooses another: only the key changes; content, settings and address stay; it is recorded; the site's cache is told", async () => {
    const a = await newTenant();
    const { site, slug } = await newSite(a);
    // Settings the site has saved (as M8-1 will save them), including another theme's options: they must come through untouched.
    const saved = { tokens: { colors: { primary: "#123456" } }, options: { studio: {}, journal: { kept: true } } };
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.siteSettings).set({ theme: saved, general: { tagline: "Kept" } }).where(eq(t.siteSettings.siteId, site.id)));
    const before = await siteState(a.org.id, site.id);
    const admin = await addMember(a.org, "admin");

    const result = await chooseTheme(await siteCtx(admin, slug), { theme: "journal" });
    expect(result).toMatchObject({ changed: true, site: { id: site.id, theme: "journal" }, events: [{ type: "site.statusChanged", siteId: site.id }] });
    expect(tagsForAll(result.events)).toEqual({ immediate: [`site:${site.id}`], stale: [] });

    const after = await siteState(a.org.id, site.id);
    expect(after.themeKey).toBe("journal");
    expect({ ...after, themeKey: before.themeKey }).toEqual(before);
    expect((await themeEvents(a.org.id)).at(-1)).toMatchObject({
      resourceType: "site", resourceId: site.id, siteId: site.id, actorId: admin.user.id, metadata: { name: "Themed", previousTheme: "studio", newTheme: "journal" },
    });

    // Back to Studio: the saved branding is still the site's, as before.
    await chooseTheme(await siteCtx(a, slug), { theme: "studio" });
    const appearance = await getAppearance(await siteCtx(a, slug));
    expect(appearance.theme).toBe("studio");
    expect(appearance.settings.tokens.colors.primary).toBe("#123456");
    expect((await siteState(a.org.id, site.id)).settings).toBe(before.settings);
  });

  it("the theme it already has changes nothing and records nothing", async () => {
    const a = await newTenant();
    const { site, slug } = await newSite(a);
    const before = await siteState(a.org.id, site.id);
    expect(await chooseTheme(await siteCtx(a, slug), { theme: "studio" })).toMatchObject({ changed: false, events: [] });
    expect(await siteState(a.org.id, site.id)).toEqual(before);
    expect(await themeEvents(a.org.id)).toEqual([]);
  });

  it("only a key from the registry: anything else is refused, and the site is as it was", async () => {
    const a = await newTenant();
    const { site, slug } = await newSite(a);
    const ctx = await siteCtx(a, slug);
    const before = await siteState(a.org.id, site.id);
    for (const theme of ["", "Journal", "JOURNAL", " journal", "journal ", "../journal", "studio/../journal", "__proto__", "constructor", "toString", "retired", "<script>"]) {
      const refused = await refusalOf(() => chooseTheme(ctx, { theme }));
      expect(refused.kind, theme).toBe("Validation");
      expect(refused.fieldErrors, theme).toEqual({ theme: ["Choose one of the themes."] });
    }
    expect(await siteState(a.org.id, site.id)).toEqual(before);
    expect(await themeEvents(a.org.id)).toEqual([]);
  });

  it("the form reads the theme's key and nothing else: settings, ids and roles sent along change nothing", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const { site, slug } = await newSite(a);
    const before = await siteState(a.org.id, site.id);
    const outcome = await submitChooseTheme(
      a.actor,
      a.org.slug,
      slug,
      form({ theme: "journal", settings: JSON.stringify({ tokens: { colors: { primary: "red;}" } } }), themeKey: "studio", organizationId: b.org.id, siteId: b.org.id, role: "owner" }),
    );
    expect(outcome).toMatchObject({ state: { status: "success", message: "The site now uses Journal.", values: { theme: "journal" } }, invalidate: [{ type: "site.statusChanged", siteId: site.id }] });
    expect(outcome.revalidate).toContain(`/${a.org.slug}/sites/${slug}/appearance`);
    const after = await siteState(a.org.id, site.id);
    expect(after.themeKey).toBe("journal");
    expect(after.settings).toBe(before.settings);

    const refused = await submitChooseTheme(a.actor, a.org.slug, slug, form({ theme: "evil" }));
    expect(refused).toMatchObject({ refused: "Validation", state: { status: "error", fieldErrors: { theme: ["Choose one of the themes."] }, values: { theme: "evil" } } });
    expect(refused.invalidate).toBeUndefined();
  });

  it("takes site.settings.manage: Editors, Authors and Viewers are refused, before their choice is looked at; the nav offers the page only to those who may", async () => {
    const a = await newTenant();
    const { site, slug } = await newSite(a);
    const before = await siteState(a.org.id, site.id);
    const paths = { overview: "/o", appearance: "/a", settings: "/s" };
    const admin = await addMember(a.org, "admin");
    expect(canManageAppearance(admin.ctx)).toBe(true);
    expect(siteNavItems(paths, a.ctx).map((item) => item.label)).toEqual(["Overview", "Appearance", "Settings"]);
    expect(siteNavItems(paths, admin.ctx).map((item) => item.label)).toEqual(["Overview", "Appearance", "Settings"]);
    for (const role of ["editor", "author", "viewer"] as const) {
      const member = await addMember(a.org, role);
      expect(canManageAppearance(member.ctx), role).toBe(false);
      expect(siteNavItems(paths, member.ctx).map((item) => item.label), role).toEqual(["Overview"]);
      const ctx = await siteCtx(member, slug);
      for (const theme of ["journal", "not-a-theme"]) expect((await refusalOf(() => chooseTheme(ctx, { theme }))).kind, `${role} ${theme}`).toBe("Forbidden");
    }
    expect(await siteState(a.org.id, site.id)).toEqual(before);
  });

  it("another organization's site, by slug or by id, is not found; nothing of it changes", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const { site, slug } = await newSite(b);
    const before = await siteState(b.org.id, site.id);
    for (const named of [slug, site.id]) {
      expect((await refusalOf(() => siteCtx(a, named))).kind).toBe("NotFound");
      expect(await submitChooseTheme(a.actor, a.org.slug, named, form({ theme: "journal" }))).toMatchObject({ refused: "NotFound" });
    }
    expect(await submitChooseTheme(a.actor, b.org.slug, slug, form({ theme: "journal" }))).toMatchObject({ refused: "NotFound" });
    expect(await siteState(b.org.id, site.id)).toEqual(before);
  });

  it("a deleted site cannot be given a theme", async () => {
    const a = await newTenant();
    const { slug } = await newSite(a);
    const ctx = await siteCtx(a, slug);
    await deleteSite(await siteCtx(a, slug));
    expect((await refusalOf(() => chooseTheme(ctx, { theme: "journal" }))).kind).toBe("NotFound");
  });

  it("if the record cannot be written, the theme does not change; the same if the commit itself is refused", async () => {
    const a = await newTenant();
    const { site, slug } = await newSite(a);
    const ctx = await siteCtx(a, slug);
    const before = await siteState(a.org.id, site.id);
    expect((await dbError(whileFailing("audit_logs", "insert", () => chooseTheme(ctx, { theme: "journal" })))).message).toMatch(/forced failure on audit_logs/);
    expect(await siteState(a.org.id, site.id)).toEqual(before);
    expect((await dbError(whileFailing("audit_logs", "insert", () => chooseTheme(ctx, { theme: "journal" }), { atCommit: true }))).message).toMatch(/forced failure/);
    expect(await siteState(a.org.id, site.id)).toEqual(before);
  });

  it("stored settings that are damaged never break a site's appearance: each bad value falls back alone", async () => {
    const a = await newTenant();
    const { site, slug } = await newSite(a);
    await withTenant({ orgId: a.org.id }, (tx) =>
      tx
        .update(t.siteSettings)
        .set({ theme: { tokens: { colors: { primary: "url(javascript:alert(1))", accent: "#00ff00" }, fonts: "nope" }, header: { cta: { label: "x", href: "javascript:x" } } } })
        .where(eq(t.siteSettings.siteId, site.id)),
    );
    const { settings } = await getAppearance(await siteCtx(a, slug));
    expect(settings.tokens.colors).toMatchObject({ primary: "#1d4ed8", accent: "#00ff00" });
    expect(settings.tokens.fonts).toEqual({ heading: "manrope", body: "inter" });
    expect(settings.header.cta).toBeNull();
  });

  it("a stored key the registry does not know: the site is shown with Studio, and can be moved to a real theme, which records where it came from", async () => {
    const a = await newTenant();
    const { site, slug } = await newSite(a);
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.sites).set({ themeKey: "Retired Theme!" }).where(eq(t.sites.id, site.id)));
    expect((await getAppearance(await siteCtx(a, slug))).theme).toBe("studio");
    await chooseTheme(await siteCtx(a, slug), { theme: "journal" });
    expect((await themeEvents(a.org.id)).at(-1)!.metadata).toMatchObject({ previousTheme: "retiredtheme", newTheme: "journal" });
  });
});
