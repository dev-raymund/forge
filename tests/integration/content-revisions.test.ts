import { and, asc, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  createEntry, createTerm, deleteTerm, getDraftHead, getEntryForEditor, listRevisions, overwriteDraft, publishEntry, publishScheduled, restoreRevision, saveDraft, saveRevision,
  scheduleEntry, submitOverwriteDraft, submitRestoreRevision, submitRevisionHistory, submitSaveRevision, toLocalInput, trashEntry, unpublishEntry, zonedToUtc, HISTORY_PAGE_SIZE,
} from "@/modules/content";
import { CHANGED_AGAIN, DRAFT_CHANGED, NEWER_SAVE, NOT_THE_LATEST } from "@/modules/content/shared";
import { createSite } from "@/modules/sites";
import { inTenant, resolveSiteContext, type SiteContext } from "@/modules/tenancy";
import * as t from "@/platform/db/schema";
import { withTenant } from "@/platform/db/tenant";
import { createJobRegistry, runJobs } from "@/platform/jobs";
import { whileFailing } from "../fixtures/db-failure";
import { createMedia } from "../fixtures/factories";
import { addMember, newSlug, newTenant, refusalOf } from "../fixtures/tenants";

// The public reads' cache calls are noted, and so are the flushes: nothing in the history changes what visitors see,
// so nothing here may flush.
const cache = vi.hoisted(() => ({ flushed: [] as string[] }));
vi.mock("next/cache", async (original) => ({
  ...(await original<typeof import("next/cache")>()),
  cacheLife: () => {},
  cacheTag: () => {},
  revalidateTag: (tag: string) => void cache.flushed.push(tag),
  updateTag: (tag: string) => void cache.flushed.push(tag),
}));
const { loadPublicSite, publicPageFor, resolveSite } = await import("@/modules/rendering");

/**
 * M7-3 against real Postgres through PgBouncer: "Save" and its revisions (deduped, capped by the plan), the history,
 * restoring a revision into the draft (checked as a draft is now; never published), and the conflict dialog's
 * overwrite (the version it replaces kept first). Locks, the version token, RLS and the rollback of every step are the
 * database's, so they are tested here, in rounds where two requests race.
 */

type Tenant = Awaited<ReturnType<typeof newTenant>>;
const HOUR = 3_600_000;

async function liveSite(tenant: Tenant, name = "History") {
  const address = newSlug("rev");
  const { site } = await createSite(tenant.ctx, { name, address, language: "en", timezone: "UTC" });
  const ctx = await resolveSiteContext(tenant.actor, tenant.org.slug, site.slug);
  await withTenant({ orgId: tenant.org.id }, (tx) => tx.update(t.sites).set({ status: "live" }).where(eq(t.sites.id, site.id)));
  return { site, ctx, address };
}
const para = (text: string) => ({ type: "paragraph", attrs: { id: uuidv7() }, content: [{ type: "text", text }] });
const doc = (...content: unknown[]) => ({ v: 1, doc: { type: "doc", content: content.map((c) => (typeof c === "string" ? para(c) : c)) } });
const imageBlock = (mediaId: string) => ({ type: "image", attrs: { id: uuidv7(), v: 1, mediaId, alt: null, caption: null, size: "content", link: null } });
const textOf = (content: unknown) => JSON.stringify(content).match(/"text":"([^"]*)"/g)?.map((m) => m.slice(8, -1)) ?? [];

const draftOf = async (ctx: SiteContext, entryId: string) =>
  (await inTenant(ctx, (tx) => tx.select().from(t.entryDrafts).where(eq(t.entryDrafts.entryId, entryId))))[0]!;
const versionOf = async (ctx: SiteContext, entryId: string) => (await draftOf(ctx, entryId)).version;
const entryOf = async (ctx: SiteContext, entryId: string) => (await inTenant(ctx, (tx) => tx.select().from(t.entries).where(eq(t.entries.id, entryId))))[0] ?? null;
const revisionsOf = (ctx: SiteContext, entryId: string) =>
  inTenant(ctx, (tx) => tx.select().from(t.entryRevisions).where(eq(t.entryRevisions.entryId, entryId)).orderBy(asc(t.entryRevisions.number)));
const records = (ctx: SiteContext, action: string, entryId?: string) =>
  inTenant(ctx, async (tx) =>
    (await tx.select().from(t.auditLogs).where(and(eq(t.auditLogs.organizationId, ctx.org.id), eq(t.auditLogs.action, action)))).filter((row) => !entryId || row.resourceId === entryId),
  );
async function save(ctx: SiteContext, entryId: string, draft: Record<string, unknown>) {
  return saveDraft(ctx, entryId, await versionOf(ctx, entryId), draft);
}
async function snapshot(ctx: SiteContext, entryId: string, label?: string) {
  return saveRevision(ctx, entryId, { version: await versionOf(ctx, entryId), label });
}
const publicText = async (address: string, path: string) => {
  const resolved = (await resolveSite({ kind: "address", address }))!;
  const site = (await loadPublicSite(resolved.orgId, resolved.siteId))!;
  const page = await publicPageFor(site, path.slice(1).split("/"));
  return page?.kind === "entry" ? textOf(page.entry.content) : null;
};
/** A post with three revisions: "One" saved, "Two" published, "Three" in the draft. */
async function postWithHistory(ctx: SiteContext, title = "Rye season") {
  const { entry } = await createEntry(ctx, { type: "post", title });
  await save(ctx, entry.id, { content: doc("One"), excerpt: "First" });
  await snapshot(ctx, entry.id);
  const { version } = await save(ctx, entry.id, { content: doc("Two"), excerpt: "Second" });
  await publishEntry(ctx, entry.id, version);
  await save(ctx, entry.id, { content: doc("Three"), excerpt: "Third" });
  const revisions = await revisionsOf(ctx, entry.id);
  return { entry, revisions };
}
const plan = (ctx: SiteContext, planKey: "free" | "pro") =>
  withTenant({ orgId: ctx.org.id }, (tx) => tx.update(t.subscriptions).set({ planKey }).where(eq(t.subscriptions.organizationId, ctx.org.id)));

