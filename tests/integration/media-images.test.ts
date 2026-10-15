import { and, eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/modules/auth";
import { createEntry, getEntryForEditor, publishEntry, saveDraft } from "@/modules/content";
import { completeUpload, requestUploads, restoreMedia, trashMedia } from "@/modules/media";
import { createSite, getSiteImages, setSiteImage, submitSetSiteImage } from "@/modules/sites";
import { inTenant, resolveSiteContext, type SiteContext } from "@/modules/tenancy";
import { tags, tagsForAll } from "@/platform/cache";
import { mediaPublicBaseUrl } from "@/platform/config/env";
import * as t from "@/platform/db/schema";
import { withTenant } from "@/platform/db/tenant";
import { type StorageDriver } from "@/platform/storage";
import { setStorageDriverForTests } from "@/platform/storage/get-driver";
import { imageOf, localDriver, pdf, removeTempDirs, send } from "../fixtures/media";
import { addMember, newSlug, newTenant, refusalOf } from "../fixtures/tenants";

// The renderer's reads are `'use cache'`. Outside Next their cache calls do nothing, except that each tag a read
// applies is noted, so the tests can check that trashing or restoring an image flushes the reads that drew it.
const applied = vi.hoisted(() => ({ tags: [] as string[] }));
vi.mock("next/cache", async (original) => ({
  ...(await original<typeof import("next/cache")>()),
  cacheLife: () => {},
  cacheTag: (...names: string[]) => void applied.tags.push(...names),
}));
// The picker's route reads the session; here, the actor a test names.
const session = vi.hoisted(() => ({ actor: null as Actor | null }));
vi.mock("@/modules/auth", async (original) => ({
  ...(await original<typeof import("@/modules/auth")>()),
  getCurrentActor: async () => session.actor ?? { kind: "anonymous" },
}));
const { loadPublicSite, publicPageFor, resolveSite } = await import("@/modules/rendering");
const { GET: pickerGET } = await import("@/app/api/app/media/route");

/**
 * M6-4 against real Postgres (local storage driver, real uploads through the M6-1 protocol and M6-2 processing):
 * the picker's route, images in published content, the featured image, the site's logo and favicon, the cache tags
 * that make trashing and restoring an image show on the public site, and the composite keys that keep every image
 * reference inside its site.
 */

let driver: StorageDriver;
beforeAll(async () => {
  driver = await localDriver();
  setStorageDriverForTests(driver);
});
afterAll(async () => {
  setStorageDriverForTests(null);
  await removeTempDirs();
});

type Tenant = Awaited<ReturnType<typeof newTenant>>;
async function liveSite(tenant: Tenant, name = "Images") {
  const address = newSlug("img");
  const { site } = await createSite(tenant.ctx, { name, address, language: "en", timezone: "UTC" });
  const ctx = await resolveSiteContext(tenant.actor, tenant.org.slug, site.slug);
  await withTenant({ orgId: tenant.org.id }, (tx) => tx.update(t.sites).set({ status: "live" }).where(eq(t.sites.id, site.id)));
  return { site, ctx, address };
}
/** An image uploaded the real way: requested, sent to storage, completed (processed into its variants). */
async function uploaded(ctx: SiteContext, name = "photo.png", bytes?: Uint8Array, type = "image/png") {
  const body = bytes ?? (await imageOf("png", 1800, 1200));
  const { uploads } = await requestUploads(ctx, [{ name, size: body.byteLength, type }]);
  expect(await send(uploads[0]!.upload, body)).toBe(200);
  const outcome = await completeUpload(ctx, uploads[0]!.mediaId);
  expect(outcome.status).toBe("ready");
  return (await rowOf(ctx, uploads[0]!.mediaId))!;
}
const rowOf = async (ctx: SiteContext, id: string) =>
  (await inTenant(ctx, (tx) => tx.select().from(t.mediaAssets).where(and(eq(t.mediaAssets.organizationId, ctx.org.id), eq(t.mediaAssets.id, id)))))[0] ?? null;
const setColumn = (ctx: SiteContext, id: string, values: Partial<typeof t.mediaAssets.$inferInsert>) =>
  withTenant({ orgId: ctx.org.id }, (tx) => tx.update(t.mediaAssets).set(values).where(eq(t.mediaAssets.id, id)));
const imageBlock = (mediaId: string, extra: Record<string, unknown> = {}) => ({
  type: "image", attrs: { id: uuidv7(), v: 1, mediaId, alt: null, caption: null, size: "content", link: null, ...extra },
});
const doc = (...content: unknown[]) => ({ v: 1, doc: { type: "doc", content } });
const versionOf = async (ctx: SiteContext, entryId: string) =>
  (await inTenant(ctx, (tx) => tx.select({ version: t.entryDrafts.version }).from(t.entryDrafts).where(eq(t.entryDrafts.entryId, entryId))))[0]!.version;
async function publish(ctx: SiteContext, entryId: string, draft: Record<string, unknown>) {
  const { version } = await saveDraft(ctx, entryId, await versionOf(ctx, entryId), draft);
  return publishEntry(ctx, entryId, version);
}
const publicSite = async (address: string) => {
  const resolved = (await resolveSite({ kind: "address", address }))!;
  return (await loadPublicSite(resolved.orgId, resolved.siteId))!;
};
async function at(address: string, path: string) {
  const page = await publicPageFor(await publicSite(address), path.slice(1).split("/"));
  if (page?.kind !== "entry") throw new Error(`no entry at ${path}`);
  return page.entry;
}
const urlOf = (key: string) => `${mediaPublicBaseUrl()}/${key}`;

describe("the picker's route (GET /api/app/media)", () => {
  const get = async (actor: Actor | null, params: Record<string, string>) => {
    session.actor = actor;
    try {
      const response = await pickerGET(new Request(`http://localhost:3000/api/app/media?${new URLSearchParams(params)}`));
      return { status: response.status, cache: response.headers.get("cache-control"), body: (await response.json()) as Record<string, unknown> };
    } finally {
      session.actor = null;
    }
  };

  it("images only: ready, untrashed, this site's; thumbnails are the thumb variant, never an original", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    const sibling = await liveSite(a, "Sibling");
    const photo = await uploaded(ctx, "Beach.png");
    const trashed = await uploaded(ctx, "Gone.png");
    await trashMedia(ctx, trashed.id);
    const { uploads } = await requestUploads(ctx, [{ name: "menu.pdf", size: 3_000, type: "application/pdf" }]);
    expect(await send(uploads[0]!.upload, pdf(3_000))).toBe(200);
    await completeUpload(ctx, uploads[0]!.mediaId);
    await requestUploads(ctx, [{ name: "pending.png", size: 100, type: "image/png" }]); // never completed
    await uploaded(sibling.ctx, "Sibling.png");

    const { status, cache, body } = await get(a.actor, { org: a.org.slug, site: site.slug });
    expect([status, cache]).toEqual([200, "no-store"]);
    const items = body.items as { id: string; name: string; thumbUrl: string; width: number; height: number }[];
    expect(items.map((item) => item.name)).toEqual(["Beach.png"]);
    expect(items[0]).toMatchObject({ id: photo.id, width: 1800, height: 1200, thumbUrl: urlOf(photo.variants.find((v) => v.key === "thumb")!.storageKey) });
    expect(JSON.stringify(body)).not.toContain(photo.storageKey); // the original's key: never
    expect(body).toMatchObject({ hasMore: false, canUpload: true });

    expect((await get(a.actor, { org: a.org.slug, site: site.slug, q: "nothing-like-this" })).body.items).toEqual([]);
  });

  it("who may: a member who sees the library (an Author, read-only for a Viewer: 403); another organization or site: 404; no session: 401", async () => {
    const a = await newTenant();
    const { site } = await liveSite(a);
    const b = await newTenant();
    const author = await addMember(a.org, "author");
    const viewer = await addMember(a.org, "viewer");
    expect((await get(author.actor, { org: a.org.slug, site: site.slug })).status).toBe(200);
    expect((await get(viewer.actor, { org: a.org.slug, site: site.slug })).status).toBe(403);
    expect((await get(b.actor, { org: a.org.slug, site: site.slug })).status).toBe(404);
    expect((await get(a.actor, { org: a.org.slug, site: "no-such-site" })).status).toBe(404);
    expect((await get(null, { org: a.org.slug, site: site.slug })).status).toBe(401);
  });
});

