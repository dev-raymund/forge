import { and, eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAILY_JOBS, jobRegistry } from "@/app/api/internal/cron/jobs";
import {
  canSeeLibrary, cleanUpUploads, completeUpload, createFolder, deleteFolder, listLibrary, moveMedia, parseLibraryQuery, purgeTrashedMedia, renameFolder, requestUploads, restoreMedia,
  trashMedia, trashPurge, updateMediaDetails, type LibraryQuery,
} from "@/modules/media";
import { createSite, siteNavItems } from "@/modules/sites";
import { inTenant, resolveSiteContext, type SiteContext } from "@/modules/tenancy";
import * as t from "@/platform/db/schema";
import { withTenant } from "@/platform/db/tenant";
import { platformStorage, type StorageDriver } from "@/platform/storage";
import { setStorageDriverForTests } from "@/platform/storage/get-driver";
import { whileFailing } from "../fixtures/db-failure";
import { failing, imageOf, localDriver, removeTempDirs, send } from "../fixtures/media";
import { addMember, newSlug, newTenant, refusalOf } from "../fixtures/tenants";

/**
 * M6-3 against real Postgres (local storage driver): the library's reads and changes. Every query names the
 * organization and the site; RLS alone would not keep two sites of one organization apart. Each change is checked
 * for who may make it, recorded in its own transaction, and returns the cache events it makes true.
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
async function siteOf(tenant: Tenant, name = "Library") {
  const { site } = await createSite(tenant.ctx, { name, address: newSlug("lib"), language: "en", timezone: "UTC" });
  return { site, ctx: await resolveSiteContext(tenant.actor, tenant.org.slug, site.slug) };
}
const asRole = async (tenant: Tenant, site: { slug: string }, role: "admin" | "editor" | "author" | "viewer") => {
  const member = await addMember(tenant.org, role);
  return { userId: member.user.id, ctx: await resolveSiteContext(member.actor, tenant.org.slug, site.slug) };
};
const query = (over: Partial<LibraryQuery> = {}): LibraryQuery => ({ ...parseLibraryQuery({}), ...over });
const rowOf = async (ctx: SiteContext, id: string) =>
  (await inTenant(ctx, (tx) => tx.select().from(t.mediaAssets).where(and(eq(t.mediaAssets.organizationId, ctx.org.id), eq(t.mediaAssets.id, id)))))[0] ?? null;
const events = (ctx: SiteContext, action: string) =>
  inTenant(ctx, (tx) => tx.select().from(t.auditLogs).where(and(eq(t.auditLogs.organizationId, ctx.org.id), eq(t.auditLogs.action, action))));
const names = (library: { items: { title: string; filename: string }[] }) => library.items.map((item) => item.title || item.filename);

/** A ready item, as the protocol leaves one (variants named on the row), made directly: the protocol has its own tests. */
async function ready(ctx: SiteContext, values: { filename: string; kind?: "image" | "document"; title?: string; altText?: string; size?: number; folderId?: string | null; by?: string | null; ageMinutes?: number }) {
  const id = uuidv7();
  const kind = values.kind ?? "image";
  const base = `o/${ctx.org.id}/s/${ctx.site.id}/m/${id}/v1`;
  const variants = kind === "image"
    ? [
        { key: "thumb", format: "webp" as const, width: 400, height: 400, sizeBytes: 100, storageKey: `${base}/thumb/x.webp` },
        { key: "w800", format: "webp" as const, width: 800, height: 600, sizeBytes: 300, storageKey: `${base}/w800/x.webp` },
        { key: "w1600", format: "webp" as const, width: 1600, height: 1200, sizeBytes: 900, storageKey: `${base}/w1600/x.webp` },
      ]
    : [];
  await withTenant({ orgId: ctx.org.id }, (tx) =>
    tx.insert(t.mediaAssets).values({
      id, organizationId: ctx.org.id, siteId: ctx.site.id, kind, status: "ready", storageKey: `${base}/original/x.${kind === "image" ? "jpg" : "pdf"}`,
      originalFilename: values.filename, mimeType: kind === "image" ? "image/jpeg" : "application/pdf", sizeBytes: values.size ?? 1_000, variants,
      variantBytes: variants.reduce((sum, v) => sum + v.sizeBytes, 0), width: kind === "image" ? 1600 : null, height: kind === "image" ? 1200 : null,
      title: values.title ?? "", altText: values.altText ?? "", folderId: values.folderId ?? null, uploadedBy: values.by === undefined ? ctx.actor.userId : values.by,
      createdAt: sql`now() - make_interval(mins => ${values.ageMinutes ?? 0})`,
    }),
  );
  return id;
}