afterAll(() => vi.restoreAllMocks());

describe("Save: a `save` revision", () => {
  it("keeps the draft at the version the editor saved; the same draft again is the same revision; a change or a new label makes a new one; nothing public changes", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const { entry } = await createEntry(ctx, { type: "post", title: "Saved" });
    await save(ctx, entry.id, { content: doc("Hello"), excerpt: "Hi" });
    cache.flushed.length = 0;

    expect(await snapshot(ctx, entry.id)).toEqual({ number: 1, created: true, events: [] });
    const [first] = await revisionsOf(ctx, entry.id);
    const draft = await draftOf(ctx, entry.id);
    expect(first).toMatchObject({
      kind: "save", number: 1, label: null, title: "Saved", excerpt: "Hi", content: draft.content, contentHash: draft.contentHash, sourceDraftVersion: draft.version,
      createdBy: a.user.id,
    });
    // Deduped: nothing changed since revision 1.
    expect(await snapshot(ctx, entry.id)).toEqual({ number: 1, created: false, events: [] });
    // Named: a point the person means to find again, even with nothing changed.
    expect(await snapshot(ctx, entry.id, "  Before the redesign  ")).toMatchObject({ number: 2, created: true });
    expect((await revisionsOf(ctx, entry.id))[1]).toMatchObject({ label: "Before the redesign" });
    expect(await snapshot(ctx, entry.id, "Before the redesign")).toMatchObject({ number: 2, created: false });
    await save(ctx, entry.id, { title: "Saved again" });
    expect(await snapshot(ctx, entry.id)).toMatchObject({ number: 3, created: true });

    // The draft and the projection are as they were; nothing is recorded or flushed; it is not published.
    expect(await entryOf(ctx, entry.id)).toMatchObject({ status: "draft", publishedRevisionId: null });
    expect(await records(ctx, "entry.revision_restored", entry.id)).toHaveLength(0);
    expect(cache.flushed).toEqual([]);
    expect((await refusalOf(() => saveRevision(ctx, entry.id, { version: 1, label: "x".repeat(101) }))).fieldErrors).toEqual({ label: ["Use at most 100 characters."] });
  });

  it("refuses a draft that is no longer the editor's (another tab saved since), and writes nothing", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const { entry } = await createEntry(ctx, { type: "page", title: "Stale" });
    const seen = await versionOf(ctx, entry.id);
    await save(ctx, entry.id, { content: doc("Elsewhere") });
    const refusal = await refusalOf(() => saveRevision(ctx, entry.id, { version: seen }));
    expect(refusal).toMatchObject({ kind: "Conflict", message: NOT_THE_LATEST });
    expect(await revisionsOf(ctx, entry.id)).toHaveLength(0);
    // The form says so, and asks the editor to flush nothing.
    const data = new FormData();
    data.set("version", String(seen));
    const outcome = await submitSaveRevision(a.actor, a.org.slug, ctx.site.slug, entry.id, data);
    expect(outcome.state).toMatchObject({ status: "error", message: NOT_THE_LATEST });
  });

  it("keeps the plan's number of manual revisions per entry (Free 20, Pro 100), the oldest pruned; publish and scheduled revisions always kept", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    await plan(ctx, "free");
    const { entry } = await createEntry(ctx, { type: "post", title: "Many" });
    const { version } = await save(ctx, entry.id, { content: doc("Published") });
    await publishEntry(ctx, entry.id, version);
    for (let i = 1; i <= 22; i++) {
      await save(ctx, entry.id, { content: doc(`Save ${i}`) });
      await snapshot(ctx, entry.id);
    }
    const kept = await revisionsOf(ctx, entry.id);
    expect(kept.filter((r) => r.kind === "save")).toHaveLength(20);
    expect(kept.filter((r) => r.kind === "save").map((r) => r.number)).toEqual(Array.from({ length: 20 }, (_, i) => i + 4)); // 2 and 3 went: the oldest
    expect(kept.find((r) => r.kind === "publish")).toMatchObject({ number: 1 });
    expect((await entryOf(ctx, entry.id))!.publishedRevisionId).toBe(kept[0]!.id);

    // On Pro, the same entry keeps up to 100 from now on.
    await plan(ctx, "pro");
    for (let i = 23; i <= 25; i++) {
      await save(ctx, entry.id, { content: doc(`Save ${i}`) });
      await snapshot(ctx, entry.id);
    }
    expect((await revisionsOf(ctx, entry.id)).filter((r) => r.kind === "save")).toHaveLength(23);
  });
});

