import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createEntry, createPreviewLink, publishEntry, saveDraft } from "@/modules/content";
import {
  chooseTheme, createAppearancePreview, createSite, getAppearance, getSiteSettings, setSiteImage, submitAppearancePreview, submitUpdateAppearance, updateAppearance,
  updateSiteSettings,
} from "@/modules/sites";
import { SETTINGS_CONFLICT } from "@/modules/sites/settings.service";
import { changeMemberRole, resolveSiteContext, type SiteContext } from "@/modules/tenancy";
import { tags, tagsForAll } from "@/platform/cache";
import * as t from "@/platform/db/schema";
import { withTenant } from "@/platform/db/tenant";
import { DEVELOPMENT_PREVIEW_SECRET, signAppearanceToken, verifyAppearanceToken } from "@/platform/routing/preview-token";
import { themeFor } from "@/themes/render";
import { themeVariables, type KitSettings } from "@/themes/_kit/tokens";
import { studio } from "@/themes/studio/definition";
import { whileFailing } from "../fixtures/db-failure";
import { addMember, newSlug, newTenant, refusalOf } from "../fixtures/tenants";

// The public reads' cache calls are noted: a save must flush the tag the public site's settings are read under.
const cache = vi.hoisted(() => ({ applied: [] as string[] }));
vi.mock("next/cache", async (original) => ({
  ...(await original<typeof import("next/cache")>()),
  cacheLife: () => {},
  cacheTag: (...names: string[]) => void cache.applied.push(...names),
  revalidateTag: () => {},
  updateTag: () => {},
}));
const { loadPublicSite, loadAppearancePreview, loadPreview, renderableSite } = await import("@/modules/rendering");

/**
 * M8-1 against real Postgres through PgBouncer: the appearance editor's saves (checked strictly, versioned, recorded,
 * flushed; the site's other settings untouched) and its live preview (unsaved settings in a token, checked again
 * with the person's rights now, nothing written).
 */

type Tenant = Awaited<ReturnType<typeof newTenant>>;

async function newSite(tenant: Tenant, name = "Branded") {
  const address = newSlug("brand");
  const { site } = await createSite(tenant.ctx, { name, address, language: "en", timezone: "UTC" });
  return { site, address, ctx: await resolveSiteContext(tenant.actor, tenant.org.slug, site.slug) };
}

/** Studio's defaults, changed in every group. */
const changed: KitSettings = {
  tokens: { colors: { primary: "#be123c", accent: "#4338ca", background: "#fafaf9", text: "#1c1917" }, fonts: { heading: "playfair-display", body: "lora" } },
  header: { variant: "centered", sticky: true, cta: { label: "Book a visit", href: "/contact" } },
  footer: { variant: "columns", copyright: "Since 1998", showSocial: false },
  layout: { width: "wide", radius: "large", density: "relaxed" },
};
const settingsRow = async (orgId: string, siteId: string) => (await withTenant({ orgId }, (tx) => tx.select().from(t.siteSettings).where(eq(t.siteSettings.siteId, siteId))))[0]!;
const records = (orgId: string) =>
  withTenant({ orgId }, async (tx) => (await tx.select().from(t.auditLogs).where(and(eq(t.auditLogs.organizationId, orgId), eq(t.auditLogs.action, "site.settings_changed")))));