describe("uploading into a folder", () => {
  it("into a folder of this site; not into another site's or another organization's, and then nothing is reserved", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const { ctx: sibling } = await siteOf(a, "Sibling");
    const b = await newTenant("Other");
    const { ctx: elsewhere } = await siteOf(b);
    const { folder } = await createFolder(ctx, { name: "Events" });
    const { folder: theirs } = await createFolder(sibling, { name: "Theirs" });
    const { folder: foreign } = await createFolder(elsewhere, { name: "Foreign" });
    const file = [{ name: "a.png", size: 10, type: "image/png" }];

    const { uploads } = await requestUploads(ctx, file, { folderId: folder.id });
    expect((await rowOf(ctx, uploads[0]!.mediaId))!.folderId).toBe(folder.id);
    for (const none of [undefined, null, ""]) {
      const { uploads: [u] } = await requestUploads(ctx, file, { folderId: none });
      expect((await rowOf(ctx, u!.mediaId))!.folderId, String(none)).toBeNull();
    }
    const count = async () => (await inTenant(ctx, (tx) => tx.select().from(t.mediaAssets).where(eq(t.mediaAssets.siteId, ctx.site.id)))).length;
    const before = await count();
    for (const folderId of [theirs.id, foreign.id, uuidv7(), "not-an-id", 7]) {
      expect(await refusalOf(() => requestUploads(ctx, file, { folderId })), String(folderId)).toMatchObject({ kind: "Validation", fieldErrors: { folderId: ["Choose a folder of this site."] } });
    }
    expect(await count()).toBe(before);
  });

  it("a folder an upload is going into cannot be deleted from under it", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const { folder } = await createFolder(ctx, { name: "Busy" });
    await requestUploads(ctx, [{ name: "a.png", size: 10, type: "image/png" }], { folderId: folder.id });
    expect(await refusalOf(() => deleteFolder(ctx, folder.id))).toMatchObject({ kind: "Conflict", message: "Busy still holds 1 file. Move or trash it first." });
  });

  it("the real protocol into a folder: the ready file is listed there", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const { folder } = await createFolder(ctx, { name: "Photos" });
    const bytes = await imageOf("png", 900, 600);
    const { uploads } = await requestUploads(ctx, [{ name: "beach.png", size: bytes.byteLength, type: "image/png" }], { folderId: folder.id });
    expect(await send(uploads[0]!.upload, bytes)).toBe(200);
    expect((await completeUpload(ctx, uploads[0]!.mediaId)).status).toBe("ready");
    const library = await listLibrary(ctx, query({ folder: folder.id }));
    expect(library.items.map((i) => i.id)).toEqual([uploads[0]!.mediaId]);
    expect(library.items[0]!.thumbUrl).toMatch(/\/thumb\/beach\.webp$/);
    expect(library.folders).toEqual([{ id: folder.id, name: "Photos", files: 1 }]);
  });
});