describe("an image block on a published page", () => {
  it("drawn from the published revision with the widths it has (real variants), its intrinsic size and alt text; never the thumbnail, logo, favicon or original", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const photo = await uploaded(ctx, "Loaf.png");
    await inTenant(ctx, (tx) => tx.update(t.mediaAssets).set({ altText: "A loaf" }).where(eq(t.mediaAssets.id, photo.id)));
    const { entry } = await createEntry(ctx, { type: "page", title: "Gallery" });
    await publish(ctx, entry.id, { content: doc(imageBlock(photo.id, { caption: "Fresh", size: "wide" })) });

    const shown = await at(address, entry.path);
    const widths = photo.variants.filter((v) => /^w\d+$/.test(v.key));
    expect(widths.map((v) => v.key)).toEqual(["w800", "w1600"]);
    expect(shown.images[photo.id]).toEqual({
      alt: "A loaf", width: 1800, height: 1200, sources: widths.map((v) => ({ url: urlOf(v.storageKey), width: v.width, height: v.height })),
    });
    const json = JSON.stringify(shown);
    for (const key of ["thumb", "logo", "fav32", "fav180"]) expect(json, key).not.toContain(photo.variants.find((v) => v.key === key)!.storageKey);
    expect(json).not.toContain(photo.storageKey);

    // The draft after it is not what the public sees.
    const other = await uploaded(ctx, "Other.png");
    await saveDraft(ctx, entry.id, await versionOf(ctx, entry.id), { content: doc(imageBlock(other.id)) });
    expect(Object.keys((await at(address, entry.path)).images)).toEqual([photo.id]);
  });

  it("stable block ids: saving, publishing and saving again keep each block's id", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const photo = await uploaded(ctx);
    const { entry } = await createEntry(ctx, { type: "page", title: "Ids" });
    const block = imageBlock(photo.id, { alt: "Ours" });
    const content = doc(block);
    await publish(ctx, entry.id, { content });
    await saveDraft(ctx, entry.id, await versionOf(ctx, entry.id), { content: doc(block, imageBlock(photo.id, { size: "full" })) });
    const shown = await at(address, entry.path);
    expect((shown.content as { doc: { content: { attrs: { id: string } }[] } }).doc.content[0]!.attrs.id).toBe(block.attrs.id);
    const editor = await getEntryForEditor(ctx, entry.id, "page");
    expect((editor.draft.content as { doc: { content: { attrs: { id: string } }[] } }).doc.content[0]!.attrs.id).toBe(block.attrs.id);
  });

  it("refused when saved: a PDF, another site's image, a pending upload, a trashed one; nothing saved", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const sibling = await liveSite(a, "Sibling");
    const { entry } = await createEntry(ctx, { type: "page", title: "Refusals" });
    const { uploads } = await requestUploads(ctx, [{ name: "menu.pdf", size: 3_000, type: "application/pdf" }, { name: "late.png", size: 100, type: "image/png" }]);
    expect(await send(uploads[0]!.upload, pdf(3_000))).toBe(200);
    await completeUpload(ctx, uploads[0]!.mediaId);
    const trashed = await uploaded(ctx);
    await trashMedia(ctx, trashed.id);
    const cases = { pdf: uploads[0]!.mediaId, pending: uploads[1]!.mediaId, trashed: trashed.id, otherSite: (await uploaded(sibling.ctx)).id };
    for (const [name, mediaId] of Object.entries(cases)) {
      const refusal = await refusalOf(() => saveDraft(ctx, entry.id, 1, { content: doc(imageBlock(mediaId)) }));
      expect(refusal, name).toMatchObject({ kind: "Validation", fieldErrors: { content: ["An image is not one of this site's."] } });
    }
    expect(await versionOf(ctx, entry.id)).toBe(1);
  });

  it("trash: the page's read is tagged with the image and the trash flushes that tag at once; the image is gone from the page, the rest stays; restore brings it back", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const photo = await uploaded(ctx);
    const { entry } = await createEntry(ctx, { type: "page", title: "Trash" });
    await publish(ctx, entry.id, { content: doc(imageBlock(photo.id)) });

    applied.tags.length = 0;
    expect(Object.keys((await at(address, entry.path)).images)).toEqual([photo.id]);
    expect(applied.tags).toContain(tags.media(photo.id));

    const trashed = await trashMedia(ctx, photo.id);
    expect(tagsForAll(trashed.events).immediate).toEqual(expect.arrayContaining([tags.media(photo.id), tags.siteMedia(ctx.site.id)]));
    const after = await at(address, entry.path);
    expect(after.images).toEqual({});
    expect((after.content as { doc: { content: unknown[] } }).doc.content).toHaveLength(1); // the block is still published: drawn as nothing

    const restored = await restoreMedia(ctx, photo.id);
    expect(tagsForAll(restored.events).immediate).toEqual(expect.arrayContaining([tags.media(photo.id), tags.siteMedia(ctx.site.id)]));
    expect(Object.keys((await at(address, entry.path)).images)).toEqual([photo.id]);
  });

  it("a page drawing more images than it tags one by one is tagged with the site's media, which every image change flushes", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const photo = await uploaded(ctx);
    // 51 images of the site: the uploaded one's row, copied (the variants are the same objects; only the reads matter here).
    const copies = await withTenant({ orgId: ctx.org.id }, (tx) =>
      tx
        .insert(t.mediaAssets)
        .values(Array.from({ length: 50 }, () => ({ ...photo, id: uuidv7(), storageKey: `${photo.storageKey}.${uuidv7()}`, createdAt: undefined, updatedAt: undefined })))
        .returning({ id: t.mediaAssets.id }),
    );
    const ids = [photo.id, ...copies.map((row) => row.id)];
    const { entry } = await createEntry(ctx, { type: "page", title: "Many" });
    await publish(ctx, entry.id, { content: doc(...ids.map((id) => imageBlock(id))) });

    applied.tags.length = 0;
    expect(Object.keys((await at(address, entry.path)).images)).toHaveLength(51);
    expect(applied.tags).toContain(tags.siteMedia(ctx.site.id));
    expect(applied.tags.filter((tag) => tag.startsWith("media:"))).toEqual([]);
    expect(tagsForAll((await trashMedia(ctx, copies[7]!.id)).events).immediate).toContain(tags.siteMedia(ctx.site.id));
    expect(Object.keys((await at(address, entry.path)).images)).toHaveLength(50);
  });

  it("the editor shows a thumbnail for each image it holds that is still usable, and nothing for one that is not", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const kept = await uploaded(ctx, "Kept.png");
    const gone = await uploaded(ctx, "Gone.png");
    const { entry } = await createEntry(ctx, { type: "page", title: "Editor" });
    await saveDraft(ctx, entry.id, 1, { content: doc(imageBlock(kept.id), imageBlock(gone.id)) });
    await trashMedia(ctx, gone.id);
    const editor = await getEntryForEditor(ctx, entry.id, "page");
    expect(editor.images).toEqual({
      [kept.id]: { id: kept.id, name: "Kept.png", altText: "", thumbUrl: urlOf(kept.variants.find((v) => v.key === "thumb")!.storageKey), width: 1800, height: 1200 },
    });
  });
});