const versionOf = async (ctx: SiteContext) => (await getAppearance(ctx)).version;
const form = (settings: unknown, version?: number) => {
  const data = new FormData();
  data.set("settings", JSON.stringify(settings));
  if (version !== undefined) data.set("version", String(version));
  return data;
};
/** What a public page of the site is drawn with: its settings as the theme reads them, and the CSS variables. */
async function drawnWith(orgId: string, siteId: string, address: string) {
  const site = (await loadPublicSite(orgId, siteId))!;
  const { context } = themeFor(renderableSite(site, { kind: "address", address }));
  return { settings: context.settings, variables: themeVariables(context.settings) };
}
async function digest(orgId: string) {
  const rows = await withTenant({ orgId }, async (tx) => {
    const out: unknown[] = [];
    for (const table of ["sites", "site_settings", "audit_logs", "entries", "entry_drafts", "entry_revisions", "media_assets"]) {
      out.push((await tx.execute(sql`select * from ${sql.identifier(table)} where organization_id = ${orgId} order by 1`)).rows);
    }
    return out;
  });
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

afterAll(() => vi.restoreAllMocks());

describe("saving the appearance", () => {
  it("writes every group to site_settings.theme at the next version, records which groups changed, flushes the site's settings, and the public site is drawn with them", async () => {
    const a = await newTenant();
    const { site, address, ctx } = await newSite(a);
    const before = await getAppearance(ctx);
    expect(before.settings).toEqual(studio.defaults);
    expect(before.variants).toEqual({ header: ["classic", "centered", "minimal"], footer: ["simple", "columns"] });

    const saved = await updateAppearance(ctx, changed, before.version);
    expect(saved).toEqual({ changed: ["colors", "fonts", "header", "footer", "layout"], version: before.version + 1, settings: changed, events: [{ type: "site.configChanged", siteId: site.id }] });
    expect(tagsForAll(saved.events).immediate).toEqual([tags.config(site.id)]);
    const row = await settingsRow(a.org.id, site.id);
    expect(row.theme).toEqual({ ...changed, options: { studio: {} } });
    expect(row.version).toBe(before.version + 1);
    const [record] = await records(a.org.id);
    expect(record).toMatchObject({ actorId: a.user.id, metadata: { name: "Branded", group: "appearance", fields: ["colors", "fonts", "header", "footer", "layout"] } });

    // The public site's settings are read under the tag the save flushes, and drawn with what was saved.
    cache.applied.length = 0;
    const drawn = await drawnWith(a.org.id, site.id, address);
    expect(cache.applied).toContain(tags.config(site.id));
    expect(drawn.settings).toEqual(changed);
    expect(drawn.variables).toMatchObject({ "--forge-color-primary": "#be123c", "--forge-content-width": "72rem", "--forge-radius": "1rem", "--forge-space": "1.2" });
    expect((await getAppearance(ctx)).settings).toEqual(changed);
  });

  it("changes nothing else: the general, reading and analytics groups, the logo and favicon, the theme, other themes' options; and only the groups that changed are recorded", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    await updateSiteSettings(ctx, "general", { name: "Branded", tagline: "Fresh daily", language: "en", timezone: "UTC", instagram: "https://instagram.com/branded" }, (await getSiteSettings(ctx)).version);
    await updateSiteSettings(ctx, "reading", { blogPath: "news", postsPerPage: "7" }, (await getSiteSettings(ctx)).version);
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.siteSettings).set({ theme: { options: { journal: { kept: true } } } }).where(eq(t.siteSettings.siteId, site.id)));
    const general = await getSiteSettings(ctx);
    const row = await settingsRow(a.org.id, site.id);

    const colors = { ...studio.defaults, tokens: { ...studio.defaults.tokens, colors: { ...studio.defaults.tokens.colors, primary: "#7c3aed" } } };
    const saved = await updateAppearance(ctx, colors, row.version);
    expect(saved.changed).toEqual(["colors"]);
    const after = await settingsRow(a.org.id, site.id);
    expect({ ...after, theme: null, version: null, updatedAt: null }).toEqual({ ...row, theme: null, version: null, updatedAt: null });
    expect((after.theme as { options: unknown }).options).toEqual({ journal: { kept: true }, studio: {} });
    const settings = await getSiteSettings(ctx);
    expect({ general: settings.general, reading: settings.reading, analytics: settings.analytics }).toEqual({ general: general.general, reading: general.reading, analytics: general.analytics });
    expect((await records(a.org.id)).find((row) => (row.metadata as { group: string }).group === "appearance")!.metadata).toMatchObject({ group: "appearance", fields: ["colors"] });

    // The same settings again: nothing written, recorded or flushed.
    const again = await updateAppearance(ctx, colors, saved.version);
    expect(again).toEqual({ changed: [], version: saved.version, settings: colors, events: [] });
    expect(await records(a.org.id)).toHaveLength(3);
  });

  it("refuses what the kit does not allow, keyed by the setting, and writes nothing: a colour that is not one, a font not in the list, an unsafe link, a missing group, an unknown key, a style the theme does not draw", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    const version = await versionOf(ctx);
    const before = await settingsRow(a.org.id, site.id);
    const attempts: [unknown, string, string | RegExp][] = [
      [{ ...changed, tokens: { ...changed.tokens, colors: { ...changed.tokens.colors, primary: "red" } } }, "tokens.colors.primary", "Use a colour like #1d4ed8."],
      [{ ...changed, tokens: { ...changed.tokens, colors: { ...changed.tokens.colors, text: "#000; background:url(x)" } } }, "tokens.colors.text", "Use a colour like #1d4ed8."],
      [{ ...changed, tokens: { ...changed.tokens, fonts: { heading: "comic-sans", body: "lora" } } }, "tokens.fonts.heading", "Choose a font from the list."],
      [{ ...changed, header: { ...changed.header, cta: { label: "Go", href: "javascript:alert(1)" } } }, "header.cta.href", /^Use a path on the site/],
      [{ ...changed, header: { ...changed.header, cta: { label: "", href: "/x" } } }, "header.cta.label", "Give the button a label of 1 to 40 characters."],
      [{ ...changed, header: { ...changed.header, cta: { label: "x".repeat(41), href: "/x" } } }, "header.cta.label", "Give the button a label of 1 to 40 characters."],
      [{ ...changed, footer: { ...changed.footer, copyright: "x".repeat(201) } }, "footer.copyright", "Use at most 200 characters."],
      [{ ...changed, layout: { ...changed.layout, width: "100vw" } }, "layout.width", /./],
      [{ tokens: changed.tokens, header: changed.header, footer: changed.footer }, "layout", /./],
      [{ ...changed, css: "body { display: none }" }, "_form", /./],
      [{ ...changed, options: { journal: {} } }, "_form", /./],
    ];
    for (const [input, path, message] of attempts) {
      const refusal = await refusalOf(() => updateAppearance(ctx, input, version));
      expect(refusal.kind, path).toBe("Validation");
      expect(refusal.fieldErrors?.[path]?.[0], path).toMatch(message);
    }
    // Journal draws one header and one footer: Studio's others are refused for it.
    await chooseTheme(ctx, { theme: "journal" });
    const journal = await refusalOf(() => updateAppearance(ctx, { ...changed, header: { ...changed.header, variant: "minimal" } }, version));
    expect(journal.fieldErrors).toEqual({ "header.variant": ["Journal has no minimal header."], "footer.variant": ["Journal has no columns footer."] });
    expect((await settingsRow(a.org.id, site.id)).theme).toEqual(before.theme);
    expect(await records(a.org.id)).toHaveLength(0);
  });

  it("refuses a save from a page opened before someone else saved (the settings' version), and writes nothing", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    const opened = await versionOf(ctx);
    await updateSiteSettings(ctx, "reading", { blogPath: "journal", postsPerPage: "5" }, opened);
    expect(await refusalOf(() => updateAppearance(ctx, changed, opened))).toMatchObject({ kind: "Conflict", message: SETTINGS_CONFLICT });
    expect((await settingsRow(a.org.id, site.id)).theme).toEqual({});
    // Through the form, the same; a version that is not one is never the right one.
    expect((await submitUpdateAppearance(a.actor, a.org.slug, ctx.site.slug, form(changed, opened))).state).toMatchObject({ status: "error", message: SETTINGS_CONFLICT });
    expect((await submitUpdateAppearance(a.actor, a.org.slug, ctx.site.slug, form(changed))).state).toMatchObject({ status: "error", message: SETTINGS_CONFLICT });
    const ok = await submitUpdateAppearance(a.actor, a.org.slug, ctx.site.slug, form(changed, await versionOf(ctx)));
    expect(ok.state).toMatchObject({ status: "success", message: "Appearance saved. The site shows it now." });
    expect(ok.invalidate).toEqual([{ type: "site.configChanged", siteId: site.id }]);
  });

  it("is for Owners and Admins: Editors, Authors and Viewers are refused, through the service and the form, and nothing changes", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    const admin = await addMember(a.org, "admin");
    await expect(updateAppearance(await resolveSiteContext(admin.actor, a.org.slug, site.slug), changed, await versionOf(ctx))).resolves.toMatchObject({ changed: expect.any(Array) });
    for (const role of ["editor", "author", "viewer"] as const) {
      const member = await addMember(a.org, role);
      const memberCtx = await resolveSiteContext(member.actor, a.org.slug, site.slug);
      expect((await refusalOf(() => updateAppearance(memberCtx, studio.defaults, 1))).kind, role).toBe("Forbidden");
      expect((await refusalOf(() => createAppearancePreview(memberCtx, studio.defaults))).kind, role).toBe("Forbidden");
      expect((await submitUpdateAppearance(member.actor, a.org.slug, site.slug, form(studio.defaults, 1))).refused, role).toBe("Forbidden");
    }
    expect((await settingsRow(a.org.id, site.id)).theme).toEqual({ ...changed, options: { studio: {} } });
  });

  it("one site's appearance is its own: saving one leaves another site of the organization, and its public pages, as they were", async () => {
    const a = await newTenant();
    const one = await newSite(a, "One");
    const two = await newSite(a, "Two");
    const twoBefore = await drawnWith(a.org.id, two.site.id, two.address);
    const saved = await updateAppearance(one.ctx, changed, await versionOf(one.ctx));
    expect(tagsForAll(saved.events).immediate).toEqual([tags.config(one.site.id)]);
    expect(await drawnWith(a.org.id, two.site.id, two.address)).toEqual(twoBefore);
    expect((await settingsRow(a.org.id, two.site.id)).theme).toEqual({});
  });

  it("a site saved before M8-1, or with damaged settings, is drawn with the theme's defaults value by value, and can be saved", async () => {
    const a = await newTenant();
    const { site, address, ctx } = await newSite(a);
    await withTenant({ orgId: a.org.id }, (tx) =>
      tx.update(t.siteSettings).set({ theme: { tokens: { colors: { primary: "#047857", text: "nope" } }, header: { variant: "sideways" } } }).where(eq(t.siteSettings.siteId, site.id)),
    );
    const drawn = await drawnWith(a.org.id, site.id, address);
    expect(drawn.settings.tokens.colors).toEqual({ ...studio.defaults.tokens.colors, primary: "#047857" });
    expect(drawn.settings.header.variant).toBe("classic");
    expect((await getAppearance(ctx)).settings.tokens.colors.primary).toBe("#047857");
    await expect(updateAppearance(ctx, changed, await versionOf(ctx))).resolves.toMatchObject({ changed: ["colors", "fonts", "header", "footer", "layout"] });
  });

  it("a record that cannot be written saves nothing", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    const version = await versionOf(ctx);
    await expect(whileFailing("audit_logs", "insert", () => updateAppearance(ctx, changed, version))).rejects.toThrow();
    expect(await settingsRow(a.org.id, site.id)).toMatchObject({ theme: {}, version });
  });

  it("keeps the logo and favicon controls as they were (M6-4): the logo is set on its own, and not part of these settings", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    await updateAppearance(ctx, changed, await versionOf(ctx));
    // A logo that is not an image of this site is refused, as before.
    expect((await refusalOf(() => setSiteImage(ctx, "logo", "0192f000-0000-7000-8000-000000000001"))).kind).toBe("Validation");
    expect((await settingsRow(a.org.id, site.id)).logoMediaId).toBeNull();
  });
});