describe("the library's listing", () => {
  it("only ready files of this site: not pending, refused, trashed (except in the trash), another site's, another organization's", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const { ctx: sibling } = await siteOf(a, "Sibling");
    const b = await newTenant("Other");
    const { ctx: elsewhere } = await siteOf(b);
    const mine = await ready(ctx, { filename: "mine.jpg" });
    const trashed = await ready(ctx, { filename: "trashed.jpg" });
    await trashMedia(ctx, trashed);
    await ready(sibling, { filename: "sibling.jpg" });
    await ready(elsewhere, { filename: "foreign.jpg" });
    await requestUploads(ctx, [{ name: "pending.png", size: 10, type: "image/png" }]);
    await withTenant({ orgId: a.org.id }, (tx) =>
      tx.insert(t.mediaAssets).values({ organizationId: a.org.id, siteId: ctx.site.id, kind: "image", status: "failed", storageKey: `o/${a.org.id}/s/${ctx.site.id}/m/${uuidv7()}/v1/original/f.png`, originalFilename: "failed.png", mimeType: "image/png", sizeBytes: 1 }),
    );
    expect((await listLibrary(ctx, query())).items.map((i) => i.id)).toEqual([mine]);
    expect((await listLibrary(ctx, query({ trash: true }))).items.map((i) => i.id)).toEqual([trashed]);
  });

  it("search over title, file name and alternative text, as typed (% and _ are letters); kind; folder; none", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const { folder } = await createFolder(ctx, { name: "Menus" });
    await ready(ctx, { filename: "IMG_0001.jpg", title: "Beach at dusk" });
    await ready(ctx, { filename: "harbour.jpg", altText: "Boats in the beach harbour" });
    await ready(ctx, { filename: "menu-100%_off.pdf", kind: "document", folderId: folder.id });
    await ready(ctx, { filename: "menu-1000-off.pdf", kind: "document" });
    expect(names(await listLibrary(ctx, query({ q: "beach" }))).sort()).toEqual(["Beach at dusk", "harbour.jpg"]);
    expect(names(await listLibrary(ctx, query({ q: "BEACH AT" })))).toEqual(["Beach at dusk"]);
    expect(names(await listLibrary(ctx, query({ q: "100%_" })))).toEqual(["menu-100%_off.pdf"]);
    expect(names(await listLibrary(ctx, query({ q: "img_0001" })))).toEqual(["Beach at dusk"]);
    expect(names(await listLibrary(ctx, query({ kind: "document" }))).sort()).toEqual(["menu-100%_off.pdf", "menu-1000-off.pdf"]);
    expect(names(await listLibrary(ctx, query({ folder: folder.id })))).toEqual(["menu-100%_off.pdf"]);
    expect(names(await listLibrary(ctx, query({ folder: "none", kind: "document" })))).toEqual(["menu-1000-off.pdf"]);
    // Another site's folder, or one that does not exist, filters nothing in: it is no filter.
    expect((await listLibrary(ctx, query({ folder: uuidv7() }))).items).toHaveLength(4);
  });

  it("sorted by newest, name (title, else file name), size (stored, variants included); pages of 48", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    await ready(ctx, { filename: "b.jpg", size: 5_000, ageMinutes: 3 });
    await ready(ctx, { filename: "zeta.pdf", kind: "document", title: "Alpha", size: 6_000, ageMinutes: 2 });
    await ready(ctx, { filename: "c.jpg", size: 100, ageMinutes: 1 });
    expect(names(await listLibrary(ctx, query()))).toEqual(["c.jpg", "Alpha", "b.jpg"]);
    expect(names(await listLibrary(ctx, query({ sort: "name" })))).toEqual(["Alpha", "b.jpg", "c.jpg"]);
    expect(names(await listLibrary(ctx, query({ sort: "size" })))).toEqual(["b.jpg", "Alpha", "c.jpg"]); // 5,000 + 1,300 > 6,000

    for (let i = 0; i < 47; i++) await ready(ctx, { filename: `bulk-${i}.jpg` });
    const first = await listLibrary(ctx, query());
    expect([first.items.length, first.hasMore]).toEqual([48, true]);
    const second = await listLibrary(ctx, query({ page: 2 }));
    expect([second.items.length, second.hasMore]).toEqual([2, false]);
  });

  it("thumbnails are the square variant and the URL is the widest; a PDF's is its file; the original never", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const image = await ready(ctx, { filename: "photo.jpg" });
    const doc = await ready(ctx, { filename: "menu.pdf", kind: "document" });
    const { items, storage } = await listLibrary(ctx, query());
    const [photo, menu] = [items.find((i) => i.id === image)!, items.find((i) => i.id === doc)!];
    expect(photo.thumbUrl).toMatch(new RegExp(`/media/o/${ctx.org.id}/s/${ctx.site.id}/m/${image}/v1/thumb/x\\.webp$`));
    expect(photo.url).toMatch(/\/w1600\/x\.webp$/);
    expect(photo.previewUrl).toMatch(/\/w1600\/x\.webp$/);
    for (const url of [photo.thumbUrl, photo.url, photo.previewUrl]) expect(url).not.toContain("/original/");
    expect([menu.thumbUrl, menu.url]).toEqual([null, expect.stringMatching(/\/original\/x\.pdf$/)]);
    expect(photo.storedBytes).toBe(1_000 + 1_300);
    expect(storage).toMatchObject({ key: "storage", used: 2_300 + 1_000 });
  });
});

