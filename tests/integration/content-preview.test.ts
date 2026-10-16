import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  canSeeEntry, createEntry, createPreviewLink, getEntryForEditor, overwriteDraft, PREVIEWS_OFF, publishEntry, restoreRevision, saveDraft, saveRevision, scheduleEntry,
  submitPreviewLink, toLocalInput, trashEntry,
} from "@/modules/content";
import { roleMaySeeEntry } from "@/modules/content/shared";
import { createSite } from "@/modules/sites";
import { changeMemberRole, inTenant, resolveSiteContext, type SiteContext } from "@/modules/tenancy";
import * as t from "@/platform/db/schema";
import { withTenant } from "@/platform/db/tenant";
import { DEVELOPMENT_PREVIEW_SECRET, PREVIEW_TOKEN_TTL_SECONDS, signPreviewToken, verifyPreviewToken } from "@/platform/routing/preview-token";
import { createMedia as createMediaRow } from "../fixtures/factories";
import { addMember, newSlug, newTenant, refusalOf } from "../fixtures/tenants";

// The public reads' cache calls are noted: a preview flushes nothing, and its private reads are never cached.
const cache = vi.hoisted(() => ({ applied: [] as string[], flushed: [] as string[] }));
vi.mock("next/cache", async (original) => ({
  ...(await original<typeof import("next/cache")>()),
  cacheLife: () => {},
  cacheTag: (...names: string[]) => void cache.applied.push(...names),
  revalidateTag: (tag: string) => void cache.flushed.push(tag),
  updateTag: (tag: string) => void cache.flushed.push(tag),
}));
const { loadPreview, publicPageFor, loadPublicSite, resolveSite, previewLines } = await import("@/modules/rendering");

/**
 * M7-4 against real Postgres through PgBouncer: preview links (who may get one, what they name) and the preview itself
 * (the draft or a revision, drawn from what is stored now, for the person the token names as they are now). Nothing
 * here may write a row, record an event, or flush or fill a cache with anything private.
 */

type Tenant = Awaited<ReturnType<typeof newTenant>>;
const HOUR = 3_600_000;

async function liveSite(tenant: Tenant, name = "Previews") {
  const address = newSlug("prev");
  const { site } = await createSite(tenant.ctx, { name, address, language: "en", timezone: "UTC" });
  const ctx = await resolveSiteContext(tenant.actor, tenant.org.slug, site.slug);
  await withTenant({ orgId: tenant.org.id }, (tx) => tx.update(t.sites).set({ status: "live" }).where(eq(t.sites.id, site.id)));
  return { site, ctx, address };
}
const para = (text: string) => ({ type: "paragraph", attrs: { id: uuidv7() }, content: [{ type: "text", text }] });
const doc = (...content: unknown[]) => ({ v: 1, doc: { type: "doc", content: content.map((c) => (typeof c === "string" ? para(c) : c)) } });
const imageBlock = (mediaId: string) => ({ type: "image", attrs: { id: uuidv7(), v: 1, mediaId, alt: null, caption: null, size: "content", link: null } });
const textOf = (content: unknown) => JSON.stringify(content).match(/"text":"([^"]*)"/g)?.map((m) => m.slice(8, -1)) ?? [];
const versionOf = async (ctx: SiteContext, entryId: string) =>
  (await inTenant(ctx, (tx) => tx.select({ version: t.entryDrafts.version }).from(t.entryDrafts).where(eq(t.entryDrafts.entryId, entryId))))[0]!.version;
const save = async (ctx: SiteContext, entryId: string, draft: Record<string, unknown>) => saveDraft(ctx, entryId, await versionOf(ctx, entryId), draft);
const revisionsOf = (ctx: SiteContext, entryId: string) =>
  inTenant(ctx, (tx) => tx.select().from(t.entryRevisions).where(eq(t.entryRevisions.entryId, entryId)).orderBy(asc(t.entryRevisions.number)));
