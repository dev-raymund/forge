import { and, eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEntry, createTerm, getEntryForEditor, publishEntry, saveDraft, scheduleEntry, toLocalInput, trashEntry, unpublishEntry, updateTerm } from "@/modules/content";
import { mediaUsage, trashMedia } from "@/modules/media";
import { SITE_SEO_DEFAULTS } from "@/modules/seo/shared";
import { createSite, deleteSite, getSeoSettings, getSiteOverview, setSiteStatus, siteSeoPath, submitUpdateSeoSettings, updateSeoSettings } from "@/modules/sites";
import { inTenant, resolveSiteContext, type SiteContext } from "@/modules/tenancy";
import { tags, tagsForAll, type CacheEvent } from "@/platform/cache";
import { resetEnvCache } from "@/platform/config/env";
import * as t from "@/platform/db/schema";
import { withTenant } from "@/platform/db/tenant";
import { asOwner } from "../fixtures/db-failure";
import { createMedia as createMediaRow } from "../fixtures/factories";
import { addMember, newSlug, newTenant, refusalOf } from "../fixtures/tenants";

// The public reads are `'use cache'`: here their cache calls do nothing but note each tag a read applies, so the
// tests can check that every change which alters what search engines are told flushes a tag it was read under.
const applied = vi.hoisted(() => ({ tags: [] as string[] }));
vi.mock("next/cache", async (original) => ({
  ...(await original<typeof import("next/cache")>()),
  cacheLife: () => {},
  cacheTag: (...names: string[]) => void applied.tags.push(...names),
  revalidateTag: () => {},
  updateTag: () => {},
}));
const { indexableSiteAddresses, loadEntry, loadPublicSite, loadSitemapRows, publicPageFor, publicPageSeo, publicStructuredData, resolveSite, seoMetadata, sitemapUrlsOf } =
  await import("@/modules/rendering");

/**
 * M8-4 against real Postgres through PgBouncer: a site's SEO defaults (who may, what is refused, versioned, recorded,
 * flushed), an entry's own SEO (checked on save, published with the revision, its image checked again on reading), the
 * page's metadata and structured data as the renderer resolves them, the sitemap's rows, and the cross-tenant list of
 * indexable sites behind the host's robots.txt (addresses only).
 */

type Tenant = Awaited<ReturnType<typeof newTenant>>;
const ORIGIN = "http://localhost:3000";

async function liveSite(tenant: Tenant, name = "Harbour", status: "live" | "coming_soon" = "live") {
  const address = newSlug("seo");
  const { site } = await createSite(tenant.ctx, { name, address, language: "en", timezone: "UTC" });
  if (status === "live") await withTenant({ orgId: tenant.org.id }, (tx) => tx.update(t.sites).set({ status: "live" }).where(eq(t.sites.id, site.id)));
  return { site, address, ctx: await resolveSiteContext(tenant.actor, tenant.org.slug, site.slug) };
}
const as = (member: { actor: Tenant["actor"] }, org: Tenant["org"], siteSlug: string) => resolveSiteContext(member.actor, org.slug, siteSlug);

/** A ready image with two widths (what a processed upload has, M6-2): only such an image is ever named. */
async function image(ctx: SiteContext) {
  const { media } = await createMediaRow({ orgId: ctx.org.id, siteId: ctx.site.id, userId: ctx.actor.userId });
  const base = media.storageKey.replace(/\/original\.jpg$/, "");
  const variants = [
    { key: "w800", format: "webp" as const, width: 800, height: 450, sizeBytes: 100, storageKey: `${base}/w800/photo.webp` },
    { key: "w1600", format: "webp" as const, width: 1600, height: 900, sizeBytes: 200, storageKey: `${base}/w1600/photo.webp` },
    { key: "thumb", format: "webp" as const, width: 200, height: 200, sizeBytes: 10, storageKey: `${base}/thumb/photo.webp` },
  ];
  await withTenant({ orgId: ctx.org.id }, (tx) => tx.update(t.mediaAssets).set({ width: 3200, height: 1800, variants, altText: "Loaves on a rack" }).where(eq(t.mediaAssets.id, media.id)));
  return { id: media.id, widest: `${ORIGIN}/media/${base}/w1600/photo.webp`, original: media.storageKey };
}
/** A PDF of the site's library: a file, not an image. */
async function pdfOf(ctx: SiteContext) {
  const { media } = await createMediaRow({ orgId: ctx.org.id, siteId: ctx.site.id, userId: ctx.actor.userId });
  await withTenant({ orgId: ctx.org.id }, (tx) => tx.update(t.mediaAssets).set({ kind: "document", mimeType: "application/pdf", originalFilename: "menu.pdf" }).where(eq(t.mediaAssets.id, media.id)));
  return media.id;
}