describe("a post's featured image", () => {
  it("saved through the draft, published with it, drawn in the post from its widths; removed the same way", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const photo = await uploaded(ctx, "Cover.png");
    const { entry } = await createEntry(ctx, { type: "post", title: "Rye season" });
    await saveDraft(ctx, entry.id, 1, { featuredMediaId: photo.id });
    expect((await getEntryForEditor(ctx, entry.id, "post")).images[photo.id]?.name).toBe("Cover.png");
    await publishEntry(ctx, entry.id, 2);

    applied.tags.length = 0;
    const shown = await at(address, entry.path);
    expect(shown.featuredImage).toMatchObject({ width: 1800, height: 1200, sources: [{ width: 800 }, { width: 1600 }] });
    expect(applied.tags).toContain(tags.media(photo.id));

    await trashMedia(ctx, photo.id);
    expect((await at(address, entry.path)).featuredImage).toBeNull();
    await restoreMedia(ctx, photo.id);
    expect((await at(address, entry.path)).featuredImage).not.toBeNull();

    await publish(ctx, entry.id, { featuredMediaId: null });
    expect((await at(address, entry.path)).featuredImage).toBeNull();
  });

  it("refused: a PDF, another site's image, one of another organization, a trashed one; a page has none", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const sibling = await liveSite(a, "Sibling");
    const b = await newTenant();
    const other = await liveSite(b, "Other");
    const { entry } = await createEntry(ctx, { type: "post", title: "Refused" });
    const { uploads } = await requestUploads(ctx, [{ name: "menu.pdf", size: 3_000, type: "application/pdf" }]);
    expect(await send(uploads[0]!.upload, pdf(3_000))).toBe(200);
    await completeUpload(ctx, uploads[0]!.mediaId);
    const trashed = await uploaded(ctx);
    await trashMedia(ctx, trashed.id);
    const cases = { pdf: uploads[0]!.mediaId, otherSite: (await uploaded(sibling.ctx)).id, otherOrg: (await uploaded(other.ctx)).id, trashed: trashed.id };
    for (const [name, mediaId] of Object.entries(cases)) {
      expect(await refusalOf(() => saveDraft(ctx, entry.id, 1, { featuredMediaId: mediaId })), name).toMatchObject({ kind: "Validation", fieldErrors: { featuredMediaId: expect.any(Array) } });
    }
    const page = (await createEntry(ctx, { type: "page", title: "A page" })).entry;
    const image = await uploaded(ctx);
    expect((await refusalOf(() => saveDraft(ctx, page.id, 1, { featuredMediaId: image.id }))).kind).toBe("Validation");
  });
});