/** A ready image with its width variants (what a processed upload has, M6-2): only such an image is ever drawn. */
async function createMedia(ids: { orgId: string; siteId: string; userId: string }) {
  const { media } = await createMediaRow(ids);
  const base = media.storageKey.replace(/\/original\.jpg$/, "");
  const variants = [{ key: "w800", format: "webp" as const, width: 800, height: 600, sizeBytes: 100, storageKey: `${base}/w800/photo.webp` }];
  await withTenant({ orgId: ids.orgId }, (tx) => tx.update(t.mediaAssets).set({ width: 1600, height: 1200, variants }).where(eq(t.mediaAssets.id, media.id)));
  return { media };
}
const tokenOf = (link: { path: string }) => link.path.split("/").at(-1)!;
const preview = async (ctx: SiteContext, entryId: string, revisionId?: string) => loadPreview(tokenOf(await createPreviewLink(ctx, entryId, { revisionId })));
const publicText = async (address: string, path: string) => {
  const resolved = (await resolveSite({ kind: "address", address }))!;
  const page = await publicPageFor((await loadPublicSite(resolved.orgId, resolved.siteId))!, path.slice(1).split("/"));
  return page?.kind === "entry" ? textOf(page.entry.content) : null;
};
/** Every row of the organization that the content, its history, its records or the queue could hold, digested. */
async function stateOf(orgId: string) {
  const rows = await withTenant({ orgId }, async (tx) => {
    const tables = ["entries", "entry_drafts", "entry_revisions", "entry_terms", "audit_logs", "media_assets"];
    const out: unknown[] = [];
    for (const table of tables) out.push((await tx.execute(sql`select * from ${sql.identifier(table)} where organization_id = ${orgId} order by 1`)).rows);
    out.push((await tx.execute(sql`select id, status, run_at from jobs where organization_id = ${orgId} order by id`)).rows);
    return out;
  });
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

afterEach(() => vi.unstubAllEnvs());
afterAll(() => vi.restoreAllMocks());

describe("a preview link", () => {
  it("names the organization, the site, the entry, the user and (for a revision) the revision, signed, for 15 minutes; read-only", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const { entry } = await createEntry(ctx, { type: "post", title: "Linked" });
    await saveRevision(ctx, entry.id, { version: 1 });
    const [revision] = await revisionsOf(ctx, entry.id);
    const before = await stateOf(a.org.id);
    cache.flushed.length = 0;

    const link = await createPreviewLink(ctx, entry.id);
    expect(link.path).toMatch(/^\/_forge\/preview\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    const claims = verifyPreviewToken(tokenOf(link), DEVELOPMENT_PREVIEW_SECRET, Date.now())!;
    expect(claims).toMatchObject({ orgId: a.org.id, siteId: ctx.site.id, entryId: entry.id, userId: a.user.id, revisionId: null });
    expect(claims.expiresAt * 1000 - Date.now()).toBeGreaterThan((PREVIEW_TOKEN_TTL_SECONDS - 5) * 1000);
    expect(claims.expiresAt * 1000 - Date.now()).toBeLessThanOrEqual(PREVIEW_TOKEN_TTL_SECONDS * 1000);
    expect(new Date(link.expiresAt).getTime()).toBe(claims.expiresAt * 1000);
    expect(verifyPreviewToken(tokenOf(await createPreviewLink(ctx, entry.id, { revisionId: revision!.id })), DEVELOPMENT_PREVIEW_SECRET, Date.now())).toMatchObject({ revisionId: revision!.id });

    expect(await stateOf(a.org.id)).toBe(before);
    expect(cache.flushed).toEqual([]);
  });

  it("is for whoever may see the entry: every member reads it, an Author only their own posts and no pages; a revision of another entry, another site's entry, the trash are not found", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    const { site: other } = await createSite(a.ctx, { name: "Other", address: newSlug("prev"), language: "en", timezone: "UTC" });
    const otherCtx = await resolveSiteContext(a.actor, a.org.slug, other.slug);
    const { entry: page } = await createEntry(ctx, { type: "page", title: "About" });
    const { entry: post } = await createEntry(ctx, { type: "post", title: "Owner's" });
    const contexts: Record<string, SiteContext> = { owner: ctx };
    for (const role of ["admin", "editor", "author", "viewer"] as const) contexts[role] = await resolveSiteContext((await addMember(a.org, role)).actor, a.org.slug, site.slug);
    const authorsOwn = (await createEntry(contexts.author!, { type: "post", title: "Author's own" })).entry;

    for (const role of ["owner", "admin", "editor", "viewer"]) {
      for (const id of [page.id, post.id, authorsOwn.id]) await expect(createPreviewLink(contexts[role]!, id), `${role} ${id}`).resolves.toMatchObject({ path: expect.any(String) });
    }
    await expect(createPreviewLink(contexts.author!, authorsOwn.id)).resolves.toMatchObject({ path: expect.any(String) });
    for (const id of [page.id, post.id]) expect((await refusalOf(() => createPreviewLink(contexts.author!, id))).kind).toBe("NotFound");

    // The preview's own rule (asked of a role) answers as the editor's does, for every role (real contexts).
    for (const [role, roleCtx] of Object.entries(contexts)) {
      for (const entry of [page, post, authorsOwn]) {
        const ref = { type: entry.type, organizationId: a.org.id, authorId: entry.authorId };
        expect(roleMaySeeEntry(role, roleCtx.actor.userId, ref), `${role} ${entry.title}`).toBe(canSeeEntry(roleCtx, ref));
      }
    }

    const { entry: elsewhere } = await createEntry(otherCtx, { type: "post", title: "Elsewhere" });
    await saveRevision(otherCtx, elsewhere.id, { version: 1 });
    const [foreign] = await revisionsOf(otherCtx, elsewhere.id);
    expect((await refusalOf(() => createPreviewLink(ctx, post.id, { revisionId: foreign!.id }))).kind).toBe("NotFound");
    expect((await refusalOf(() => createPreviewLink(ctx, elsewhere.id))).kind).toBe("NotFound");
    expect((await refusalOf(() => createPreviewLink(ctx, post.id, { revisionId: "not-an-id" }))).kind).toBe("NotFound");
    await trashEntry(ctx, page.id);
    expect((await refusalOf(() => createPreviewLink(ctx, page.id))).kind).toBe("NotFound");
    // Through its action: the same answers.
    expect(await submitPreviewLink(a.actor, a.org.slug, other.slug, post.id, undefined)).toMatchObject({ ok: false, code: "NotFound" });
    expect(await submitPreviewLink(a.actor, a.org.slug, site.slug, post.id, undefined)).toMatchObject({ ok: true });
  });

  it("is refused, saying so, where previews are not set up (no PREVIEW_TOKEN_SECRET away from localhost)", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const { entry } = await createEntry(ctx, { type: "post", title: "Off" });
    vi.stubEnv("APP_ORIGIN", "https://cms.example.com");
    vi.stubEnv("PREVIEW_TOKEN_SECRET", "");
    expect(await refusalOf(() => createPreviewLink(ctx, entry.id))).toMatchObject({ kind: "Unavailable", message: PREVIEWS_OFF });
    vi.stubEnv("PREVIEW_TOKEN_SECRET", "x".repeat(40));
    await expect(createPreviewLink(ctx, entry.id)).resolves.toMatchObject({ path: expect.any(String) });
  });
});