const draftVersion = async (ctx: SiteContext, entryId: string) =>
  (await inTenant(ctx, (tx) => tx.select({ version: t.entryDrafts.version }).from(t.entryDrafts).where(eq(t.entryDrafts.entryId, entryId))))[0]!.version;
const save = async (ctx: SiteContext, entryId: string, draft: Record<string, unknown>) => saveDraft(ctx, entryId, await draftVersion(ctx, entryId), draft);
/** Saves what is given into the draft, then publishes that version. */
async function publish(ctx: SiteContext, entryId: string, draft: Record<string, unknown> = {}) {
  if (Object.keys(draft).length) await save(ctx, entryId, draft);
  return publishEntry(ctx, entryId, await draftVersion(ctx, entryId));
}
/** Made (under `parentId`, if given), its draft saved with the rest, and published. */
async function published(ctx: SiteContext, type: "page" | "post", title: string, { parentId, ...draft }: Record<string, unknown> = {}) {
  const { entry } = await createEntry(ctx, { type, title, ...(parentId ? { parentId: parentId as string } : {}) });
  const result = await publish(ctx, entry.id, draft);
  return { ...entry, path: result.entry.path, events: result.events };
}
const seoOf = (seo: Record<string, unknown> = {}) => ({ title: "", description: "", canonical: "", ogImageId: null, noindex: false, nofollow: false, ...seo });
const siteSeo = (seo: Record<string, unknown> = {}) => ({ ...SITE_SEO_DEFAULTS, ...seo });
const versionOf = async (ctx: SiteContext) => (await getSeoSettings(ctx)).version;
const records = (ctx: SiteContext) =>
  inTenant(ctx, (tx) => tx.select().from(t.auditLogs).where(and(eq(t.auditLogs.organizationId, ctx.org.id), eq(t.auditLogs.action, "site.settings_changed"))));
const settingsRow = async (ctx: SiteContext) => (await inTenant(ctx, (tx) => tx.select().from(t.siteSettings).where(eq(t.siteSettings.siteId, ctx.site.id))))[0]!;
const form = (seo: unknown, version: number | string) => {
  const data = new FormData();
  data.set("seo", typeof seo === "string" ? seo : JSON.stringify(seo));
  data.set("version", String(version));
  return data;
};

/** A live page as a visitor's request resolves it, and what its head and structured data say. */
async function head(address: string, path: string) {
  applied.tags.length = 0;
  const locator = { kind: "address" as const, address };
  const resolved = (await resolveSite(locator))!;
  const site = (await loadPublicSite(resolved.orgId, resolved.siteId))!;
  const page = (await publicPageFor(site, path === "/" ? [] : path.slice(1).split("/")))!;
  expect(page, path).not.toBeNull();
  const seo = publicPageSeo(site, locator, page);
  return { site, page, seo, metadata: seoMetadata(seo, site), graph: (await publicStructuredData(site, locator, page, seo))["@graph"] as Record<string, unknown>[] };
}
/** Every tag the reads just made were cached under, one of which these events flush at once. */
const flushes = (events: CacheEvent[], read: readonly string[] = applied.tags) => {
  const immediate = tagsForAll(events).immediate;
  return read.some((tag) => immediate.includes(tag));
};
/** Search indexing on for this deployment (the E2E server, production), for one test. */
function allowIndexing() {
  process.env.SEARCH_INDEXING = "allowed";
  resetEnvCache();
}
afterEach(() => {
  delete process.env.SEARCH_INDEXING;
  resetEnvCache();
});