describe("the site's logo and favicon", () => {
  it("set from an image of the site; read by the public site as the logo variant and the favicons; recorded; flushed with the settings", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const logo = await uploaded(ctx, "Logo.png", await imageOf("png", 1200, 300));
    const icon = await uploaded(ctx, "Icon.png", await imageOf("png", 512, 512));

    expect(await setSiteImage(ctx, "logo", logo.id)).toEqual({ changed: true, events: [{ type: "site.configChanged", siteId: ctx.site.id }] });
    expect(await setSiteImage(ctx, "favicon", icon.id)).toMatchObject({ changed: true });
    expect(await setSiteImage(ctx, "logo", logo.id)).toEqual({ changed: false, events: [] }); // the same again: nothing

    const variant = (row: typeof logo, key: string) => row.variants.find((v) => v.key === key)!;
    applied.tags.length = 0;
    const site = await publicSite(address);
    expect(site.imagery).toEqual({
      logo: { url: urlOf(variant(logo, "logo").storageKey), width: 640, height: 160 },
      favicon: { url32: urlOf(variant(icon, "fav32").storageKey), url180: urlOf(variant(icon, "fav180").storageKey) },
    });
    expect(applied.tags).toEqual(expect.arrayContaining([tags.config(ctx.site.id), tags.media(logo.id), tags.media(icon.id)]));
    expect(variant(icon, "fav32").storageKey).toMatch(/\/fav32\/icon\.png$/);

    const records = await inTenant(ctx, (tx) => tx.select().from(t.auditLogs).where(and(eq(t.auditLogs.organizationId, ctx.org.id), eq(t.auditLogs.action, "site.settings_changed"))));
    expect(records.map((r) => r.metadata).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))).toEqual([
      { name: "Images", group: "images", fields: ["favicon"] },
      { name: "Images", group: "images", fields: ["logo"] },
    ]);
    expect(await getSiteImages(ctx)).toMatchObject({ logo: { mediaId: logo.id, preview: { name: "Logo.png" } }, favicon: { mediaId: icon.id, preview: { name: "Icon.png" } } });

    // Trashed: the site shows no logo (the trash flushes media:{id}); restored: back. Removed: none.
    await trashMedia(ctx, logo.id);
    expect((await publicSite(address)).imagery.logo).toBeNull();
    expect((await getSiteImages(ctx)).logo).toEqual({ mediaId: logo.id, preview: null });
    await restoreMedia(ctx, logo.id);
    expect((await publicSite(address)).imagery.logo).not.toBeNull();
    expect(await setSiteImage(ctx, "logo", null)).toMatchObject({ changed: true });
    expect((await publicSite(address)).imagery).toMatchObject({ logo: null, favicon: { url32: expect.any(String) } });
  });

  it("refused: a PDF, another site's or organization's image, a trashed or pending one, an image without the role's variants (uploaded before M6-4), not an id", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const sibling = await liveSite(a, "Sibling");
    const b = await newTenant();
    const other = await liveSite(b, "Other");
    const { uploads } = await requestUploads(ctx, [{ name: "menu.pdf", size: 3_000, type: "application/pdf" }, { name: "late.png", size: 100, type: "image/png" }]);
    expect(await send(uploads[0]!.upload, pdf(3_000))).toBe(200);
    await completeUpload(ctx, uploads[0]!.mediaId);
    const trashed = await uploaded(ctx);
    await trashMedia(ctx, trashed.id);
    const older = await uploaded(ctx);
    await setColumn(ctx, older.id, { variants: older.variants.filter((v) => !["logo", "fav32", "fav180"].includes(v.key)) });
    const cases = {
      pdf: uploads[0]!.mediaId, pending: uploads[1]!.mediaId, trashed: trashed.id, otherSite: (await uploaded(sibling.ctx)).id, otherOrg: (await uploaded(other.ctx)).id,
      nothing: uuidv7(),
    };
    for (const role of ["logo", "favicon"] as const) {
      for (const [name, mediaId] of Object.entries(cases)) {
        expect(await refusalOf(() => setSiteImage(ctx, role, mediaId)), `${role}: ${name}`).toMatchObject({ kind: "Validation", fieldErrors: { [role]: ["Choose an image of this site's media library."] } });
      }
      expect((await refusalOf(() => setSiteImage(ctx, role, older.id))).fieldErrors?.[role]?.[0]).toMatch(/uploaded before .* could be made from it/);
      expect((await refusalOf(() => setSiteImage(ctx, role, "not-an-id"))).kind).toBe("Validation");
    }
    expect(await getSiteImages(ctx)).toEqual({ logo: { mediaId: null, preview: null }, favicon: { mediaId: null, preview: null } });
  });

  it("who may: Owners and Admins (`site.settings.manage`); an Editor is refused, through the form too, and nothing changes", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    const image = await uploaded(ctx);
    const admin = await addMember(a.org, "admin");
    const editor = await addMember(a.org, "editor");
    const adminCtx = await resolveSiteContext(admin.actor, a.org.slug, site.slug);
    const editorCtx = await resolveSiteContext(editor.actor, a.org.slug, site.slug);
    expect((await refusalOf(() => setSiteImage(editorCtx, "logo", image.id))).kind).toBe("Forbidden");
    expect((await refusalOf(() => getSiteImages(editorCtx))).kind).toBe("Forbidden");
    const form = new FormData();
    form.set("mediaId", image.id);
    expect(await submitSetSiteImage(editor.actor, a.org.slug, site.slug, "logo", form)).toMatchObject({ refused: "Forbidden" });
    expect(await submitSetSiteImage(a.actor, a.org.slug, site.slug, "banner", form)).toMatchObject({ refused: "NotFound" });
    expect((await getSiteImages(ctx)).logo.mediaId).toBeNull();
    expect(await submitSetSiteImage(admin.actor, a.org.slug, site.slug, "logo", form)).toMatchObject({ state: { status: "success", message: "Logo saved." } });
    expect((await getSiteImages(adminCtx)).logo.mediaId).toBe(image.id);
  });
});