describe("the history", () => {
  it("lists every revision newest first: number, kind, label, who, when, the live one and a schedule's frozen one; older ones a page at a time", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const editor = await addMember(a.org, "editor");
    const editorCtx = await resolveSiteContext(editor.actor, a.org.slug, ctx.site.slug);
    const { entry, revisions } = await postWithHistory(ctx);
    await saveRevision(editorCtx, entry.id, { version: await versionOf(ctx, entry.id), label: "Editor's pass" });

    const list = await listRevisions(ctx, entry.id);
    expect(list).toMatchObject({ more: false, canRestore: true, timeZone: "UTC" });
    expect(list.items.map(({ number, kind, label, by, byYou, live, scheduledFor }) => ({ number, kind, label, by, byYou, live, scheduledFor }))).toEqual([
      { number: 3, kind: "save", label: "Editor's pass", by: "A editor", byYou: false, live: false, scheduledFor: null },
      { number: 2, kind: "publish", label: null, by: a.user.name, byYou: true, live: true, scheduledFor: null },
      { number: 1, kind: "save", label: null, by: a.user.name, byYou: true, live: false, scheduledFor: null },
    ]);
    expect(list.items[2]).toMatchObject({ id: revisions[0]!.id, title: "Rye season", createdAt: revisions[0]!.createdAt.toISOString() });
    expect(Object.keys(list.items[0]!).sort()).toEqual(["by", "byYou", "createdAt", "id", "kind", "label", "live", "number", "scheduledFor", "title"]); // no content

    // A schedule's frozen revision says when it publishes; the draft's later changes are not in it.
    const { entry: soon } = await createEntry(ctx, { type: "post", title: "Soon" });
    await save(ctx, soon.id, { content: doc("Frozen") });
    const local = toLocalInput(new Date(Date.now() + 2 * HOUR), "UTC");
    const at = (zonedToUtc(local, "UTC") as { ok: true; at: Date }).at;
    await scheduleEntry(ctx, soon.id, { runAt: local, version: await versionOf(ctx, soon.id) });
    await save(ctx, soon.id, { content: doc("Typed after") });
    await snapshot(ctx, soon.id);
    expect((await listRevisions(ctx, soon.id)).items.map(({ kind, scheduledFor }) => ({ kind, scheduledFor }))).toEqual([
      { kind: "save", scheduledFor: null },
      { kind: "scheduled", scheduledFor: at.toISOString() },
    ]);

    // A former member's revisions are kept, without their name.
    await withTenant({ orgId: a.org.id }, (tx) => tx.delete(t.organizationMembers).where(eq(t.organizationMembers.id, editor.memberId)));
    expect((await listRevisions(ctx, entry.id)).items[0]).toMatchObject({ number: 3, by: null });

    // Pages of HISTORY_PAGE_SIZE.
    const { entry: long } = await createEntry(ctx, { type: "post", title: "Long" });
    for (let i = 0; i < HISTORY_PAGE_SIZE + 2; i++) {
      await save(ctx, long.id, { content: doc(`v${i}`) });
      await snapshot(ctx, long.id);
    }
    const first = await listRevisions(ctx, long.id);
    expect(first.items).toHaveLength(HISTORY_PAGE_SIZE);
    expect(first.more).toBe(true);
    const older = await listRevisions(ctx, long.id, first.items.at(-1)!.number);
    expect(older.items.map((r) => r.number)).toEqual([2, 1]);
    expect(older.more).toBe(false);
  });

  it("is seen by who may see the entry: an Author only their own posts' and no page's, a Viewer every one but restores none, another site's entry is not found", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    const { site: other } = await createSite(a.ctx, { name: "Other", address: newSlug("rev"), language: "en", timezone: "UTC" });
    const otherCtx = await resolveSiteContext(a.actor, a.org.slug, other.slug);
    const author = await addMember(a.org, "author");
    const viewer = await addMember(a.org, "viewer");
    const authorCtx = await resolveSiteContext(author.actor, a.org.slug, site.slug);
    const viewerCtx = await resolveSiteContext(viewer.actor, a.org.slug, site.slug);
    const { entry: ownersPost } = await postWithHistory(ctx);
    const { entry: page } = await createEntry(ctx, { type: "page", title: "About" });
    const { entry: authorsPost } = await createEntry(authorCtx, { type: "post", title: "Mine" });
    await snapshot(authorCtx, authorsPost.id);

    expect((await listRevisions(authorCtx, authorsPost.id)).items).toHaveLength(1);
    for (const id of [ownersPost.id, page.id]) expect((await refusalOf(() => listRevisions(authorCtx, id))).kind).toBe("NotFound");
    expect((await refusalOf(() => restoreRevision(authorCtx, ownersPost.id, { revisionId: uuidv7(), version: 1 }))).kind).toBe("NotFound");
    expect(await listRevisions(viewerCtx, ownersPost.id)).toMatchObject({ canRestore: false });
    const revision = (await revisionsOf(ctx, ownersPost.id))[0]!;
    expect((await refusalOf(() => restoreRevision(viewerCtx, ownersPost.id, { revisionId: revision.id, version: 1 }))).kind).toBe("Forbidden");
    expect((await refusalOf(() => saveRevision(viewerCtx, ownersPost.id, { version: 1 }))).kind).toBe("Forbidden");
    expect((await refusalOf(() => overwriteDraft(viewerCtx, ownersPost.id, { replaceVersion: 1, draft: { title: "x" } }))).kind).toBe("Forbidden");

    // Another site of the same organization: its entry, and a revision of it named on this site's entry.
    for (const run of [() => listRevisions(otherCtx, ownersPost.id), () => getDraftHead(otherCtx, ownersPost.id), () => saveRevision(otherCtx, ownersPost.id, { version: 1 })]) {
      expect((await refusalOf(run)).kind).toBe("NotFound");
    }
    const { entry: elsewhere } = await createEntry(otherCtx, { type: "post", title: "Elsewhere" });
    await snapshot(otherCtx, elsewhere.id);
    const foreign = (await revisionsOf(otherCtx, elsewhere.id))[0]!;
    const ownersVersion = await versionOf(ctx, ownersPost.id);
    expect((await refusalOf(() => restoreRevision(ctx, ownersPost.id, { revisionId: foreign.id, version: ownersVersion }))).kind).toBe("NotFound");
    // The read through its form answers the same way.
    expect(await submitRevisionHistory(a.actor, a.org.slug, other.slug, ownersPost.id, undefined)).toMatchObject({ ok: false, code: "NotFound" });
    expect(await submitRevisionHistory(a.actor, a.org.slug, site.slug, ownersPost.id, "x")).toMatchObject({ ok: false, code: "Validation" });
  });

  it("an entry in the trash has no history to list or restore (it is reachable once the entry is restored)", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const { entry } = await createEntry(ctx, { type: "post", title: "Gone" });
    await snapshot(ctx, entry.id);
    const [revision] = await revisionsOf(ctx, entry.id);
    const listed = await listRevisions(ctx, entry.id);
    await trashEntry(ctx, entry.id);
    expect((await refusalOf(() => listRevisions(ctx, entry.id))).kind).toBe("NotFound");
    const version = await versionOf(ctx, entry.id);
    expect((await refusalOf(() => restoreRevision(ctx, entry.id, { revisionId: listed.items[0]!.id, version }))).kind).toBe("NotFound");
    expect(await revisionsOf(ctx, entry.id)).toEqual([revision]);
  });
});