describe("a site's SEO settings", () => {
  it("saved by an Owner: checked, at the next settings version, recorded as the SEO group, flushing the site's config and the host's robots; the same again changes nothing; nothing else touched", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a, "Harbour Bakery");
    const view = await getSeoSettings(ctx);
    expect(view).toMatchObject({ seo: SITE_SEO_DEFAULTS, defaultOgImage: null, site: { name: "Harbour Bakery", status: "live" } });
    const before = await settingsRow(ctx);
    expect((await getSiteOverview(ctx)).checklist.find((item) => item.key === "seo")).toMatchObject({ done: false });
    const picture = await image(ctx);

    const saved = await updateSeoSettings(
      ctx,
      siteSeo({ titleTemplate: "%title% | %site%", defaultDescription: "Bread from the harbour.", defaultOgImageId: picture.id, searchConsoleToken: '<meta name="google-site-verification" content="abc-123_XYZ" />' }),
      view.version,
    );
    expect(saved).toMatchObject({
      changed: ["titleTemplate", "defaultDescription", "defaultOgImage", "searchConsoleToken"], version: view.version + 1,
      seo: { titleTemplate: "%title% | %site%", searchConsoleToken: "abc-123_XYZ" }, events: [{ type: "site.seoChanged", siteId: ctx.site.id }],
    });
    expect(tagsForAll(saved.events).immediate.sort()).toEqual([tags.config(ctx.site.id), tags.robots()].sort());
    const after = await settingsRow(ctx);
    expect(after.seo).toEqual(saved.seo);
    expect({ general: after.general, reading: after.reading, analytics: after.analytics, theme: after.theme, homepage: after.homepageEntryId }).toEqual({
      general: before.general, reading: before.reading, analytics: before.analytics, theme: before.theme, homepage: before.homepageEntryId,
    });
    expect(await records(ctx)).toEqual([
      expect.objectContaining({ resourceType: "site", resourceId: ctx.site.id, siteId: ctx.site.id, metadata: { name: "Harbour Bakery", group: "seo", fields: saved.changed } }),
    ]);
    expect((await getSeoSettings(ctx)).defaultOgImage).toMatchObject({ id: picture.id, name: "photo.jpg" });

    // The overview's checklist: done once anything differs from the defaults, and it links here.
    const seoItem = async () => (await getSiteOverview(ctx)).checklist.find((item) => item.key === "seo");
    expect(await seoItem()).toMatchObject({ done: true, href: siteSeoPath(a.org.slug, ctx.site.slug) });

    // The same values (the token as stored this time), at any version: nothing written, recorded or flushed.
    expect(await updateSeoSettings(ctx, saved.seo, view.version)).toMatchObject({ changed: [], version: saved.version, events: [] });
    expect(await records(ctx)).toHaveLength(1);
    // Discouraging indexing is a change of its own; back to the defaults, the checklist says so again.
    const quiet = await updateSeoSettings(ctx, { ...saved.seo, discourageIndexing: true }, saved.version);
    expect(quiet.changed).toEqual(["discourageIndexing"]);
    await updateSeoSettings(ctx, SITE_SEO_DEFAULTS, quiet.version);
    expect(await seoItem()).toMatchObject({ done: false });
  });

  it("who may: Owners, Admins and Editors; Authors and Viewers may neither read nor save them", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    let version = await versionOf(ctx);
    for (const role of ["admin", "editor"] as const) {
      const member = await as(await addMember(a.org, role), a.org, site.slug);
      expect((await getSeoSettings(member)).version).toBe(version);
      version = (await updateSeoSettings(member, siteSeo({ defaultDescription: `Set by the ${role}` }), version)).version;
    }
    for (const role of ["author", "viewer"] as const) {
      const member = await as(await addMember(a.org, role), a.org, site.slug);
      expect((await refusalOf(() => getSeoSettings(member))).kind, role).toBe("Forbidden");
      expect((await refusalOf(() => updateSeoSettings(member, siteSeo({ discourageIndexing: true }), version))).kind, role).toBe("Forbidden");
    }
    expect((await getSeoSettings(ctx)).seo).toEqual(siteSeo({ defaultDescription: "Set by the editor" }));
  });

  it("refused at the field: a template without %title% or with another token, control characters, too long, a token that could leave its attribute, an unknown key; nothing written", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const version = await versionOf(ctx);
    const refused: [Record<string, unknown>, string][] = [
      [{ titleTemplate: "%site%" }, "titleTemplate"],
      [{ titleTemplate: "%title% %author%" }, "titleTemplate"],
      [{ titleTemplate: "" }, "titleTemplate"],
      [{ titleTemplate: `%title% ${"x".repeat(120)}` }, "titleTemplate"],
      [{ defaultDescription: "Line\u0000break" }, "defaultDescription"],
      [{ defaultDescription: "x".repeat(321) }, "defaultDescription"],
      [{ searchConsoleToken: 'abc" onload="x' }, "searchConsoleToken"],
      [{ searchConsoleToken: "<script>alert(1)</script>" }, "searchConsoleToken"],
      [{ defaultOgImageId: "not-an-id" }, "defaultOgImageId"],
      [{ discourageIndexing: "yes" }, "discourageIndexing"],
    ];
    for (const [change, field] of refused) {
      const refusal = await refusalOf(() => updateSeoSettings(ctx, siteSeo(change), version));
      expect(refusal.kind, JSON.stringify(change)).toBe("Validation");
      expect(Object.keys(refusal.fieldErrors ?? {}), JSON.stringify(change)).toContain(field);
    }
    expect((await refusalOf(() => updateSeoSettings(ctx, { ...siteSeo(), organizationId: uuidv7() }, version))).kind).toBe("Validation");
    expect((await refusalOf(() => updateSeoSettings(ctx, "%title%", version))).kind).toBe("Validation");
    expect((await settingsRow(ctx)).version).toBe(version);
    expect(await records(ctx)).toEqual([]);
  });

  it("a default social image must be a usable image of this site: another site's, a PDF, one in the trash and a missing one are refused", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const sibling = await liveSite(a, "Sibling");
    const other = await liveSite(await newTenant("Other"), "Elsewhere");
    const binned = await image(ctx);
    await trashMedia(ctx, binned.id);
    const version = await versionOf(ctx);
    for (const id of [(await image(sibling.ctx)).id, (await image(other.ctx)).id, await pdfOf(ctx), binned.id, uuidv7()]) {
      expect(await refusalOf(() => updateSeoSettings(ctx, siteSeo({ defaultOgImageId: id }), version)), id).toMatchObject({
        kind: "Validation", fieldErrors: { defaultOgImageId: ["Choose an image of this site."] },
      });
    }
    expect((await getSeoSettings(ctx)).seo.defaultOgImageId).toBeNull();
    // Once saved, an image that goes to the trash is no longer shown as the default, here or on the site.
    const picture = await image(ctx);
    await updateSeoSettings(ctx, siteSeo({ defaultOgImageId: picture.id }), version);
    await trashMedia(ctx, picture.id);
    expect(await getSeoSettings(ctx)).toMatchObject({ seo: { defaultOgImageId: picture.id }, defaultOgImage: null });
    expect((await loadPublicSite(ctx.org.id, ctx.site.id))!.defaultOgImage).toBeNull();
  });

  it("someone else's save since (any settings group) is a Conflict; the form reads the settings as JSON and says what happened", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    const version = await versionOf(ctx);
    await updateSeoSettings(ctx, siteSeo({ defaultDescription: "First" }), version);
    expect(await refusalOf(() => updateSeoSettings(ctx, siteSeo({ defaultDescription: "Second" }), version))).toMatchObject({ kind: "Conflict" });
    expect((await getSeoSettings(ctx)).seo.defaultDescription).toBe("First");

    const ok = await submitUpdateSeoSettings(a.actor, a.org.slug, site.slug, form(siteSeo({ defaultDescription: "Third" }), version + 1));
    expect(ok.state).toMatchObject({ status: "success", message: "SEO settings saved. The site uses them now.", values: { version: String(version + 2) } });
    expect(ok.invalidate).toEqual([{ type: "site.seoChanged", siteId: site.id }]);
    const same = await submitUpdateSeoSettings(a.actor, a.org.slug, site.slug, form(siteSeo({ defaultDescription: "Third" }), version + 2));
    expect(same.state.message).toMatch(/Nothing to save/);
    expect(same.invalidate).toBeUndefined();
    const unreadable = await submitUpdateSeoSettings(a.actor, a.org.slug, site.slug, form("{not json", version + 2));
    expect(unreadable.state).toMatchObject({ status: "error", fieldErrors: { seo: [expect.stringContaining("could not be read")] } });
    const stale = await submitUpdateSeoSettings(a.actor, a.org.slug, site.slug, form(siteSeo({ defaultDescription: "Fourth" }), version));
    expect(stale.state.status).toBe("error");
    expect((await getSeoSettings(ctx)).seo.defaultDescription).toBe("Third");
  });
});