describe("who may do what", () => {
  it("a Viewer sees no library and changes nothing; an Author sees everyone's files and changes only their own", async () => {
    const a = await newTenant();
    const { site, ctx } = await siteOf(a);
    const viewer = await asRole(a, site, "viewer");
    const author = await asRole(a, site, "author");
    const owners = await ready(ctx, { filename: "owner.jpg" });
    const authors = await ready(ctx, { filename: "author.jpg", by: author.userId });
    const orphan = await ready(ctx, { filename: "orphan.jpg", by: null });

    expect(await refusalOf(() => listLibrary(viewer.ctx, query()))).toMatchObject({ kind: "Forbidden" });
    for (const run of [() => updateMediaDetails(viewer.ctx, owners, { title: "x" }), () => trashMedia(viewer.ctx, owners), () => moveMedia(viewer.ctx, [owners], null), () => createFolder(viewer.ctx, { name: "x" })]) {
      expect(await refusalOf(run)).toMatchObject({ kind: "Forbidden" });
    }
    expect(await refusalOf(() => requestUploads(viewer.ctx, [{ name: "a.png", size: 1, type: "image/png" }]))).toMatchObject({ kind: "Forbidden" });

    const seen = await listLibrary(author.ctx, query());
    expect(seen.items.map((i) => [i.filename, i.canEdit, i.canTrash]).sort()).toEqual([["author.jpg", true, true], ["orphan.jpg", false, false], ["owner.jpg", false, false]]);
    expect(seen.canManageFolders).toBe(false);
    await updateMediaDetails(author.ctx, authors, { title: "Mine" });
    for (const other of [owners, orphan]) {
      expect(await refusalOf(() => updateMediaDetails(author.ctx, other, { title: "x" }))).toMatchObject({ kind: "Forbidden" });
      expect(await refusalOf(() => trashMedia(author.ctx, other))).toMatchObject({ kind: "Forbidden" });
    }
    // All or nothing: one file not theirs, nothing moves.
    expect(await refusalOf(() => moveMedia(author.ctx, [authors, owners], null))).toMatchObject({ kind: "Forbidden" });
    expect(await refusalOf(() => createFolder(author.ctx, { name: "Mine" }))).toMatchObject({ kind: "Forbidden" });

    // An Editor changes anyone's, the orphan's too.
    const editor = await asRole(a, site, "editor");
    await updateMediaDetails(editor.ctx, orphan, { title: "Adopted" });
    await trashMedia(editor.ctx, owners);
    await restoreMedia(editor.ctx, owners);
  });

  it("the site's nav links the library for Owner, Admin, Editor and Author; not for a Viewer", async () => {
    const a = await newTenant();
    const { site, ctx } = await siteOf(a);
    const links = (member: SiteContext) =>
      siteNavItems({ overview: "/", appearance: "/a", settings: "/s", media: canSeeLibrary(member) ? "/media" : null }, member).map((item) => item.label);
    expect(links(ctx)).toContain("Media");
    for (const role of ["admin", "editor", "author"] as const) expect(links((await asRole(a, site, role)).ctx), role).toContain("Media");
    expect(links((await asRole(a, site, "viewer")).ctx)).not.toContain("Media");
  });

  it("another site's or organization's file, or no such id: not found, and nothing changes", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const { ctx: sibling } = await siteOf(a, "Sibling");
    const b = await newTenant("Other");
    const { ctx: elsewhere } = await siteOf(b);
    const theirs = await ready(sibling, { filename: "sibling.jpg" });
    const foreign = await ready(elsewhere, { filename: "foreign.jpg" });
    const { folder } = await createFolder(sibling, { name: "Theirs" });
    for (const id of [theirs, foreign, uuidv7(), "nope"]) {
      for (const run of [() => updateMediaDetails(ctx, id, { title: "x" }), () => trashMedia(ctx, id), () => restoreMedia(ctx, id), () => moveMedia(ctx, [id], null)]) {
        expect((await refusalOf(run)).kind, String(id)).toMatch(/NotFound|Validation/);
      }
    }
    for (const run of [() => renameFolder(ctx, folder.id, { name: "x" }), () => deleteFolder(ctx, folder.id)]) expect(await refusalOf(run)).toMatchObject({ kind: "NotFound" });
    const mine = await ready(ctx, { filename: "mine.jpg" });
    expect(await refusalOf(() => moveMedia(ctx, [mine], folder.id))).toMatchObject({ kind: "Validation", fieldErrors: { folderId: ["Choose a folder of this site."] } });
    expect(await refusalOf(() => moveMedia(ctx, [mine, theirs], null))).toMatchObject({ kind: "NotFound" });
    expect((await rowOf(sibling, theirs))!).toMatchObject({ title: "", deletedAt: null, folderId: null });
    expect((await rowOf(elsewhere, foreign))!).toMatchObject({ title: "", deletedAt: null });
  });
});