describe("restoring a revision", () => {
  it("copies it into the draft (a new version), keeps the draft as it was, adds a `restore` revision, records it; the live version and the old revisions are untouched; nothing is flushed", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const { entry, revisions } = await postWithHistory(ctx);
    const [saved, published] = revisions;
    const before = await entryOf(ctx, entry.id);
    const version = await versionOf(ctx, entry.id);
    cache.flushed.length = 0;

    const restored = await restoreRevision(ctx, entry.id, { revisionId: saved!.id, version });
    expect(restored).toEqual({
      version: version + 1, restored: 1, kept: 3, revision: 4, events: [], notes: { droppedTerms: 0, missingImages: 0, missingLinks: 0, featuredImage: "ok" },
    });
    // The draft is revision 1.
    const draft = await draftOf(ctx, entry.id);
    expect(draft).toMatchObject({ version: version + 1, title: saved!.title, slug: saved!.slug, excerpt: "First", content: saved!.content, contentHash: saved!.contentHash, updatedBy: a.user.id });
    // The history: 1 and 2 as they were; 3 the draft before ("Three"); 4 the restore.
    const after = await revisionsOf(ctx, entry.id);
    expect(after.slice(0, 2)).toEqual([saved, published]);
    expect(after[2]).toMatchObject({ kind: "save", label: "Kept before revision 1 was restored", excerpt: "Third", createdBy: a.user.id });
    expect(textOf(after[2]!.content)).toEqual(["Three"]);
    expect(after[3]).toMatchObject({ kind: "restore", label: "Restored from revision 1", content: saved!.content, sourceDraftVersion: version + 1, createdBy: a.user.id });

    // Never published: the entry, its live revision and the public page are as they were; nothing flushed.
    expect(await entryOf(ctx, entry.id)).toEqual(before);
    expect(await publicText(address, "/blog/rye-season")).toEqual(["Two"]);
    expect(cache.flushed).toEqual([]);
    const editor = await getEntryForEditor(ctx, entry.id, "post");
    expect(editor).toMatchObject({ status: "published", publishedDraftVersion: published!.sourceDraftVersion, draft: { version: version + 1 } });

    expect((await records(ctx, "entry.revision_restored", entry.id))[0]).toMatchObject({
      actorType: "user", actorId: a.user.id, metadata: { type: "post", title: "Rye season", path: "/blog/rye-season", revision: 1 },
    });
    // Publishing it afterwards is what makes it live.
    await publishEntry(ctx, entry.id, version + 1);
    expect(await publicText(address, "/blog/rye-season")).toEqual(["One"]);
  });

  it("through its form: the message says what it could not bring back; the lists are refreshed; nothing is flushed", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const { entry, revisions } = await postWithHistory(ctx);
    const data = new FormData();
    data.set("revisionId", revisions[0]!.id);
    data.set("version", String(await versionOf(ctx, entry.id)));
    const outcome = await submitRestoreRevision(a.actor, a.org.slug, ctx.site.slug, entry.id, data);
    expect(outcome.state).toMatchObject({ status: "success", message: "Revision 1 is in the draft now. Nothing is published until you publish it.", values: { revision: "4", kept: "3" } });
    expect(outcome.invalidate).toEqual([]);
    expect(outcome.refresh).toBe(false);
  });

  it("refuses a draft that changed since the history was opened, a revision that is not this entry's, and an id that is not one; nothing changes", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const { entry, revisions } = await postWithHistory(ctx);
    const { entry: other } = await createEntry(ctx, { type: "post", title: "Other" });
    await snapshot(ctx, other.id);
    const seen = await versionOf(ctx, entry.id);
    await save(ctx, entry.id, { content: doc("Newer, elsewhere") });
    const draft = await draftOf(ctx, entry.id);

    expect(await refusalOf(() => restoreRevision(ctx, entry.id, { revisionId: revisions[0]!.id, version: seen }))).toMatchObject({ kind: "Conflict", message: NOT_THE_LATEST });
    const otherRevision = (await revisionsOf(ctx, other.id))[0]!;
    expect((await refusalOf(() => restoreRevision(ctx, entry.id, { revisionId: otherRevision.id, version: draft.version }))).kind).toBe("NotFound");
    expect((await refusalOf(() => restoreRevision(ctx, entry.id, { revisionId: "not-an-id", version: draft.version }))).kind).toBe("NotFound");
    expect(await draftOf(ctx, entry.id)).toEqual(draft);
    expect(await revisionsOf(ctx, entry.id)).toEqual(revisions);
  });

  it("leaves out terms deleted since (and says so), keeps images and links that are gone as written and flags them, keeps a trashed featured image and removes a deleted one", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    const ids = { orgId: a.org.id, siteId: site.id, userId: a.user.id };
    const keptTerm = (await createTerm(ctx, { taxonomy: "category", name: "Bread" })).term;
    const goneTerm = (await createTerm(ctx, { taxonomy: "tag", name: "Rye" })).term;
    const { media: trashed } = await createMedia(ids);
    const { media: deleted } = await createMedia(ids);
    const { media: cover } = await createMedia(ids);
    const { entry: linked } = await createEntry(ctx, { type: "page", title: "Linked" });
    const { entry } = await createEntry(ctx, { type: "post", title: "Full" });
    const link = { type: "paragraph", attrs: { id: uuidv7() }, content: [{ type: "text", text: "see", marks: [{ type: "link", attrs: { href: `entry:${linked.id}` } }] }] };
    await save(ctx, entry.id, { content: doc("Words", imageBlock(trashed.id), imageBlock(deleted.id), link), termIds: [keptTerm.id, goneTerm.id], featuredMediaId: cover.id });
    await snapshot(ctx, entry.id);
    const [revision] = await revisionsOf(ctx, entry.id);
    await save(ctx, entry.id, { content: doc("Later"), termIds: [], featuredMediaId: null });

    await deleteTerm(ctx, goneTerm.id);
    await withTenant({ orgId: a.org.id }, async (tx) => {
      await tx.update(t.mediaAssets).set({ deletedAt: new Date() }).where(eq(t.mediaAssets.id, trashed.id));
      await tx.update(t.mediaAssets).set({ deletedAt: new Date() }).where(eq(t.mediaAssets.id, cover.id));
      await tx.delete(t.mediaAssets).where(eq(t.mediaAssets.id, deleted.id));
      await tx.update(t.entries).set({ deletedAt: new Date() }).where(eq(t.entries.id, linked.id));
    });
    const restored = await restoreRevision(ctx, entry.id, { revisionId: revision!.id, version: await versionOf(ctx, entry.id) });
    expect(restored.notes).toEqual({ droppedTerms: 1, missingImages: 2, missingLinks: 1, featuredImage: "unavailable" });
    const draft = await draftOf(ctx, entry.id);
    expect(draft).toMatchObject({ termIds: [keptTerm.id], featuredMediaId: cover.id, content: revision!.content });
    // The revision itself still names what it had: history is not rewritten.
    expect((await revisionsOf(ctx, entry.id))[0]).toEqual(revision);

    // Its featured image deleted for good: the draft cannot point at it, and has none.
    await withTenant({ orgId: a.org.id }, (tx) => tx.delete(t.mediaAssets).where(eq(t.mediaAssets.id, cover.id)));
    const again = await restoreRevision(ctx, entry.id, { revisionId: revision!.id, version: await versionOf(ctx, entry.id) });
    expect(again.notes.featuredImage).toBe("removed");
    expect((await draftOf(ctx, entry.id)).featuredMediaId).toBeNull();
    // The restored draft can be published as it is: what is gone is left out of the page.
    await publishEntry(ctx, entry.id, await versionOf(ctx, entry.id));
  });

  it("refuses an address that another entry has now, or that is reserved now, naming it (never a suffix); the draft's own slug is not checked again", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const { entry } = await createEntry(ctx, { type: "page", title: "Team" });
    await snapshot(ctx, entry.id);
    const [old] = await revisionsOf(ctx, entry.id);
    await save(ctx, entry.id, { slug: "our-team" });
    const { version } = await save(ctx, entry.id, { content: doc("New") });
    await publishEntry(ctx, entry.id, version);
    // Someone else takes /team.
    const { entry: taker } = await createEntry(ctx, { type: "page", title: "Team" });
    expect((await entryOf(ctx, taker.id))!.path).toBe("/team");
    const draft = await draftOf(ctx, entry.id);
    const refusal = await refusalOf(() => restoreRevision(ctx, entry.id, { revisionId: old!.id, version: draft.version }));
    expect(refusal).toMatchObject({ kind: "Conflict", message: "Revision 1 used the address /team, which “Team” has now. Change that address first, or restore another revision." });
    expect(await draftOf(ctx, entry.id)).toEqual(draft);

    // A reserved address: the blog's path is `team` now.
    await trashEntry(ctx, taker.id);
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.siteSettings).set({ reading: { blogPath: "team", postsPerPage: 10 } }).where(eq(t.siteSettings.siteId, ctx.site.id)));
    expect((await refusalOf(() => restoreRevision(ctx, entry.id, { revisionId: old!.id, version: draft.version }))).fieldErrors?.slug?.[0]).toMatch(/^Revision 1 cannot be restored: /);

    // A revision with the slug the draft already has is not checked again.
    const { entry: same } = await createEntry(ctx, { type: "post", title: "Same slug" });
    await snapshot(ctx, same.id);
    const [sameRevision] = await revisionsOf(ctx, same.id);
    await save(ctx, same.id, { content: doc("Changed") });
    await expect(restoreRevision(ctx, same.id, { revisionId: sameRevision!.id, version: await versionOf(ctx, same.id) })).resolves.toMatchObject({ restored: 1 });
  });

  it("refuses a revision whose document is not valid now, saying which revision; nothing changes", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const { entry } = await createEntry(ctx, { type: "post", title: "Broken" });
    await snapshot(ctx, entry.id);
    const [revision] = await revisionsOf(ctx, entry.id);
    // A revision written by other code, with a node this version of Forge does not have.
    const id = uuidv7();
    await withTenant({ orgId: a.org.id }, (tx) =>
      tx.insert(t.entryRevisions).values({ ...revision!, id, number: 2, content: { v: 1, doc: { type: "doc", content: [{ type: "script", attrs: { id: uuidv7() } }] } } }),
    );
    const draft = await draftOf(ctx, entry.id);
    const refusal = await refusalOf(() => restoreRevision(ctx, entry.id, { revisionId: id, version: draft.version }));
    expect(refusal.kind).toBe("Validation");
    expect(refusal.fieldErrors?.content?.[0]).toMatch(/^Revision 2 cannot be restored: /);
    expect(await draftOf(ctx, entry.id)).toEqual(draft);
  });

  it("a scheduled entry: restoring into its draft leaves the schedule's frozen revision alone, and the job publishes that one", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const { entry } = await createEntry(ctx, { type: "post", title: "Timed" });
    await save(ctx, entry.id, { content: doc("Old words") });
    await snapshot(ctx, entry.id);
    const [old] = await revisionsOf(ctx, entry.id);
    await save(ctx, entry.id, { content: doc("Scheduled words") });
    const local = toLocalInput(new Date(Date.now() + 2 * HOUR), "UTC");
    const at = (zonedToUtc(local, "UTC") as { ok: true; at: Date }).at;
    await scheduleEntry(ctx, entry.id, { runAt: local, version: await versionOf(ctx, entry.id) });

    await restoreRevision(ctx, entry.id, { revisionId: old!.id, version: await versionOf(ctx, entry.id) });
    expect(textOf((await draftOf(ctx, entry.id)).content)).toEqual(["Old words"]);
    expect(await entryOf(ctx, entry.id)).toMatchObject({ status: "scheduled", scheduledAt: at });
    await runJobs({ registry: createJobRegistry([publishScheduled]), budgetMs: 20_000, now: () => new Date(at.getTime() + 1_000) });
    expect(await entryOf(ctx, entry.id)).toMatchObject({ status: "published" });
    expect(await publicText(address, "/blog/timed")).toEqual(["Scheduled words"]);
    expect(textOf((await draftOf(ctx, entry.id)).content)).toEqual(["Old words"]);
  });

  it("a page: its parent and its author are the entry's, and stay; the Home page stays at /", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    const home = (await inTenant(ctx, (tx) => tx.select().from(t.siteSettings).where(eq(t.siteSettings.siteId, site.id))))[0]!.homepageEntryId!;
    await snapshot(ctx, home);
    const [first] = await revisionsOf(ctx, home);
    await save(ctx, home, { slug: "welcome", content: doc("Welcome") });
    await restoreRevision(ctx, home, { revisionId: first!.id, version: await versionOf(ctx, home) });
    expect(await entryOf(ctx, home)).toMatchObject({ path: "/" });
    expect(await draftOf(ctx, home)).toMatchObject({ slug: "home" });
  });
});