describe("an entry's SEO", () => {
  it("saved with the draft and checked there (an https canonical, an image of this site), published with the revision; the public site reads the published one", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const sibling = await liveSite(a, "Sibling");
    const picture = await image(ctx);
    const { entry: post } = await createEntry(ctx, { type: "post", title: "Rye season" });
    const own = seoOf({ title: "Rye, at last", description: "Dark, sour, best with butter.", canonical: "https://example.com/rye", ogImageId: picture.id, nofollow: true });

    for (const canonical of ["http://example.com/rye", "javascript:alert(1)", "/blog/rye", "https://user:pw@example.com/", 'https://example.com/"><script>']) {
      const refusal = await refusalOf(() => save(ctx, post.id, { seo: seoOf({ canonical }) }));
      expect(refusal.kind, canonical).toBe("Validation");
      expect(JSON.stringify(refusal.fieldErrors), canonical).toContain("https://");
    }
    for (const ogImageId of [(await image(sibling.ctx)).id, await pdfOf(ctx), uuidv7()]) {
      expect(await refusalOf(() => save(ctx, post.id, { seo: seoOf({ ogImageId }) })), ogImageId).toMatchObject({
        kind: "Validation", fieldErrors: { "seo.ogImageId": ["Choose an image of this site."] },
      });
    }
    expect((await refusalOf(() => save(ctx, post.id, { seo: { ...own, robots: "index" } }))).kind).toBe("Validation");
    expect((await refusalOf(() => save(ctx, post.id, { seo: seoOf({ title: "x".repeat(121) }) }))).kind).toBe("Validation");

    await save(ctx, post.id, { seo: own });
    const editor = await getEntryForEditor(ctx, post.id, "post");
    expect(editor.seo).toMatchObject({ own, site: { name: "Harbour", live: true, seo: SITE_SEO_DEFAULTS }, baseUrl: `${ORIGIN}/s/${address}` });
    expect(editor.images[picture.id]).toMatchObject({ id: picture.id, thumbUrl: expect.stringContaining("/thumb/") });
    // Saved is not published.
    expect(await loadEntry(ctx.org.id, ctx.site.id, post.id)).toBeNull();

    await publishEntry(ctx, post.id, await draftVersion(ctx, post.id));
    applied.tags.length = 0;
    const live = (await loadEntry(ctx.org.id, ctx.site.id, post.id))!;
    expect(live.seo).toEqual(own);
    expect(live.ogImage).toMatchObject({ alt: "Loaves on a rack", sources: expect.arrayContaining([expect.objectContaining({ width: 1600, url: picture.widest })]) });
    expect(applied.tags).toContain(tags.media(picture.id));

    // A later draft changes nothing on the site until it is published.
    await save(ctx, post.id, { seo: { ...own, title: "Draft title" } });
    expect((await loadEntry(ctx.org.id, ctx.site.id, post.id))!.seo.title).toBe("Rye, at last");
    // The image in the trash: no longer named, and the trash flushes the read that named it.
    const { events } = await trashMedia(ctx, picture.id);
    expect(flushes(events)).toBe(true);
    expect((await loadEntry(ctx.org.id, ctx.site.id, post.id))!.ogImage).toBeNull();
  });

  it("a social image counts as a use of the file: the trash says which pages and drafts name it, and that it is the site's default", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const picture = await image(ctx);
    expect(await mediaUsage(ctx, picture.id)).toMatchObject({ published: 0, drafts: 0, socialDefault: false });
    await published(ctx, "post", "Shared", { seo: seoOf({ ogImageId: picture.id }) });
    const { entry: draft } = await createEntry(ctx, { type: "page", title: "Draft page" });
    await save(ctx, draft.id, { seo: seoOf({ ogImageId: picture.id }) });
    await updateSeoSettings(ctx, siteSeo({ defaultOgImageId: picture.id }), await versionOf(ctx));
    expect(await mediaUsage(ctx, picture.id)).toEqual({
      published: 1, drafts: 2, publishedTitles: ["Shared"], draftTitles: expect.arrayContaining(["Shared", "Draft page"]), logo: false, favicon: false, socialDefault: true,
    });
  });

  it("a stored value that is not what the editor saves (an old or damaged one) is read value by value: the page still draws, unsafe parts left out", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const post = await published(ctx, "post", "Old one");
    // Revisions are immutable to the app (M7-3): only the owner can damage one.
    await asOwner(async (owner) => {
      await owner.query("begin");
      await owner.query("select set_config('app.org_id', $1, true)", [ctx.org.id]);
      const damaged = { title: "Kept", canonical: "javascript:alert(1)", noindex: "yes", ogImageId: "../../etc" };
      expect((await owner.query("update entry_revisions set seo = $1 where entry_id = $2", [damaged, post.id])).rowCount).toBe(1);
      await owner.query("commit");
    });
    const { metadata } = await head(address, post.path);
    expect(metadata.title).toEqual({ absolute: "Kept" });
    expect(metadata.alternates).toEqual({ canonical: `${ORIGIN}/s/${address}${post.path}` });
    expect(JSON.stringify(metadata)).not.toContain("javascript:");
  });
});