describe("changing files", () => {
  it("details: only what changed, recorded with which fields, flushed stale; too long refused; trashed refused", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const id = await ready(ctx, { filename: "photo.jpg" });
    expect(await updateMediaDetails(ctx, id, { title: " Beach ", altText: "Sand and sea", caption: "" })).toEqual({ changed: true, events: [{ type: "media.updated", mediaId: id, siteId: ctx.site.id }] });
    expect((await rowOf(ctx, id))!).toMatchObject({ title: "Beach", altText: "Sand and sea", caption: "" });
    expect((await events(ctx, "media.updated"))[0]!.metadata).toEqual({ kind: "image", filename: "photo.jpg", fields: ["title", "alt"] });
    expect(await updateMediaDetails(ctx, id, { title: "Beach" })).toEqual({ changed: false, events: [] });
    expect(await events(ctx, "media.updated")).toHaveLength(1);
    expect(await refusalOf(() => updateMediaDetails(ctx, id, { title: "x".repeat(201) }))).toMatchObject({ kind: "Validation", fieldErrors: { title: [expect.stringMatching(/at most 200/)] } });
    expect(await refusalOf(() => updateMediaDetails(ctx, id, { altText: "x".repeat(501) }))).toMatchObject({ kind: "Validation" });
    await trashMedia(ctx, id);
    expect(await refusalOf(() => updateMediaDetails(ctx, id, { title: "x" }))).toMatchObject({ kind: "Conflict", message: "This file is in the trash. Restore it first." });
  });

  it("move: several at once into a folder of this site, or out of any; each move recorded; a failed audit write moves nothing", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const { folder: old } = await createFolder(ctx, { name: "Old" });
    const { folder } = await createFolder(ctx, { name: "People" });
    const [x, y] = [await ready(ctx, { filename: "x.jpg", folderId: old.id }), await ready(ctx, { filename: "y.pdf", kind: "document" })];
    await whileFailing("audit_logs", "insert", () => expect(moveMedia(ctx, [x, y], folder.id)).rejects.toThrow());
    expect((await rowOf(ctx, x))!.folderId).toBe(old.id);
    expect(await moveMedia(ctx, [x, y, x], folder.id)).toEqual({ moved: 2 });
    expect((await events(ctx, "media.moved")).map((e) => e.metadata).sort((m1, m2) => JSON.stringify(m1).localeCompare(JSON.stringify(m2)))).toEqual([
      { kind: "document", filename: "y.pdf", folderName: "People" },
      { kind: "image", filename: "x.jpg", folderName: "People", previousFolderName: "Old" },
    ]);
    expect(await moveMedia(ctx, [x], folder.id)).toEqual({ moved: 0 });
    expect(await moveMedia(ctx, [x], null)).toEqual({ moved: 1 });
    expect((await rowOf(ctx, x))!.folderId).toBeNull();
    expect(await refusalOf(() => moveMedia(ctx, [], null))).toMatchObject({ kind: "Validation" });
    expect(await refusalOf(() => moveMedia(ctx, Array.from({ length: 101 }, () => uuidv7()), null))).toMatchObject({ kind: "Validation" });
  });

  it("trash and restore: out of the library at once (flushed immediately), recorded; back into its folder, or none if that went", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const { folder } = await createFolder(ctx, { name: "Short-lived" });
    const id = await ready(ctx, { filename: "photo.jpg", folderId: folder.id });
    expect(await trashMedia(ctx, id)).toEqual({ events: [{ type: "media.trashed", mediaId: id, siteId: ctx.site.id }] });
    expect(await trashMedia(ctx, id)).toEqual({ events: [] }); // already there
    expect((await listLibrary(ctx, query())).items).toHaveLength(0);
    // Only trashed files are left in it: it can be deleted, and they come back in no folder.
    await deleteFolder(ctx, folder.id);
    expect(await restoreMedia(ctx, id)).toEqual({ events: [{ type: "media.restored", mediaId: id, siteId: ctx.site.id }] });
    expect((await rowOf(ctx, id))!).toMatchObject({ deletedAt: null, folderId: null });
    expect((await events(ctx, "media.trashed")).length + (await events(ctx, "media.restored")).length).toBe(2);
  });
});