describe("the conflict dialog's overwrite", () => {
  /** Two editors on one draft: B saves after A opened it, so A's next save is a conflict. */
  async function conflicting() {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    const b = await addMember(a.org, "editor");
    const bCtx = await resolveSiteContext(b.actor, a.org.slug, site.slug);
    const { entry } = await createEntry(ctx, { type: "post", title: "Shared" });
    await save(ctx, entry.id, { content: doc("Base"), excerpt: "Base" });
    const base = await versionOf(ctx, entry.id);
    const theirs = await saveDraft(bCtx, entry.id, base, { content: doc("B's words"), excerpt: "B's" });
    expect((await refusalOf(() => saveDraft(ctx, entry.id, base, { content: doc("A's words") }))).message).toBe(DRAFT_CHANGED);
    return { a, b, ctx, bCtx, entry, base, theirs: theirs.version };
  }

  it("keeps the version it replaces as a `save` revision credited to whoever saved it, then writes this editor's; recorded; nothing public changes", async () => {
    const { a, b, ctx, entry, theirs } = await conflicting();
    cache.flushed.length = 0;
    expect(await getDraftHead(ctx, entry.id)).toMatchObject({ version: theirs, by: "A editor", byYou: false });

    const result = await overwriteDraft(ctx, entry.id, { replaceVersion: theirs, draft: { title: "Shared", content: doc("A's words"), excerpt: "A's" } });
    expect(result).toEqual({ version: theirs + 1, kept: 1, events: [] });
    expect(await draftOf(ctx, entry.id)).toMatchObject({ version: theirs + 1, excerpt: "A's", updatedBy: a.user.id });
    expect(textOf((await draftOf(ctx, entry.id)).content)).toEqual(["A's words"]);
    const [kept] = await revisionsOf(ctx, entry.id);
    expect(kept).toMatchObject({ kind: "save", label: "Kept when the draft was overwritten", excerpt: "B's", sourceDraftVersion: theirs, createdBy: b.user.id });
    expect(textOf(kept!.content)).toEqual(["B's words"]);
    expect((await records(ctx, "entry.draft_replaced", entry.id))[0]).toMatchObject({ actorId: a.user.id, metadata: { type: "post", title: "Shared", keptRevision: 1 } });
    expect(await entryOf(ctx, entry.id)).toMatchObject({ status: "draft", publishedRevisionId: null });
    expect(cache.flushed).toEqual([]);

    // B's version is in the history, and restoring it brings it back.
    await restoreRevision(ctx, entry.id, { revisionId: kept!.id, version: theirs + 1 });
    expect(textOf((await draftOf(ctx, entry.id)).content)).toEqual(["B's words"]);
  });

  it("never overwrites a version the dialog did not show: saved again since, it is refused (CHANGED_AGAIN) and nothing is written", async () => {
    const { ctx, bCtx, entry, theirs } = await conflicting();
    const again = await saveDraft(bCtx, entry.id, theirs, { content: doc("B again") });
    const before = await draftOf(ctx, entry.id);
    const refusal = await refusalOf(() => overwriteDraft(ctx, entry.id, { replaceVersion: theirs, draft: { content: doc("A's words") } }));
    expect(refusal).toMatchObject({ kind: "Conflict", message: CHANGED_AGAIN });
    expect(await draftOf(ctx, entry.id)).toEqual(before);
    expect(await revisionsOf(ctx, entry.id)).toEqual([]);
    // Shown the newer one, the person can overwrite it.
    expect((await getDraftHead(ctx, entry.id)).version).toBe(again.version);
    await expect(overwriteDraft(ctx, entry.id, { replaceVersion: again.version, draft: { content: doc("A's words") } })).resolves.toMatchObject({ version: again.version + 1 });
  });

  it("checks what it writes as a save does (now): refused content writes nothing, not even the kept revision", async () => {
    const { a, ctx, entry, theirs } = await conflicting();
    const { media } = await createMedia({ orgId: a.org.id, siteId: ctx.site.id, userId: a.user.id });
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.mediaAssets).set({ deletedAt: new Date() }).where(eq(t.mediaAssets.id, media.id)));
    const before = await draftOf(ctx, entry.id);
    for (const draft of [{ featuredMediaId: media.id }, { content: doc(imageBlock(media.id)) }, { content: { v: 1, doc: { type: "doc", content: [{ type: "script" }] } } }, { slug: "Not A Slug" }]) {
      expect((await refusalOf(() => overwriteDraft(ctx, entry.id, { replaceVersion: theirs, draft }))).kind).toBe("Validation");
    }
    expect(await draftOf(ctx, entry.id)).toEqual(before);
    expect(await revisionsOf(ctx, entry.id)).toEqual([]);
    expect(await records(ctx, "entry.draft_replaced", entry.id)).toEqual([]);
  });

  it("on a published or scheduled entry: only the draft changes; the live version, and a schedule's frozen revision, stay", async () => {
    const { ctx, bCtx, entry, theirs } = await conflicting();
    await publishEntry(bCtx, entry.id, theirs);
    const live = await entryOf(ctx, entry.id);
    const result = await overwriteDraft(ctx, entry.id, { replaceVersion: theirs, draft: { content: doc("A's words") } });
    expect(await entryOf(ctx, entry.id)).toEqual(live);
    // The published version was B's: it is already in the history, so nothing is kept twice.
    expect(result.kept).toBe((await revisionsOf(ctx, entry.id)).find((r) => r.kind === "publish")!.number);

    await unpublishEntry(ctx, entry.id);
    const local = toLocalInput(new Date(Date.now() + 2 * HOUR), "UTC");
    await scheduleEntry(ctx, entry.id, { runAt: local, version: result.version });
    const frozen = (await revisionsOf(ctx, entry.id)).at(-1)!;
    const head = await versionOf(ctx, entry.id);
    await overwriteDraft(ctx, entry.id, { replaceVersion: head, draft: { content: doc("After the schedule") } });
    expect((await revisionsOf(ctx, entry.id)).find((r) => r.id === frozen.id)).toEqual(frozen);
    expect(await entryOf(ctx, entry.id)).toMatchObject({ status: "scheduled" });
  });

  it("through its form: the new version and the kept revision; a stale one says so", async () => {
    const { a, ctx, entry, theirs } = await conflicting();
    const form = (replaceVersion: number) => {
      const data = new FormData();
      data.set("replaceVersion", String(replaceVersion));
      data.set("draft", JSON.stringify({ content: doc("A's words") }));
      return data;
    };
    expect((await submitOverwriteDraft(a.actor, a.org.slug, ctx.site.slug, entry.id, form(theirs - 1))).state).toMatchObject({ status: "error", message: CHANGED_AGAIN });
    const outcome = await submitOverwriteDraft(a.actor, a.org.slug, ctx.site.slug, entry.id, form(theirs));
    expect(outcome.state).toMatchObject({ status: "success", values: { version: String(theirs + 1), kept: "1" } });
    expect(outcome.invalidate).toEqual([]);
  });
});