describe("the composite keys keep every image reference in its site (written around the services too)", () => {
  it("a draft's and an entry's featured image, and the site's logo and favicon, cannot be another site's media", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const sibling = await liveSite(a, "Sibling");
    const foreign = await uploaded(sibling.ctx);
    const { entry } = await createEntry(ctx, { type: "post", title: "Keys" });
    const constraintOf = async (write: () => Promise<unknown>) => {
      try {
        await write();
      } catch (error) {
        const cause = (error as { cause?: { constraint?: string } }).cause ?? (error as { constraint?: string });
        return cause.constraint;
      }
      return "written";
    };
    const tenant = { orgId: a.org.id };
    expect(await constraintOf(() => withTenant(tenant, (tx) => tx.update(t.entryDrafts).set({ featuredMediaId: foreign.id }).where(eq(t.entryDrafts.entryId, entry.id))))).toBe(
      "entry_drafts_featured_media_fk",
    );
    expect(await constraintOf(() => withTenant(tenant, (tx) => tx.update(t.entries).set({ featuredMediaId: foreign.id }).where(eq(t.entries.id, entry.id))))).toBe("entries_featured_media_fk");
    expect(await constraintOf(() => withTenant(tenant, (tx) => tx.update(t.siteSettings).set({ logoMediaId: foreign.id }).where(eq(t.siteSettings.siteId, ctx.site.id))))).toBe("site_settings_logo_fk");
    expect(await constraintOf(() => withTenant(tenant, (tx) => tx.update(t.siteSettings).set({ faviconMediaId: foreign.id }).where(eq(t.siteSettings.siteId, ctx.site.id))))).toBe("site_settings_favicon_fk");
    // The same writes with this site's image succeed: the keys name the site, not a role.
    const own = await uploaded(ctx);
    expect(await constraintOf(() => withTenant(tenant, (tx) => tx.update(t.siteSettings).set({ logoMediaId: own.id }).where(eq(t.siteSettings.siteId, ctx.site.id))))).toBe("written");
    const { rows } = await withTenant(tenant, (tx) => tx.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM site_settings WHERE site_id = ${ctx.site.id} AND logo_media_id = ${own.id}`));
    expect(rows[0]!.count).toBe(1);
  });
});