describe("the preview of the draft", () => {
  it("draws the draft as saved now (title, text, terms, featured image), not the published version; the published page and the history are untouched", async () => {
    const a = await newTenant();
    const { ctx, site, address } = await liveSite(a);
    const { media } = await createMedia({ orgId: a.org.id, siteId: site.id, userId: a.user.id });
    const { entry } = await createEntry(ctx, { type: "post", title: "Rye season" });
    const { version } = await save(ctx, entry.id, { content: doc("Published words") });
    await publishEntry(ctx, entry.id, version);
    await save(ctx, entry.id, { title: "Rye season, again", content: doc("Draft words", imageBlock(media.id)), featuredMediaId: media.id });
    const before = await stateOf(a.org.id);
    cache.applied.length = 0;
    cache.flushed.length = 0;

    const shown = (await preview(ctx, entry.id))!;
    expect(shown.entry).toMatchObject({ type: "post", title: "Rye season, again", path: "/blog/rye-season" });
    expect(textOf(shown.entry.content)).toEqual(["Draft words"]);
    expect(Object.keys(shown.entry.images)).toEqual([media.id]);
    expect(shown.entry.featuredImage).not.toBeNull();
    expect(shown.subject).toMatchObject({ kind: "draft", live: false });
    expect(shown.status).toBe("published");
    expect(shown.locator).toEqual({ kind: "address", address });
    expect(shown.gaps).toEqual({ broken: 0, missingImages: 0 });
    expect(previewLines(shown).lines[0]).toBe("Not published: visitors see the published version until this draft is published.");

    // Nothing written or flushed; the only cached reads it made are the public ones (the site, its live paths).
    expect(await stateOf(a.org.id)).toBe(before);
    expect(cache.flushed).toEqual([]);
    expect(cache.applied.every((tag) => !tag.includes(entry.id))).toBe(true);
    expect(await publicText(address, "/blog/rye-season")).toEqual(["Published words"]);

    // Once published, the draft preview says it is the published version.
    await publishEntry(ctx, entry.id, await versionOf(ctx, entry.id));
    expect((await preview(ctx, entry.id))!.subject).toMatchObject({ kind: "draft", live: true });
  });

  it("works on a site that is not live yet (Coming soon), and says so", async () => {
    const a = await newTenant();
    const { site } = await createSite(a.ctx, { name: "Soon", address: newSlug("prev"), language: "en", timezone: "UTC" });
    const ctx = await resolveSiteContext(a.actor, a.org.slug, site.slug);
    const { entry } = await createEntry(ctx, { type: "page", title: "Not yet" });
    await save(ctx, entry.id, { content: doc("Coming") });
    const shown = (await preview(ctx, entry.id))!;
    expect(textOf(shown.entry.content)).toEqual(["Coming"]);
    expect(previewLines(shown).lines).toContain("The site is not live yet: visitors see its Coming soon page.");
  });

  it("shows only what may be shown: images of this site that are usable now (never another site's, a trashed one or an original), links to live pages of this site", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    const { site: other } = await createSite(a.ctx, { name: "Other", address: newSlug("prev"), language: "en", timezone: "UTC" });
    const ids = { orgId: a.org.id, siteId: site.id, userId: a.user.id };
    const { media: usable } = await createMedia(ids);
    const { media: trashed } = await createMedia(ids);
    const { media: foreign } = await createMedia({ ...ids, siteId: other.id });
    const { entry: live } = await createEntry(ctx, { type: "page", title: "Live" });
    await publishEntry(ctx, live.id, 1);
    const { entry: draftPage } = await createEntry(ctx, { type: "page", title: "Draft" });
    const otherCtx = await resolveSiteContext(a.actor, a.org.slug, other.slug);
    const { entry: otherLive } = await createEntry(otherCtx, { type: "page", title: "Other live" });
    await publishEntry(otherCtx, otherLive.id, 1);
    const link = (id: string) => ({ type: "paragraph", attrs: { id: uuidv7() }, content: [{ type: "text", text: "go", marks: [{ type: "link", attrs: { href: `entry:${id}` } }] }] });
    const { entry } = await createEntry(ctx, { type: "post", title: "Mixed" });
    await save(ctx, entry.id, { content: doc(imageBlock(usable.id), imageBlock(trashed.id), link(live.id), link(draftPage.id)) });
    await saveRevision(ctx, entry.id, { version: await versionOf(ctx, entry.id) });
    const [revision] = await revisionsOf(ctx, entry.id);
    // Written behind the app's back, as an old or damaged revision could be: another site's image and page.
    const content = doc(imageBlock(foreign.id), link(otherLive.id));
    const forged = uuidv7();
    await withTenant({ orgId: a.org.id }, (tx) => tx.insert(t.entryRevisions).values({ ...revision!, id: forged, number: 2, content }));
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.mediaAssets).set({ deletedAt: new Date() }).where(eq(t.mediaAssets.id, trashed.id)));

    const shown = (await preview(ctx, entry.id))!;
    expect(Object.keys(shown.entry.images)).toEqual([usable.id]);
    expect(JSON.stringify(shown.entry.images)).not.toMatch(/original/);
    expect(shown.gaps.missingImages).toBe(1);
    expect(shown.links).toEqual({ [live.id]: "/live" });
    const old = (await preview(ctx, entry.id, forged))!;
    expect(old.entry.images).toEqual({});
    expect(old.links).toEqual({});
    expect(old.gaps.missingImages).toBe(1);
  });
});