describe("the page's metadata and structured data", () => {
  it("built from the deployment's origin and the site's address: title by template, description, canonical, Open Graph, Twitter, verification; robots as this deployment allows", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a, "Harbour");
    const base = `${ORIGIN}/s/${address}`;
    const fallback = await image(ctx);
    const version = await versionOf(ctx);
    await updateSeoSettings(ctx, siteSeo({ titleTemplate: "%title% | %site%", defaultDescription: "Bread from the harbour.", defaultOgImageId: fallback.id, searchConsoleToken: "tok_123" }), version);
    const about = await published(ctx, "page", "About us");

    // Not production (as in tests and on the dev server): never indexed, whatever the rest says.
    expect((await head(address, about.path)).metadata.robots).toEqual({ index: false, follow: true });

    allowIndexing();
    const { metadata } = await head(address, about.path);
    expect(metadata).toMatchObject({
      title: { absolute: "About us | Harbour" },
      description: "Bread from the harbour.",
      alternates: { canonical: `${base}/about-us` },
      robots: { index: true, follow: true },
      openGraph: { type: "website", title: "About us | Harbour", url: `${base}/about-us`, siteName: "Harbour", locale: "en", images: [{ url: fallback.widest, width: 1600, height: 900, alt: "Loaves on a rack" }] },
      twitter: { card: "summary_large_image", title: "About us | Harbour", images: [{ url: fallback.widest, alt: "Loaves on a rack" }] },
      verification: { google: "tok_123" },
    });
    expect(JSON.stringify(metadata)).not.toContain(fallback.original);
    // The home page shows the site's name; its canonical is the site's address.
    expect((await head(address, "/")).metadata).toMatchObject({ title: { absolute: "Harbour" }, alternates: { canonical: base } });

    // The entry's own robots, then the site's: discouraging indexing makes every page noindex.
    await publish(ctx, about.id, { seo: seoOf({ nofollow: true }) });
    expect((await head(address, about.path)).metadata.robots).toEqual({ index: true, follow: false });
    await updateSeoSettings(ctx, siteSeo({ titleTemplate: "%title% | %site%", defaultDescription: "Bread from the harbour.", defaultOgImageId: fallback.id, searchConsoleToken: "tok_123", discourageIndexing: true }), version + 1);
    expect((await head(address, about.path)).metadata.robots).toEqual({ index: false, follow: false });
    // Coming soon: noindex, nofollow.
    await updateSeoSettings(ctx, siteSeo(), version + 2);
    await withTenant({ orgId: ctx.org.id }, (tx) => tx.update(t.sites).set({ status: "coming_soon" }).where(eq(t.sites.id, ctx.site.id)));
    const site = (await loadPublicSite(ctx.org.id, ctx.site.id))!;
    const page = (await publicPageFor(site, ["about-us"]))!;
    expect(publicPageSeo(site, { kind: "address", address }, page).robots).toMatchObject({ index: false, follow: false });
  });

  it("the social image: the entry's own, else a post's featured image, else the site's default; one in the trash is passed over", async () => {
    allowIndexing();
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const [fallback, featured, own] = [await image(ctx), await image(ctx), await image(ctx)];
    await updateSeoSettings(ctx, siteSeo({ defaultOgImageId: fallback.id }), await versionOf(ctx));
    const post = await published(ctx, "post", "With everything", { featuredMediaId: featured.id, seo: seoOf({ ogImageId: own.id }) });
    const plain = await published(ctx, "post", "Featured only", { featuredMediaId: featured.id });
    const page = await published(ctx, "page", "A page");
    const imageAt = async (path: string) => ((await head(address, path)).metadata.openGraph as { images?: { url: string }[] }).images?.[0]?.url;

    expect(await imageAt(post.path)).toBe(own.widest);
    expect(await imageAt(plain.path)).toBe(featured.widest);
    expect(await imageAt(page.path)).toBe(fallback.widest);
    await trashMedia(ctx, own.id);
    expect(await imageAt(post.path)).toBe(featured.widest);
    await trashMedia(ctx, featured.id);
    expect(await imageAt(post.path)).toBe(fallback.widest);
    await trashMedia(ctx, fallback.id);
    expect(await imageAt(post.path)).toBeUndefined();
    expect((await head(address, post.path)).metadata.twitter).toMatchObject({ card: "summary" });
  });

  it("structured data: the site, its publisher, the page (a post as a BlogPosting) and breadcrumbs of live, published titles; no internal id", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a, "Harbour");
    const base = `${ORIGIN}/s/${address}`;
    const about = await published(ctx, "page", "About us");
    const team = await published(ctx, "page", "Our team", { parentId: about.id });
    const { term: bread } = await createTerm(ctx, { taxonomy: "category", name: "Bread" });
    const post = await published(ctx, "post", "Rye </script><b>season", { termIds: [bread.id], excerpt: "Dark rye." });

    const crumbs = (graph: Record<string, unknown>[]) =>
      ((graph.find((node) => node["@type"] === "BreadcrumbList")?.itemListElement ?? []) as { name: string; item: string }[]).map((item) => [item.name, item.item]);
    const teamGraph = (await head(address, team.path)).graph;
    expect(teamGraph.map((node) => node["@type"])).toEqual(["WebSite", "Organization", "WebPage", "BreadcrumbList"]);
    expect(crumbs(teamGraph)).toEqual([["Harbour", base], ["About us", `${base}/about-us`], ["Our team", `${base}/about-us/our-team`]]);

    const postHead = await head(address, post.path);
    expect(postHead.graph.find((node) => node["@type"] === "BlogPosting")).toMatchObject({ headline: "Rye </script><b>season", url: `${base}${post.path}`, description: "Dark rye." });
    expect(crumbs(postHead.graph)).toEqual([["Harbour", base], ["Blog", `${base}/blog`], ["Rye </script><b>season", `${base}${post.path}`]]);
    const archive = await head(address, "/blog/category/bread");
    expect(crumbs(archive.graph)).toEqual([["Harbour", base], ["Blog", `${base}/blog`], ["Bread", `${base}/blog/category/bread`]]);
    const serialized = JSON.stringify([teamGraph, postHead.graph, archive.graph]);
    for (const id of [ctx.org.id, ctx.site.id, about.id, team.id, post.id, bread.id]) expect(serialized).not.toContain(id);

    // A parent taken off the site leaves the breadcrumbs, and the change flushes the read that named it.
    await head(address, team.path);
    const reads = [...applied.tags];
    const { events } = await unpublishEntry(ctx, about.id);
    expect(flushes(events, reads)).toBe(true);
  });
});