describe("races: whichever takes the entry first wins, never both, and nothing is lost", () => {
  it("two editors saving from one version: one is saved, the other is a conflict", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const { entry } = await createEntry(ctx, { type: "post", title: "Two tabs" });
    for (let round = 0; round < 5; round++) {
      const version = await versionOf(ctx, entry.id);
      const outcomes = await Promise.allSettled([save(ctx, entry.id, { content: doc(`one ${round}`) }), saveDraft(ctx, entry.id, version, { content: doc(`two ${round}`) })]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      expect(await versionOf(ctx, entry.id)).toBe(version + 1);
    }
  });

  it("an overwrite racing a save of the version it would replace: one wins; if the overwrite wins, the save is refused and the replaced version is in the history", async () => {
    const { ctx, bCtx, entry } = await (async () => {
      const a = await newTenant();
      const { ctx, site } = await liveSite(a);
      const b = await addMember(a.org, "editor");
      return { ctx, bCtx: await resolveSiteContext(b.actor, a.org.slug, site.slug), entry: (await createEntry(ctx, { type: "post", title: "Race" })).entry };
    })();
    for (let round = 0; round < 6; round++) {
      const head = await versionOf(ctx, entry.id);
      const before = await draftOf(ctx, entry.id);
      const revisionsBefore = (await revisionsOf(ctx, entry.id)).length;
      const [overwrite, saved] = await Promise.allSettled([
        overwriteDraft(ctx, entry.id, { replaceVersion: head, draft: { content: doc(`A ${round}`) } }),
        saveDraft(bCtx, entry.id, head, { content: doc(`B ${round}`) }),
      ]);
      expect([overwrite.status, saved.status].sort()).toEqual(["fulfilled", "rejected"]);
      const after = await draftOf(ctx, entry.id);
      expect(after.version).toBe(head + 1);
      const revisions = await revisionsOf(ctx, entry.id);
      if (overwrite.status === "fulfilled") {
        expect(textOf(after.content)).toEqual([`A ${round}`]);
        expect((saved as PromiseRejectedResult).reason).toMatchObject({ message: DRAFT_CHANGED });
        // What it replaced (the head the dialog showed) is the latest revision, or was already in the history.
        expect(revisions.find((r) => r.number === overwrite.value.kept)!.content).toEqual(before.content);
      } else {
        expect(textOf(after.content)).toEqual([`B ${round}`]);
        expect((overwrite as PromiseRejectedResult).reason).toMatchObject({ message: CHANGED_AGAIN });
        expect(revisions).toHaveLength(revisionsBefore);
      }
    }
  });

  it("two overwrites of one version: one is written, the other refused; one kept revision", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const { entry } = await createEntry(ctx, { type: "post", title: "Both" });
    for (let round = 0; round < 5; round++) {
      await save(ctx, entry.id, { content: doc(`theirs ${round}`) });
      const head = await versionOf(ctx, entry.id);
      const count = (await revisionsOf(ctx, entry.id)).length;
      const outcomes = await Promise.allSettled(["x", "y"].map((who) => overwriteDraft(ctx, entry.id, { replaceVersion: head, draft: { content: doc(`${who} ${round}`) } })));
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      expect((outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ message: CHANGED_AGAIN });
      expect((await revisionsOf(ctx, entry.id)).length).toBe(count + 1);
      expect(await versionOf(ctx, entry.id)).toBe(head + 1);
    }
  });

  it("a restore racing a save: one wins; numbers stay unique", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const { entry, revisions } = await postWithHistory(ctx);
    for (let round = 0; round < 5; round++) {
      const head = await versionOf(ctx, entry.id);
      const outcomes = await Promise.allSettled([
        restoreRevision(ctx, entry.id, { revisionId: revisions[0]!.id, version: head }),
        saveDraft(ctx, entry.id, head, { content: doc(`typed ${round}`) }),
      ]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const numbers = (await revisionsOf(ctx, entry.id)).map((r) => r.number);
      expect(new Set(numbers).size).toBe(numbers.length);
    }
  });

  it("a restore racing a publish of the same draft: the live version is never the restored one, and one publish revision per publish", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const { entry, revisions } = await postWithHistory(ctx);
    for (let round = 0; round < 5; round++) {
      await save(ctx, entry.id, { content: doc(`Live ${round}`) });
      const head = await versionOf(ctx, entry.id);
      const publishesBefore = (await revisionsOf(ctx, entry.id)).filter((r) => r.kind === "publish").length;
      const [published, restored] = await Promise.allSettled([publishEntry(ctx, entry.id, head), restoreRevision(ctx, entry.id, { revisionId: revisions[0]!.id, version: head })]);
      expect(restored.status).toBe("fulfilled");
      const publishes = (await revisionsOf(ctx, entry.id)).filter((r) => r.kind === "publish").length;
      if (published.status === "fulfilled") {
        expect(publishes).toBe(publishesBefore + 1);
        expect(await publicText(address, "/blog/rye-season")).toEqual([`Live ${round}`]);
      } else {
        // The restore took the entry first: the draft is no longer the version Publish was asked for.
        expect(published.reason).toMatchObject({ message: NEWER_SAVE });
        expect(publishes).toBe(publishesBefore);
      }
      expect(textOf((await draftOf(ctx, entry.id)).content)).toEqual(["One"]);
    }
  });

  it("a restore racing the scheduled publish: the frozen revision goes live, the restored one stays in the draft", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    for (let round = 0; round < 3; round++) {
      const { entry } = await createEntry(ctx, { type: "post", title: `Timed ${round}` });
      await save(ctx, entry.id, { content: doc("Old") });
      await snapshot(ctx, entry.id);
      const [old] = await revisionsOf(ctx, entry.id);
      await save(ctx, entry.id, { content: doc("Frozen") });
      const local = toLocalInput(new Date(Date.now() + 2 * HOUR), "UTC");
      const at = (zonedToUtc(local, "UTC") as { ok: true; at: Date }).at;
      await scheduleEntry(ctx, entry.id, { runAt: local, version: await versionOf(ctx, entry.id) });
      const [, restored] = await Promise.allSettled([
        runJobs({ registry: createJobRegistry([publishScheduled]), budgetMs: 20_000, now: () => new Date(at.getTime() + 1_000) }),
        restoreRevision(ctx, entry.id, { revisionId: old!.id, version: await versionOf(ctx, entry.id) }),
      ]);
      expect(restored.status).toBe("fulfilled");
      expect(await entryOf(ctx, entry.id)).toMatchObject({ status: "published" });
      expect(await publicText(address, `/blog/timed-${round}`)).toEqual(["Frozen"]);
      expect(textOf((await draftOf(ctx, entry.id)).content)).toEqual(["Old"]);
    }
  });
});