describe("folders", () => {
  it("created, renamed (names unique in the site), deleted only when empty; recorded", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const { ctx: sibling } = await siteOf(a, "Sibling");
    const { folder } = await createFolder(ctx, { name: "  Events  " });
    expect(folder.name).toBe("Events");
    expect(await refusalOf(() => createFolder(ctx, { name: "Events" }))).toMatchObject({ kind: "Validation", fieldErrors: { name: ["Another folder of this site already has this name."] } });
    await createFolder(sibling, { name: "Events" }); // another site: its own names
    for (const name of ["", "   ", "x".repeat(101), null]) expect(await refusalOf(() => createFolder(ctx, { name })), String(name)).toMatchObject({ kind: "Validation" });
    expect((await createFolder(ctx, { name: "a/b\\c" })).folder.name).toBe("a b c");

    const { folder: other } = await createFolder(ctx, { name: "Other" });
    expect(await refusalOf(() => renameFolder(ctx, other.id, { name: "Events" }))).toMatchObject({ kind: "Validation" });
    expect(await renameFolder(ctx, folder.id, { name: "Events" })).toEqual({ changed: false });
    expect(await renameFolder(ctx, folder.id, { name: "Events 2026" })).toEqual({ changed: true });
    expect((await events(ctx, "media.folder_renamed"))[0]!.metadata).toEqual({ name: "Events 2026", previousName: "Events" });

    const id = await ready(ctx, { filename: "in.jpg", folderId: folder.id });
    expect(await refusalOf(() => deleteFolder(ctx, folder.id))).toMatchObject({ kind: "Conflict", message: "Events 2026 still holds 1 file. Move or trash it first." });
    await moveMedia(ctx, [id], null);
    await deleteFolder(ctx, folder.id);
    expect((await listLibrary(ctx, query())).folders.map((f) => f.name)).toEqual(["a b c", "Other"]);
    expect(await events(ctx, "media.folder_created")).toHaveLength(4); // the sibling site's too: one organization's log
    expect(await events(ctx, "media.folder_deleted")).toHaveLength(1);
  });
});