describe("the preview of a revision", () => {
  it("draws that revision as it was saved, for every kind, saying which it is: Live, the schedule's frozen one, or neither", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const { entry } = await createEntry(ctx, { type: "post", title: "Kinds" });
    await save(ctx, entry.id, { content: doc("Saved") });
    await saveRevision(ctx, entry.id, { version: await versionOf(ctx, entry.id), label: "First" });
    await save(ctx, entry.id, { content: doc("Published") });
    await publishEntry(ctx, entry.id, await versionOf(ctx, entry.id));
    await save(ctx, entry.id, { content: doc("Later") });
    const [saved, published] = await revisionsOf(ctx, entry.id);
    await restoreRevision(ctx, entry.id, { revisionId: saved!.id, version: await versionOf(ctx, entry.id) });
    const restoredRevision = (await revisionsOf(ctx, entry.id)).find((r) => r.kind === "restore")!;
    const before = await stateOf(a.org.id);

    const first = (await preview(ctx, entry.id, saved!.id))!;
    expect(textOf(first.entry.content)).toEqual(["Saved"]);
    expect(first.subject).toEqual({ kind: "revision", number: 1, revisionKind: "save", label: "First", createdAt: saved!.createdAt.toISOString(), live: false, scheduledFor: null });
    expect(previewLines(first)).toMatchObject({ title: "Preview of revision 1 · Saved · First" });
    expect(previewLines(first).lines).toContain("Visitors do not see this revision.");
    const liveOne = (await preview(ctx, entry.id, published!.id))!;
    expect(textOf(liveOne.entry.content)).toEqual(["Published"]);
    expect(liveOne.subject).toMatchObject({ revisionKind: "publish", live: true });
    expect(previewLines(liveOne).lines).toContain("Visitors see this revision now.");
    expect((await preview(ctx, entry.id, restoredRevision.id))!.subject).toMatchObject({ revisionKind: "restore", live: false });
    expect(await stateOf(a.org.id)).toBe(before);
    expect(await publicText(address, "/blog/kinds")).toEqual(["Published"]);

    // A scheduled entry: its frozen revision says when it publishes; the draft's later changes are not in it.
    const { entry: timed } = await createEntry(ctx, { type: "post", title: "Timed" });
    await save(ctx, timed.id, { content: doc("Frozen") });
    const local = toLocalInput(new Date(Date.now() + 2 * HOUR), "UTC");
    const { runAt } = await scheduleEntry(ctx, timed.id, { runAt: local, version: await versionOf(ctx, timed.id) });
    await save(ctx, timed.id, { content: doc("Typed after") });
    const frozen = (await revisionsOf(ctx, timed.id)).find((r) => r.kind === "scheduled")!;
    const frozenPreview = (await preview(ctx, timed.id, frozen.id))!;
    expect(textOf(frozenPreview.entry.content)).toEqual(["Frozen"]);
    expect(frozenPreview.subject).toMatchObject({ revisionKind: "scheduled", scheduledFor: runAt.toISOString(), live: false });
    const draftPreview = (await preview(ctx, timed.id))!;
    expect(textOf(draftPreview.entry.content)).toEqual(["Typed after"]);
    expect(previewLines(draftPreview).lines[0]).toBe("Not published: the schedule publishes the version frozen when it was scheduled, not this draft.");
    expect(await inTenant(ctx, (tx) => tx.select({ status: t.entries.status, scheduledAt: t.entries.scheduledAt }).from(t.entries).where(eq(t.entries.id, timed.id)))).toEqual([
      { status: "scheduled", scheduledAt: runAt },
    ]);
  });

  it("draws what it can of a revision that is no longer valid (unknown blocks, broken settings), saying how much it cannot show; the revision is left as it is", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const { entry } = await createEntry(ctx, { type: "post", title: "Legacy" });
    await saveRevision(ctx, entry.id, { version: 1 });
    const [revision] = await revisionsOf(ctx, entry.id);
    const legacy = uuidv7();
    const content = {
      v: 1,
      doc: {
        type: "doc",
        content: [para("Still here"), { type: "script", attrs: { id: uuidv7() }, content: [{ type: "text", text: "alert(1)" }] }, { type: "heading", attrs: { id: uuidv7(), level: 9 }, content: [{ type: "text", text: "Bad level" }] }],
      },
    };
    await withTenant({ orgId: a.org.id }, (tx) => tx.insert(t.entryRevisions).values({ ...revision!, id: legacy, number: 2, content }));
    const shown = (await preview(ctx, entry.id, legacy))!;
    expect(shown.gaps.broken).toBe(2);
    expect(previewLines(shown).lines).toContain("2 parts of it cannot be shown: they are not blocks this version of Forge has, or no longer valid.");
    expect((await revisionsOf(ctx, entry.id))[1]!.content).toEqual(content);
  });
});