describe("the sitemap's rows", () => {
  it("the live entries that are indexable and their own canonical, the blog and the categories and tags with live posts; never drafts, scheduled, trashed, noindex, canonical elsewhere, empty terms or another site's", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const sibling = await liveSite(a, "Sibling");
    const base = `${ORIGIN}/s/${address}`;
    const { term: bread } = await createTerm(ctx, { taxonomy: "category", name: "Bread" });
    const { term: empty } = await createTerm(ctx, { taxonomy: "tag", name: "Empty" });
    const { term: draftOnly } = await createTerm(ctx, { taxonomy: "tag", name: "Draft only" });

    const about = await published(ctx, "page", "About us");
    const post = await published(ctx, "post", "Rye season", { termIds: [bread.id] });
    await published(ctx, "page", "Hidden", { seo: seoOf({ noindex: true }) });
    await published(ctx, "page", "Copy", { seo: seoOf({ canonical: "https://elsewhere.example/original" }) });
    await published(ctx, "page", "Self");
    await createEntry(ctx, { type: "post", title: "Just a draft" }).then(({ entry }) => save(ctx, entry.id, { termIds: [draftOnly.id] }));
    const { entry: later } = await createEntry(ctx, { type: "post", title: "Later" });
    await scheduleEntry(ctx, later.id, { runAt: toLocalInput(new Date(Date.now() + 2 * 86_400_000), "UTC"), version: await draftVersion(ctx, later.id) });
    const binned = await published(ctx, "post", "Binned", { termIds: [draftOnly.id] });
    await unpublishEntry(ctx, binned.id);
    await trashEntry(ctx, binned.id);
    await published(sibling.ctx, "page", "Not this site");

    applied.tags.length = 0;
    const rows = await loadSitemapRows(ctx.org.id, ctx.site.id, "en");
    expect([...new Set(applied.tags)].sort()).toEqual([tags.site(ctx.site.id), tags.routes(ctx.site.id), tags.list(ctx.site.id, "post"), tags.list(ctx.site.id, "page")].sort());
    expect(rows.terms).toEqual([{ taxonomy: "category", slug: bread.slug, lastmod: null }]);
    // An entry that names its own address as its canonical is listed (here the origin is http, which an entry may not name).
    const urls = sitemapUrlsOf({ ...rows, entries: rows.entries.map((entry) => (entry.path === "/self" ? { ...entry, canonical: `${base}/self` } : entry)) }, base, "blog");
    expect(urls.map((url) => url.loc)).toEqual([base, `${base}/about-us`, `${base}/blog/rye-season`, `${base}/self`, `${base}/blog`, `${base}/blog/category/bread`]);
    expect(urls.find((url) => url.loc === `${base}/about-us`)!.lastmod).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(urls)).not.toContain(empty.slug);
    expect(JSON.stringify(rows)).not.toMatch(new RegExp([about.id, post.id, ctx.site.id].join("|")));
  });

  it("what changes the list flushes it: publishing (a new entry, or noindex), a term's change, unpublishing (the trash comes after it)", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const { term: bread } = await createTerm(ctx, { taxonomy: "category", name: "Bread" });
    const read = async () => {
      applied.tags.length = 0;
      await loadSitemapRows(ctx.org.id, ctx.site.id, "en");
      return [...applied.tags];
    };
    let reads = await read();
    const post = await published(ctx, "post", "Rye", { termIds: [bread.id] });
    expect(flushes(post.events, reads)).toBe(true);
    reads = await read();
    expect(flushes((await publish(ctx, post.id, { seo: seoOf({ noindex: true }) })).events, reads)).toBe(true);
    reads = await read();
    expect(flushes((await updateTerm(ctx, bread.id, { name: "Loaves", slug: "loaves" })).events, reads)).toBe(true);
    reads = await read();
    expect(flushes((await unpublishEntry(ctx, post.id)).events, reads)).toBe(true);
  });
});