describe("trash.purge (30 days)", () => {
  it("files 30 days in the trash go with every object; younger ones and the library stay; a restore can no longer win once claimed", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const bytes = await imageOf("png", 900, 600);
    const upload = async (name: string) => {
      const { uploads } = await requestUploads(ctx, [{ name, size: bytes.byteLength, type: "image/png" }]);
      expect(await send(uploads[0]!.upload, bytes)).toBe(200);
      await completeUpload(ctx, uploads[0]!.mediaId);
      return (await rowOf(ctx, uploads[0]!.mediaId))!;
    };
    const old = await upload("old.png");
    const recent = await upload("recent.png");
    const kept = await upload("kept.png");
    for (const row of [old, recent]) await trashMedia(ctx, row.id);
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.mediaAssets).set({ deletedAt: sql`now() - interval '31 days'` }).where(eq(t.mediaAssets.id, old.id)));
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.mediaAssets).set({ deletedAt: sql`now() - interval '29 days'` }).where(eq(t.mediaAssets.id, recent.id)));

    const result = await purgeTrashedMedia();
    expect(result.kept).toBe(0);
    expect(await rowOf(ctx, old.id)).toBeNull();
    for (const key of [old.storageKey, ...old.variants.map((v) => v.storageKey)]) expect(await platformStorage().head(key)).toBeNull();
    expect((await rowOf(ctx, recent.id))!.deletedAt).not.toBeNull();
    expect(await platformStorage().head(recent.variants[0]!.storageKey)).not.toBeNull();
    expect((await rowOf(ctx, kept.id))!.deletedAt).toBeNull();
    expect(await refusalOf(() => restoreMedia(ctx, old.id))).toMatchObject({ kind: "NotFound" });
  });

  it("objects that cannot be deleted: the row is no longer restorable and counts for nothing; uploads.cleanup finishes it", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const id = await ready(ctx, { filename: "stuck.jpg", ageMinutes: 60 * 48 });
    await trashMedia(ctx, id);
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.mediaAssets).set({ deletedAt: sql`now() - interval '40 days'` }).where(eq(t.mediaAssets.id, id)));
    setStorageDriverForTests(failing(driver, ["delete"]));
    try {
      await expect(trashPurge.run({}, { job: { id: uuidv7(), type: "trash.purge", attempt: 1, maxAttempts: 5 }, orgId: null, log: (await import("@/platform/observability")).logger, withTenant: () => Promise.reject(new Error("none")) })).rejects.toThrow(/uploads.cleanup retries/);
    } finally {
      setStorageDriverForTests(driver);
    }
    expect((await rowOf(ctx, id))!.status).toBe("failed");
    expect(await refusalOf(() => restoreMedia(ctx, id))).toMatchObject({ kind: "NotFound" });
    await cleanUpUploads();
    expect(await rowOf(ctx, id)).toBeNull();
  });

  it("is a daily job", () => {
    expect(jobRegistry.get("trash.purge")).toBe(trashPurge);
    expect(DAILY_JOBS.map((job) => job.type)).toEqual(["jobs.cleanup", "uploads.cleanup", "trash.purge"]);
  });

  it("restoring and purging at once: the file ends restored with its objects, or purged and gone; never restored without them", async () => {
    for (let round = 0; round < 4; round++) {
      const a = await newTenant();
      const { ctx } = await siteOf(a);
      const bytes = await imageOf("png", 900, 600);
      const { uploads } = await requestUploads(ctx, [{ name: "race.png", size: bytes.byteLength, type: "image/png" }]);
      expect(await send(uploads[0]!.upload, bytes)).toBe(200);
      await completeUpload(ctx, uploads[0]!.mediaId);
      const row = (await rowOf(ctx, uploads[0]!.mediaId))!;
      await trashMedia(ctx, row.id);
      await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.mediaAssets).set({ deletedAt: sql`now() - interval '31 days'` }).where(eq(t.mediaAssets.id, row.id)));
      await Promise.allSettled([restoreMedia(ctx, row.id), purgeTrashedMedia()]);
      const after = await rowOf(ctx, row.id);
      if (after && after.status === "ready") {
        expect(after.deletedAt, `round ${round}`).toBeNull();
        for (const v of row.variants) expect(await platformStorage().head(v.storageKey), `round ${round}`).not.toBeNull();
      } else {
        await cleanUpUploads();
        expect(await rowOf(ctx, row.id), `round ${round}`).toBeNull();
      }
    }
  });
});