describe("a preview's token is checked again when it is opened, with the person's rights as they are then", () => {
  it("nothing for a token that is tampered with, expired, signed with another secret, or naming what it may not show", async () => {
    const a = await newTenant();
    const b = await newTenant("B");
    const { ctx } = await liveSite(a);
    const { ctx: bCtx } = await liveSite(b);
    const { entry } = await createEntry(ctx, { type: "post", title: "Guarded" });
    const { entry: theirs } = await createEntry(bCtx, { type: "post", title: "Theirs" });
    await saveRevision(bCtx, theirs.id, { version: 1 });
    const [theirRevision] = await revisionsOf(bCtx, theirs.id);
    const token = tokenOf(await createPreviewLink(ctx, entry.id));
    expect(await loadPreview(token)).not.toBeNull();

    const [payload, signature] = token.split(".") as [string, string];
    expect(await loadPreview(`${payload}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`)).toBeNull();
    expect(await loadPreview(token, Date.now() + (PREVIEW_TOKEN_TTL_SECONDS + 1) * 1000)).toBeNull();
    const claims = verifyPreviewToken(token, DEVELOPMENT_PREVIEW_SECRET, Date.now())!;
    expect(await loadPreview(signPreviewToken(claims, "y".repeat(40)))).toBeNull();
    // Signed correctly (as only the server can), but naming what A's owner may not see: B's entry, under A's site or B's,
    // and B's revision under A's entry. One answer: nothing.
    const sign = (over: Partial<typeof claims>) => signPreviewToken({ ...claims, ...over }, DEVELOPMENT_PREVIEW_SECRET);
    expect(await loadPreview(sign({ entryId: theirs.id }))).toBeNull();
    expect(await loadPreview(sign({ orgId: b.org.id, siteId: bCtx.site.id, entryId: theirs.id }))).toBeNull();
    expect(await loadPreview(sign({ revisionId: theirRevision!.id }))).toBeNull();
    expect(await loadPreview(sign({ siteId: bCtx.site.id }))).toBeNull();
    // A revision of another entry of the same site: looked up in the entry the token names, so nothing.
    const { entry: sibling } = await createEntry(ctx, { type: "post", title: "Sibling" });
    await saveRevision(ctx, sibling.id, { version: 1 });
    const [siblingRevision] = await revisionsOf(ctx, sibling.id);
    expect(await loadPreview(sign({ revisionId: siblingRevision!.id }))).toBeNull();
    expect(await loadPreview(signPreviewToken({ ...claims, entryId: sibling.id, revisionId: siblingRevision!.id }, DEVELOPMENT_PREVIEW_SECRET))).not.toBeNull();
  });

  it("nothing once the person is removed or may no longer see it, or the entry is in the trash or deleted, or the revision is gone", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    const editor = await addMember(a.org, "editor");
    const editorCtx = await resolveSiteContext(editor.actor, a.org.slug, site.slug);
    const { entry: page } = await createEntry(ctx, { type: "page", title: "Page" });
    const pageToken = tokenOf(await createPreviewLink(editorCtx, page.id));
    expect(await loadPreview(pageToken)).not.toBeNull();
    // Demoted to Author, who sees no pages: the token they were given shows nothing now.
    await changeMemberRole(a.ctx, { memberId: editor.memberId, role: "author" });
    expect(await loadPreview(pageToken)).toBeNull();
    await changeMemberRole(a.ctx, { memberId: editor.memberId, role: "editor" });
    expect(await loadPreview(pageToken)).not.toBeNull();
    await withTenant({ orgId: a.org.id }, (tx) => tx.delete(t.organizationMembers).where(eq(t.organizationMembers.id, editor.memberId)));
    expect(await loadPreview(pageToken)).toBeNull();

    const { entry } = await createEntry(ctx, { type: "post", title: "Going" });
    await saveRevision(ctx, entry.id, { version: 1 });
    const [revision] = await revisionsOf(ctx, entry.id);
    const draftToken = tokenOf(await createPreviewLink(ctx, entry.id));
    const revisionToken = tokenOf(await createPreviewLink(ctx, entry.id, { revisionId: revision!.id }));
    await withTenant({ orgId: a.org.id }, (tx) => tx.delete(t.entryRevisions).where(eq(t.entryRevisions.id, revision!.id)));
    expect(await loadPreview(revisionToken)).toBeNull();
    expect(await loadPreview(draftToken)).not.toBeNull();
    await trashEntry(ctx, entry.id);
    expect(await loadPreview(draftToken)).toBeNull();
    await withTenant({ orgId: a.org.id }, (tx) => tx.delete(t.entries).where(eq(t.entries.id, entry.id)));
    expect(await loadPreview(draftToken)).toBeNull();

    // A deleted site, or one that is not shown (suspended): nothing.
    const { entry: last } = await createEntry(ctx, { type: "post", title: "Last" });
    const lastToken = tokenOf(await createPreviewLink(ctx, last.id));
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.sites).set({ status: "suspended" }).where(eq(t.sites.id, site.id)));
    expect(await loadPreview(lastToken)).toBeNull();
  });
});