describe("the live preview of unsaved settings", () => {
  it("draws the site's home page with the settings in the token, and saves nothing; the public site keeps the saved ones", async () => {
    const a = await newTenant();
    const { site, address, ctx } = await newSite(a);
    const home = (await withTenant({ orgId: a.org.id }, (tx) => tx.select().from(t.siteSettings).where(eq(t.siteSettings.siteId, site.id))))[0]!.homepageEntryId!;
    await saveDraft(ctx, home, 1, { content: { v: 1, doc: { type: "doc", content: [{ type: "paragraph", attrs: { id: "0192f000-0000-7000-8000-0000000000aa" }, content: [{ type: "text", text: "Welcome" }] }] } } });
    await publishEntry(ctx, home, 2);
    const before = await digest(a.org.id);

    const { path, expiresAt } = await createAppearancePreview(ctx, changed);
    expect(path).toMatch(/^\/_forge\/preview\//);
    const token = path.split("/").at(-1)!;
    const claims = verifyAppearanceToken(token, DEVELOPMENT_PREVIEW_SECRET, Date.now())!;
    expect(claims).toMatchObject({ orgId: a.org.id, siteId: site.id, userId: a.user.id, settings: changed });
    expect(new Date(expiresAt).getTime()).toBe(claims.expiresAt * 1000);

    const preview = (await loadAppearancePreview(token))!;
    expect(preview.kind).toBe("appearance");
    expect(preview.locator).toEqual({ kind: "address", address });
    expect(preview.page).toMatchObject({ kind: "entry", entry: { path: "/" } });
    expect(themeFor(renderableSite(preview.site, preview.locator)).context.settings).toEqual(changed);
    expect(await digest(a.org.id)).toBe(before);
    expect((await drawnWith(a.org.id, site.id, address)).settings).toEqual(studio.defaults);
    // Through its action: the same checks as saving.
    expect(await submitAppearancePreview(a.actor, a.org.slug, site.slug, form({ ...changed, layout: { ...changed.layout, width: "huge" } }))).toMatchObject({ ok: false, code: "Validation" });
    expect(await submitAppearancePreview(a.actor, a.org.slug, site.slug, form(changed))).toMatchObject({ ok: true });
  });

  it("works on a site that is not live yet; checks the person's rights again; refuses a changed token, bad settings in a signed one, and an entry's token (and the other way round)", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    const admin = await addMember(a.org, "admin");
    const adminCtx = await resolveSiteContext(admin.actor, a.org.slug, site.slug);
    const token = (await createAppearancePreview(adminCtx, changed)).path.split("/").at(-1)!;
    expect(await loadAppearancePreview(token)).not.toBeNull(); // the site is Coming soon
    await changeMemberRole(a.ctx, { memberId: admin.memberId, role: "editor" });
    expect(await loadAppearancePreview(token)).toBeNull();
    await changeMemberRole(a.ctx, { memberId: admin.memberId, role: "admin" });
    expect(await loadAppearancePreview(token)).not.toBeNull();

    const [payload, signature] = token.split(".") as [string, string];
    expect(await loadAppearancePreview(`${payload}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`)).toBeNull();
    const claims = verifyAppearanceToken(token, DEVELOPMENT_PREVIEW_SECRET, Date.now())!;
    const forged = signAppearanceToken({ ...claims, settings: { ...changed, layout: { ...changed.layout, width: "100vw" } } }, DEVELOPMENT_PREVIEW_SECRET);
    expect(await loadAppearancePreview(forged)).toBeNull();
    expect(await loadAppearancePreview(token, Date.now() + 16 * 60_000)).toBeNull();
    expect(await loadPreview(token)).toBeNull();
    const { entry } = await createEntry(ctx, { type: "page", title: "Page" });
    const entryToken = (await createPreviewLink(ctx, entry.id)).path.split("/").at(-1)!;
    expect(await loadAppearancePreview(entryToken)).toBeNull();
    // A suspended site has no previews.
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.sites).set({ status: "suspended" }).where(eq(t.sites.id, site.id)));
    expect(await loadAppearancePreview(token)).toBeNull();
  });
});