describe("the indexable sites behind the host's robots.txt (across organizations, addresses only)", () => {
  it("live sites that allow indexing; not Coming soon, not discouraging, not deleted; and each such change flushes the list", async () => {
    const [a, b] = [await newTenant(), await newTenant("Other")];
    const live = await liveSite(a, "Live");
    const theirs = await liveSite(b, "Theirs");
    const soon = await liveSite(a, "Soon", "coming_soon");
    const quiet = await liveSite(b, "Quiet");
    const doomed = await liveSite(a, "Doomed");
    await updateSeoSettings(quiet.ctx, siteSeo({ discourageIndexing: true }), await versionOf(quiet.ctx));
    const listed = async () => {
      applied.tags.length = 0;
      const addresses = await indexableSiteAddresses("localhost");
      return { addresses, reads: [...applied.tags] };
    };

    let now = await listed();
    expect(now.reads.sort()).toEqual([tags.host("localhost"), tags.robots()].sort());
    expect(now.addresses).toEqual(expect.arrayContaining([live.address, theirs.address, doomed.address]));
    expect(now.addresses).not.toContain(soon.address);
    expect(now.addresses).not.toContain(quiet.address);
    expect(now.addresses.every((address) => /^[a-z0-9-]+$/.test(address))).toBe(true);

    const { events: deleted } = await deleteSite(doomed.ctx);
    expect(flushes(deleted, now.reads)).toBe(true);
    now = await listed();
    expect(now.addresses).not.toContain(doomed.address);

    const goneQuiet = await updateSeoSettings(live.ctx, siteSeo({ discourageIndexing: true }), await versionOf(live.ctx));
    expect(flushes(goneQuiet.events, now.reads)).toBe(true);
    now = await listed();
    expect(now.addresses).not.toContain(live.address);

    const { events: wentLive } = await setSiteStatus(soon.ctx, { status: "live" });
    expect(flushes(wentLive, now.reads)).toBe(true);
    expect((await listed()).addresses).toContain(soon.address);
  });

  it("forge_app reads nothing else across tenants: the function returns addresses only, and the tables stay behind their policies", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const { rows } = await withTenant({ orgId: uuidv7() }, (tx) => tx.execute(sql`select * from indexable_site_addresses(5)`));
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0]!)).toEqual(["address"]);
    expect(await withTenant({ orgId: uuidv7() }, (tx) => tx.select().from(t.sites).where(eq(t.sites.id, ctx.site.id)))).toEqual([]);
    expect(await withTenant({ orgId: uuidv7() }, (tx) => tx.select().from(t.siteSettings).where(eq(t.siteSettings.siteId, ctx.site.id)))).toEqual([]);
  });
});