describe("viewing changes nothing, and editing goes on around it", () => {
  it("a preview between saves, an overwrite and a restore: the draft, the history, the records and the public page are only what those did", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const { entry } = await createEntry(ctx, { type: "post", title: "Around" });
    const { version } = await save(ctx, entry.id, { content: doc("Live") });
    await publishEntry(ctx, entry.id, version);
    await save(ctx, entry.id, { content: doc("Draft one") });
    const before = await stateOf(a.org.id);
    const token = tokenOf(await createPreviewLink(ctx, entry.id));
    for (let i = 0; i < 3; i++) expect(textOf((await loadPreview(token))!.entry.content)).toEqual(["Draft one"]);
    expect(await stateOf(a.org.id)).toBe(before);
    // The same link shows the draft as it is when it is opened: it is read each time, never kept.
    await save(ctx, entry.id, { content: doc("Draft two") });
    expect(textOf((await loadPreview(token))!.entry.content)).toEqual(["Draft two"]);
    await overwriteDraft(ctx, entry.id, { replaceVersion: await versionOf(ctx, entry.id), draft: { content: doc("Draft three") } });
    expect(textOf((await loadPreview(token))!.entry.content)).toEqual(["Draft three"]);
    expect((await getEntryForEditor(ctx, entry.id, "post")).draft.version).toBe(await versionOf(ctx, entry.id));
    expect(await publicText(address, "/blog/around")).toEqual(["Live"]);
    expect(await inTenant(ctx, (tx) => tx.select().from(t.auditLogs).where(and(eq(t.auditLogs.organizationId, a.org.id), eq(t.auditLogs.resourceId, entry.id))))).toHaveLength(3);
  });
});