describe("a step that fails leaves everything as it was", () => {
  it.each([
    ["the revision", "entry_revisions", "insert", false],
    ["the draft", "entry_drafts", "update", false],
    ["the record", "audit_logs", "insert", false],
    ["the commit", "entry_revisions", "insert", true],
  ] as const)("restore: %s", async (_name, table, event, atCommit) => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const { entry, revisions } = await postWithHistory(ctx);
    const draft = await draftOf(ctx, entry.id);
    await expect(whileFailing(table, event, () => restoreRevision(ctx, entry.id, { revisionId: revisions[0]!.id, version: draft.version }), { atCommit })).rejects.toThrow();
    expect(await draftOf(ctx, entry.id)).toEqual(draft);
    expect(await revisionsOf(ctx, entry.id)).toEqual(revisions);
    expect(await records(ctx, "entry.revision_restored", entry.id)).toEqual([]);
  });

  it.each([
    ["the kept revision", "entry_revisions", "insert", false],
    ["the draft", "entry_drafts", "update", false],
    ["the record", "audit_logs", "insert", false],
    ["the commit", "audit_logs", "insert", true],
  ] as const)("overwrite: %s", async (_name, table, event, atCommit) => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const { entry } = await createEntry(ctx, { type: "post", title: "Atomic" });
    await save(ctx, entry.id, { content: doc("Theirs") });
    const draft = await draftOf(ctx, entry.id);
    await expect(
      whileFailing(table, event, () => overwriteDraft(ctx, entry.id, { replaceVersion: draft.version, draft: { content: doc("Mine") } }), { atCommit }),
    ).rejects.toThrow();
    expect(await draftOf(ctx, entry.id)).toEqual(draft);
    expect(await revisionsOf(ctx, entry.id)).toEqual([]);
  });

  it("save: the revision cannot be written, so there is none, and the draft is as it was", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const { entry } = await createEntry(ctx, { type: "post", title: "Not kept" });
    const draft = await draftOf(ctx, entry.id);
    await expect(whileFailing("entry_revisions", "insert", () => snapshot(ctx, entry.id))).rejects.toThrow();
    expect(await revisionsOf(ctx, entry.id)).toEqual([]);
    expect(await draftOf(ctx, entry.id)).toEqual(draft);
  });
});
