import { and, eq, inArray, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DAILY_JOBS, jobRegistry } from "@/app/api/internal/cron/jobs";
import {
  createEntry, ENTRY_TRASH_DAYS, listPages, listPosts, movePage, publishEntry, purgeEntry, purgeTrashedEntries, restoreEntry, saveDraft, submitRestoreEntry, submitTrashEntry,
  trashEntry, trashPurge, unpublishEntry,
} from "@/modules/content";
import { completeUpload, mediaUsage, requestUploads, restoreMedia, submitTrashMedia, trashMedia, TRASH_DAYS } from "@/modules/media";
import { createSite, setSiteImage } from "@/modules/sites";
import { inTenant, resolveSiteContext, type SiteContext } from "@/modules/tenancy";
import { tags, tagsForAll } from "@/platform/cache";
import * as t from "@/platform/db/schema";
import { withTenant } from "@/platform/db/tenant";
import { setStorageDriverForTests } from "@/platform/storage/get-driver";
import { dbError } from "../fixtures/db-error";
import { whileFailing } from "../fixtures/db-failure";
import { imageOf, localDriver, removeTempDirs, send } from "../fixtures/media";
import { addMember, newSlug, newTenant, refusalOf } from "../fixtures/tenants";

// The renderer's reads are `'use cache'`. Outside Next their cache calls do nothing, except that each tag a read
// applies is noted, so the tests can check that an operation's cache events flush every read that showed the entry.
const applied = vi.hoisted(() => ({ tags: [] as string[] }));
vi.mock("next/cache", async (original) => ({
  ...(await original<typeof import("next/cache")>()),
  cacheLife: () => {},
  cacheTag: (...names: string[]) => void applied.tags.push(...names),
}));
const { loadPublicSite, publicPageFor, resolveSite } = await import("@/modules/rendering");

/**
 * M7-1 against real Postgres, as forge_app through PgBouncer: unpublish, the trash, restore and purge, with the
 * invariants the database and the services keep together (no published entry in the trash, a free path once trashed,
 * pages trashed and restored as a subtree, the Home page never trashed), their records, their cache events, and the
 * daily `trash.purge` that now deletes entries before media.
 */

beforeAll(async () => setStorageDriverForTests(await localDriver()));
afterAll(async () => {
  setStorageDriverForTests(null);
  await removeTempDirs();
});

type Tenant = Awaited<ReturnType<typeof newTenant>>;
const DAY = 24 * 3_600_000;

async function liveSite(tenant: Tenant, name = "Lifecycle") {
  const address = newSlug("life");
  const { site } = await createSite(tenant.ctx, { name, address, language: "en", timezone: "UTC" });
  const ctx = await resolveSiteContext(tenant.actor, tenant.org.slug, site.slug);
  await withTenant({ orgId: tenant.org.id }, (tx) => tx.update(t.sites).set({ status: "live" }).where(eq(t.sites.id, site.id)));
  return { site, ctx, address };
}
const doc = (...texts: string[]) => ({ v: 1, doc: { type: "doc", content: texts.map((text) => ({ type: "paragraph", attrs: { id: uuidv7() }, content: [{ type: "text", text }] })) } });
const linkTo = (entryId: string) => ({
  v: 1, doc: { type: "doc", content: [{ type: "paragraph", attrs: { id: uuidv7() }, content: [{ type: "text", text: "Read it", marks: [{ type: "link", attrs: { href: `entry:${entryId}` } }] }] }] },
});
const versionOf = async (ctx: SiteContext, entryId: string) =>
  (await inTenant(ctx, (tx) => tx.select({ version: t.entryDrafts.version }).from(t.entryDrafts).where(eq(t.entryDrafts.entryId, entryId))))[0]!.version;
async function publish(ctx: SiteContext, entryId: string, draft: Record<string, unknown> = {}) {
  const { version } = Object.keys(draft).length ? await saveDraft(ctx, entryId, await versionOf(ctx, entryId), draft) : { version: await versionOf(ctx, entryId) };
  return publishEntry(ctx, entryId, version);
}
const page = async (ctx: SiteContext, title: string, parentId?: string) => (await createEntry(ctx, { type: "page", title, ...(parentId ? { parentId } : {}) })).entry;
const post = async (ctx: SiteContext, title: string) => (await createEntry(ctx, { type: "post", title })).entry;
const rowOf = async (ctx: SiteContext, id: string) => (await inTenant(ctx, (tx) => tx.select().from(t.entries).where(eq(t.entries.id, id))))[0] ?? null;
const rowsOf = (ctx: SiteContext, ids: string[]) => inTenant(ctx, (tx) => tx.select().from(t.entries).where(inArray(t.entries.id, ids)));
const homeOf = async (ctx: SiteContext) =>
  (await inTenant(ctx, (tx) => tx.select({ id: t.siteSettings.homepageEntryId }).from(t.siteSettings).where(eq(t.siteSettings.siteId, ctx.site.id))))[0]!.id!;
const records = (ctx: SiteContext, action: string) =>
  inTenant(ctx, (tx) => tx.select().from(t.auditLogs).where(and(eq(t.auditLogs.organizationId, ctx.org.id), eq(t.auditLogs.action, action))));
const publicSite = async (address: string) => {
  const resolved = (await resolveSite({ kind: "address", address }))!;
  return (await loadPublicSite(resolved.orgId, resolved.siteId))!;
};
const at = async (address: string, path: string) => publicPageFor(await publicSite(address), path === "/" ? [] : path.slice(1).split("/"));
const backdate = (ctx: SiteContext, ids: string[], days: number) =>
  withTenant({ orgId: ctx.org.id }, (tx) => tx.update(t.entries).set({ deletedAt: sql`now() - make_interval(days => ${days})` }).where(inArray(t.entries.id, ids)));
async function term(ctx: SiteContext, slug: string) {
  const [row] = await inTenant(ctx, (tx) => tx.insert(t.terms).values({ organizationId: ctx.org.id, siteId: ctx.site.id, taxonomy: "category", name: slug, slug }).returning());
  return row!;
}

describe("unpublishing", () => {
  it("a published post leaves its path, the blog, its archive and every link to it at once; its revisions, date, draft and term choice stay; publishing again brings it back with its date", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const bread = await term(ctx, "bread");
    const rye = await post(ctx, "Rye season");
    await publish(ctx, rye.id, { content: doc("Dark and sour."), termIds: [bread.id] });
    const about = await page(ctx, "About");
    await publish(ctx, about.id, { content: linkTo(rye.id) });
    const first = (await rowOf(ctx, rye.id))!;

    // What the public reads tag while it is live.
    applied.tags.length = 0;
    expect(await at(address, first.path)).toMatchObject({ kind: "entry", entry: { title: "Rye season" } });
    expect(await at(address, "/blog")).toMatchObject({ kind: "blog-index", posts: [{ title: "Rye season" }] });
    expect(await at(address, "/blog/category/bread")).toMatchObject({ kind: "term-archive", posts: [{ title: "Rye season" }] });
    expect(await at(address, "/about")).toMatchObject({ kind: "entry", links: { [rye.id]: first.path } });
    const tagged = new Set(applied.tags);

    const result = await unpublishEntry(ctx, rye.id);
    expect(result).toMatchObject({ changed: true, entry: { status: "draft" } });
    // The real operation's events flush, at once, every read above that could show the post.
    const flushed = tagsForAll(result.events);
    for (const tag of [tags.entry(ctx.site.id, rye.id), tags.routes(ctx.site.id), tags.list(ctx.site.id, "post")]) {
      expect(tagged.has(tag), `${tag} was applied`).toBe(true);
      expect(flushed.immediate, tag).toContain(tag);
    }
    expect(await at(address, first.path)).toBeNull();
    expect(await at(address, "/blog")).toMatchObject({ kind: "blog-index", posts: [] });
    expect(await at(address, "/blog/category/bread")).toMatchObject({ kind: "term-archive", posts: [] });
    expect(await at(address, "/about")).toMatchObject({ kind: "entry", links: {} }); // the link is plain text now

    const row = (await rowOf(ctx, rye.id))!;
    expect(row).toMatchObject({ status: "draft", publishedRevisionId: null, publishedAt: first.publishedAt, firstPublishedAt: first.firstPublishedAt, path: first.path, deletedAt: null });
    expect(await inTenant(ctx, (tx) => tx.select().from(t.entryTerms).where(eq(t.entryTerms.entryId, rye.id)))).toEqual([]);
    expect(await inTenant(ctx, (tx) => tx.select().from(t.entryRevisions).where(eq(t.entryRevisions.entryId, rye.id)))).toHaveLength(1);
    expect((await inTenant(ctx, (tx) => tx.select().from(t.entryDrafts).where(eq(t.entryDrafts.entryId, rye.id))))[0]!.termIds).toEqual([bread.id]);
    expect((await records(ctx, "entry.unpublished"))[0]!.metadata).toEqual({ type: "post", title: "Rye season", path: first.path });

    // Again: nothing to do, nothing recorded or flushed.
    expect(await unpublishEntry(ctx, rye.id)).toMatchObject({ changed: false, events: [] });
    expect(await records(ctx, "entry.unpublished")).toHaveLength(1);

    // Published again: its first date, its category back.
    await publish(ctx, rye.id);
    expect((await rowOf(ctx, rye.id))!.publishedAt).toEqual(first.publishedAt);
    expect(await at(address, "/blog/category/bread")).toMatchObject({ posts: [{ title: "Rye season" }] });
  });

  it("the Home page: its address shows the site's name again; pages below a page stay published", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const home = await homeOf(ctx);
    await publish(ctx, home, { title: "Welcome", content: doc("Hello") });
    const team = await page(ctx, "Team");
    const parent = await page(ctx, "About");
    const child = await page(ctx, "History", parent.id);
    await publish(ctx, parent.id);
    await publish(ctx, child.id);
    await unpublishEntry(ctx, home);
    expect(await at(address, "/")).toEqual({ kind: "site-home" });
    await unpublishEntry(ctx, parent.id);
    expect(await at(address, "/about/history")).toMatchObject({ kind: "entry", entry: { title: "History" } });
    expect(team).toBeDefined();
  });

  it("who may: the publish right (an Author their own posts); another's post is not found to an Author; a Viewer is refused", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    const author = await addMember(a.org, "author");
    const viewer = await addMember(a.org, "viewer");
    const authorCtx = await resolveSiteContext(author.actor, a.org.slug, site.slug);
    const viewerCtx = await resolveSiteContext(viewer.actor, a.org.slug, site.slug);
    const theirs = await post(ctx, "Owner's");
    await publish(ctx, theirs.id);
    const mine = await post(authorCtx, "Author's");
    await publish(authorCtx, mine.id);
    expect((await refusalOf(() => unpublishEntry(authorCtx, theirs.id))).kind).toBe("NotFound");
    expect((await refusalOf(() => unpublishEntry(viewerCtx, theirs.id))).kind).toBe("Forbidden");
    expect(await unpublishEntry(authorCtx, mine.id)).toMatchObject({ changed: true });
    const home = await homeOf(ctx);
    await publish(ctx, home);
    expect((await refusalOf(() => unpublishEntry(authorCtx, home))).kind).toBe("NotFound"); // pages are hidden from an Author
  });

  it("a failed record leaves it published (one transaction)", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const rye = await post(ctx, "Rye");
    await publish(ctx, rye.id);
    expect((await dbError(whileFailing("audit_logs", "insert", () => unpublishEntry(ctx, rye.id)))).message).toMatch(/forced failure/);
    expect((await rowOf(ctx, rye.id))!.status).toBe("published");
  });
});

describe("the trash", () => {
  it("refused for a published entry (unpublish first) and for the Home page; nothing is written", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const rye = await post(ctx, "Rye");
    await publish(ctx, rye.id);
    expect(await refusalOf(() => trashEntry(ctx, rye.id))).toMatchObject({ kind: "Conflict", message: "It is published. Unpublish it first, then move it to the trash." });
    const home = await homeOf(ctx);
    expect((await refusalOf(() => trashEntry(ctx, home))).message).toMatch(/^This is the home page\. Make another page the home page first/);
    expect((await rowsOf(ctx, [rye.id, home])).map((row) => row.deletedAt)).toEqual([null, null]);
    expect(await records(ctx, "entry.trashed")).toEqual([]);
  });

  it("a draft goes, its address free at once: a new entry takes it unsuffixed; not in the lists; nothing public changes", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const about = await page(ctx, "About");
    const draftPost = await post(ctx, "Rye");
    applied.tags.length = 0;
    expect(await at(address, "/about")).toBeNull();
    const result = await trashEntry(ctx, about.id);
    expect(result).toMatchObject({ below: 0, events: [] });
    expect(await trashEntry(ctx, draftPost.id)).toMatchObject({ events: [] });
    const again = await page(ctx, "About");
    expect(again.path).toBe("/about");
    expect((await listPages(ctx)).items.map((item) => item.id)).not.toContain(about.id);
    expect((await listPosts(ctx, { sort: "updated", page: 1 })).items).toEqual([]);
    expect((await records(ctx, "entry.trashed")).map((r) => r.metadata)).toEqual(
      expect.arrayContaining([{ type: "page", title: "About", path: "/about", below: 0 }, { type: "post", title: "Rye", path: draftPost.path, below: 0 }]),
    );
    // Already in the trash: not found (it is no longer among the site's entries).
    expect((await refusalOf(() => trashEntry(ctx, about.id))).kind).toBe("NotFound");
  });

  it("a page goes with every page below it, at one moment; refused whole if one of them is published, or is the Home page", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const about = await page(ctx, "About");
    const team = await page(ctx, "Team", about.id);
    const people = await page(ctx, "People", team.id);
    await publish(ctx, people.id);
    expect((await refusalOf(() => trashEntry(ctx, about.id))).message).toBe(
      "1 page below it is published or scheduled (“People”). Unpublish it first: a page goes to the trash with every page below it.",
    );
    expect((await rowsOf(ctx, [about.id, team.id, people.id])).every((row) => row.deletedAt === null)).toBe(true);

    await unpublishEntry(ctx, people.id);
    expect(await trashEntry(ctx, about.id)).toMatchObject({ below: 2 });
    const rows = await rowsOf(ctx, [about.id, team.id, people.id]);
    expect(rows.every((row) => row.deletedAt !== null)).toBe(true);
    const moments = await inTenant(ctx, (tx) =>
      tx.execute<{ n: number }>(sql`select count(distinct deleted_at)::int as n from entries where id in (${about.id}, ${team.id}, ${people.id})`),
    );
    expect(moments.rows[0]!.n).toBe(1);

    // The Home page below a page keeps that page out of the trash.
    const host = await page(ctx, "Host");
    await movePage(ctx, await homeOf(ctx), host.id);
    expect((await refusalOf(() => trashEntry(ctx, host.id))).message).toMatch(/^The home page is below it/);
  });

  it("who may: the delete right; an Author their own posts only, and no pages; a Viewer is refused", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    const author = await addMember(a.org, "author");
    const viewer = await addMember(a.org, "viewer");
    const authorCtx = await resolveSiteContext(author.actor, a.org.slug, site.slug);
    const viewerCtx = await resolveSiteContext(viewer.actor, a.org.slug, site.slug);
    const theirs = await post(ctx, "Owner's");
    const mine = await post(authorCtx, "Author's");
    const about = await page(ctx, "About");
    expect((await refusalOf(() => trashEntry(authorCtx, theirs.id))).kind).toBe("NotFound");
    expect((await refusalOf(() => trashEntry(authorCtx, about.id))).kind).toBe("NotFound");
    expect((await refusalOf(() => trashEntry(viewerCtx, theirs.id))).kind).toBe("Forbidden");
    expect(await trashEntry(authorCtx, mine.id)).toMatchObject({ below: 0 });
    // Their trash shows their own posts only.
    expect((await listPosts(authorCtx, { status: "trash", sort: "updated", page: 1 })).items.map((item) => item.id)).toEqual([mine.id]);
    await trashEntry(ctx, theirs.id);
    expect((await listPosts(authorCtx, { status: "trash", sort: "updated", page: 1 })).items.map((item) => item.id)).toEqual([mine.id]);
    expect((await listPosts(ctx, { status: "trash", sort: "updated", page: 1 })).items.map((item) => item.id).sort()).toEqual([mine.id, theirs.id].sort());
    // And an Author may restore theirs, not purge it (that takes delete.any).
    expect((await refusalOf(() => purgeEntry(authorCtx, mine.id))).kind).toBe("Forbidden");
    expect(await restoreEntry(authorCtx, mine.id)).toMatchObject({ entry: { status: "draft" } });
  });

  it("a failed record trashes nothing: the page and the pages below it are as they were", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const about = await page(ctx, "About");
    const team = await page(ctx, "Team", about.id);
    expect((await dbError(whileFailing("audit_logs", "insert", () => trashEntry(ctx, about.id), { atCommit: true }))).message).toMatch(/forced failure/);
    expect((await rowsOf(ctx, [about.id, team.id])).every((row) => row.deletedAt === null)).toBe(true);
  });

  it("the form: success names what went with it and where the trash is; a published entry's refusal is said as is", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    const about = await page(ctx, "About");
    await page(ctx, "Team", about.id);
    expect(await submitTrashEntry(a.actor, a.org.slug, site.slug, about.id, new FormData())).toMatchObject({
      state: { status: "success", message: "Moved to the trash, with 1 page below it. It can be restored for 30 days.", values: { trashPath: `/${a.org.slug}/sites/${site.slug}/pages?status=trash` } },
    });
    const rye = await post(ctx, "Rye");
    await publish(ctx, rye.id);
    expect(await submitTrashEntry(a.actor, a.org.slug, site.slug, rye.id, new FormData())).toMatchObject({
      refused: "Conflict", state: { status: "error", message: "It is published. Unpublish it first, then move it to the trash." },
    });
  });
});

describe("restoring", () => {
  it("as a draft, with the pages trashed with it, at their addresses; never republished; recorded", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const about = await page(ctx, "About");
    const team = await page(ctx, "Team", about.id);
    await publish(ctx, about.id);
    await unpublishEntry(ctx, about.id);
    await trashEntry(ctx, about.id);
    expect(await restoreEntry(ctx, about.id)).toMatchObject({ entry: { status: "draft", path: "/about" }, below: 1, events: [] });
    expect((await rowsOf(ctx, [about.id, team.id])).map((row) => [row.status, row.path, row.deletedAt])).toEqual(
      expect.arrayContaining([["draft", "/about", null], ["draft", "/about/team", null]]),
    );
    expect(await at(address, "/about")).toBeNull(); // a draft: not public until published again
    expect((await records(ctx, "entry.restored"))[0]!.metadata).toEqual({ type: "page", title: "About", path: "/about", below: 1 });
    expect((await refusalOf(() => restoreEntry(ctx, about.id))).kind).toBe("NotFound"); // not in the trash any more
  });

  it("refused, naming the address, when it or a page below it is taken now; nothing is restored (no suffix, nothing overwritten)", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const about = await page(ctx, "About");
    const team = await page(ctx, "Team", about.id);
    await trashEntry(ctx, about.id);
    const taker = await page(ctx, "About");
    expect(taker.path).toBe("/about");
    expect(await refusalOf(() => restoreEntry(ctx, about.id))).toMatchObject({
      kind: "Conflict", message: "The address /about is now used by “About”. Give that one another address, then restore this page. Nothing was restored.",
    });
    expect((await rowsOf(ctx, [about.id, team.id])).every((row) => row.deletedAt !== null)).toBe(true);
    expect((await rowOf(ctx, taker.id))!.path).toBe("/about");

    // Only a page below it is taken (an entry put at that address behind the services' back, as a stand-in for any way one could get there).
    await trashEntry(ctx, taker.id);
    await withTenant({ orgId: a.org.id }, (tx) =>
      tx.insert(t.entries).values({ organizationId: a.org.id, siteId: ctx.site.id, type: "page", locale: "en", title: "Squatter", slug: "team", path: "/about/team" }),
    );
    expect((await refusalOf(() => restoreEntry(ctx, about.id))).message).toMatch(/^The address \/about\/team is now used by “Squatter”/);
    expect((await rowsOf(ctx, [about.id, team.id])).every((row) => row.deletedAt !== null)).toBe(true);
  });

  it("the page above must not be in the trash: restore it first; a page trashed on its own before stays in the trash when its parent comes back", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const about = await page(ctx, "About");
    const team = await page(ctx, "Team", about.id);
    const history = await page(ctx, "History", about.id);
    await trashEntry(ctx, team.id);
    await trashEntry(ctx, about.id); // with History; Team was already there
    expect((await refusalOf(() => restoreEntry(ctx, team.id))).message).toBe("The page above it is in the trash. Restore that page first.");
    expect(await restoreEntry(ctx, about.id)).toMatchObject({ below: 1 });
    expect((await rowsOf(ctx, [about.id, history.id, team.id])).map((row) => [row.title, row.deletedAt === null])).toEqual(
      expect.arrayContaining([["About", true], ["History", true], ["Team", false]]),
    );
    expect(await restoreEntry(ctx, team.id)).toMatchObject({ entry: { path: "/about/team" } });
  });

  it("follows its parent's move: a page restored under a parent that moved meanwhile gets the parent's address, as a live one would have", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const company = await page(ctx, "Company");
    const about = await page(ctx, "About");
    const team = await page(ctx, "Team", about.id);
    const people = await page(ctx, "People", team.id);
    await trashEntry(ctx, team.id);
    await movePage(ctx, about.id, company.id);
    expect(await restoreEntry(ctx, team.id)).toMatchObject({ entry: { path: "/company/about/team" }, below: 1 });
    expect((await rowOf(ctx, people.id))!.path).toBe("/company/about/team/people");
  });

  it("refused after 30 days in the trash (it is trash.purge's), and when the page it was under is gone for good", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const old = await post(ctx, "Old");
    await trashEntry(ctx, old.id);
    await backdate(ctx, [old.id], 31);
    expect((await refusalOf(() => restoreEntry(ctx, old.id))).message).toBe("It has been in the trash for more than 30 days and is being deleted for good.");

    // A parent deleted for good leaves `parent_id` null (ON DELETE SET NULL); its old address is no place to go back to.
    const orphan = await page(ctx, "Orphan");
    await trashEntry(ctx, orphan.id);
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.entries).set({ path: "/gone/orphan" }).where(eq(t.entries.id, orphan.id)));
    expect((await refusalOf(() => restoreEntry(ctx, orphan.id))).message).toBe("The page it was under has been deleted for good, so it cannot go back to /gone/orphan.");
  });

  it("two restores wanting one address: one wins, the other is refused naming it; in rounds", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    for (let round = 0; round < 5; round++) {
      const slug = `twin-${round}`;
      const first = await page(ctx, slug);
      await trashEntry(ctx, first.id);
      const second = await page(ctx, slug);
      await trashEntry(ctx, second.id);
      const outcomes = await Promise.allSettled([restoreEntry(ctx, first.id), restoreEntry(ctx, second.id)]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const refused = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
      expect(refused.reason).toMatchObject({ kind: "Conflict", message: expect.stringContaining(`/${slug}`) });
      expect((await rowsOf(ctx, [first.id, second.id])).filter((row) => row.deletedAt === null)).toHaveLength(1);
    }
  });

  it("a restore racing a move of the page above: whichever goes first, the restored pages sit under the parent's final address; in rounds", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    for (let round = 0; round < 5; round++) {
      const company = await page(ctx, `company-${round}`);
      const about = await page(ctx, `about-${round}`);
      const team = await page(ctx, "Team", about.id);
      await trashEntry(ctx, team.id);
      await Promise.all([restoreEntry(ctx, team.id), movePage(ctx, about.id, company.id)]);
      const [parentNow, teamNow] = [(await rowOf(ctx, about.id))!, (await rowOf(ctx, team.id))!];
      expect(teamNow.deletedAt).toBeNull();
      expect(teamNow.path).toBe(`${parentNow.path}/team`);
    }
  });

  it("a trash racing a new page under the page being trashed: the new page is refused or goes to the trash too; never a live page under a trashed one", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    for (let round = 0; round < 6; round++) {
      const about = await page(ctx, `about-${round}`);
      const team = await page(ctx, "Team", about.id);
      const [, created] = await Promise.allSettled([trashEntry(ctx, about.id), createEntry(ctx, { type: "page", title: "Late", parentId: team.id })]);
      const { rows } = await inTenant(ctx, (tx) =>
        tx.execute<{ n: number }>(sql`select count(*)::int as n from entries c join entries p on p.id = c.parent_id where c.site_id = ${ctx.site.id} and c.deleted_at is null and p.deleted_at is not null`),
      );
      expect(rows[0]!.n, `round ${round}: ${created.status}`).toBe(0);
    }
  });
});

describe("deleting for good", () => {
  it("by hand: the entry and every page below it, their drafts, revisions and term links; the activity log keeps its lines; media stays", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const bread = await term(ctx, "bread");
    const rye = await post(ctx, "Rye");
    await publish(ctx, rye.id, { termIds: [bread.id] });
    await unpublishEntry(ctx, rye.id);
    await publish(ctx, rye.id);
    await unpublishEntry(ctx, rye.id);
    await trashEntry(ctx, rye.id);
    const about = await page(ctx, "About");
    const team = await page(ctx, "Team", about.id);
    await trashEntry(ctx, about.id);

    const live = await post(ctx, "Live");
    expect((await refusalOf(() => purgeEntry(ctx, live.id))).kind).toBe("NotFound"); // not in the trash
    expect(await purgeEntry(ctx, rye.id)).toEqual({ below: 0, events: [] });
    expect(await purgeEntry(ctx, about.id)).toEqual({ below: 1, events: [] });
    expect(await rowsOf(ctx, [rye.id, about.id, team.id])).toEqual([]);
    for (const table of [t.entryDrafts, t.entryRevisions, t.entryTerms]) {
      expect(await inTenant(ctx, (tx) => tx.select().from(table).where(inArray(table.entryId, [rye.id, about.id, team.id]))), String(table)).toEqual([]);
    }
    expect((await records(ctx, "entry.deleted")).map((r) => r.metadata)).toEqual(
      expect.arrayContaining([{ type: "post", title: "Rye", path: rye.path, below: 0 }, { type: "page", title: "About", path: "/about", below: 1 }]),
    );
    // Earlier lines about it are kept (the log is append-only).
    expect((await records(ctx, "entry.published")).filter((r) => r.resourceId === rye.id)).toHaveLength(2);
    expect(await inTenant(ctx, (tx) => tx.select().from(t.terms).where(eq(t.terms.id, bread.id)))).toHaveLength(1);
  });
});

describe("trash.purge: entries, then media", () => {
  it("deletes entries in the trash for 30 days, page trees whole; keeps recent and restored ones, other sites' and other organizations'; then media, as before", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const sibling = await liveSite(a, "Sibling");
    const b = await newTenant();
    const other = await liveSite(b, "Other");

    const old = await page(ctx, "Old");
    const below = await page(ctx, "Below", old.id);
    const recent = await post(ctx, "Recent");
    const restored = await post(ctx, "Restored");
    const live = await post(ctx, "Live");
    const siblingOld = await post(sibling.ctx, "Sibling old");
    const otherOld = await post(other.ctx, "Other old");
    for (const [c, id] of [[ctx, old.id], [ctx, recent.id], [ctx, restored.id], [sibling.ctx, siblingOld.id], [other.ctx, otherOld.id]] as const) await trashEntry(c, id);
    await backdate(ctx, [old.id, below.id, restored.id], 31);
    await backdate(sibling.ctx, [siblingOld.id], 31);
    await backdate(other.ctx, [otherOld.id], 31);
    // Restored after the backdating: out of the trash, so never purged.
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.entries).set({ deletedAt: null }).where(eq(t.entries.id, restored.id)));

    // A media item trashed 31 days ago goes in the same run, as M6-3 made it.
    const bytes = await imageOf("png", 900, 600);
    const { uploads } = await requestUploads(ctx, [{ name: "old.png", size: bytes.byteLength, type: "image/png" }]);
    expect(await send(uploads[0]!.upload, bytes)).toBe(200);
    await completeUpload(ctx, uploads[0]!.mediaId);
    await trashMedia(ctx, uploads[0]!.mediaId);
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.mediaAssets).set({ deletedAt: new Date(Date.now() - 31 * DAY) }).where(eq(t.mediaAssets.id, uploads[0]!.mediaId)));

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log } as never;
    await trashPurge.run({}, { job: { id: uuidv7(), type: "trash.purge", attempt: 1, maxAttempts: 5 }, orgId: null, log, withTenant: () => Promise.reject(new Error("none")) });
    expect((await rowsOf(ctx, [old.id, below.id, recent.id, restored.id, live.id])).map((row) => row.title).sort()).toEqual(["Live", "Recent", "Restored"]);
    expect(await rowsOf(sibling.ctx, [siblingOld.id])).toEqual([]);
    expect(await rowsOf(other.ctx, [otherOld.id])).toEqual([]);
    expect(await inTenant(ctx, (tx) => tx.select().from(t.mediaAssets).where(eq(t.mediaAssets.id, uploads[0]!.mediaId)))).toEqual([]);
    // Not recorded (no one did it); the trashing was.
    expect(await records(ctx, "entry.deleted")).toEqual([]);

    // Again: nothing left to do.
    expect(await purgeTrashedEntries()).toMatchObject({ purged: 0, blocked: 0 });
  });

  it("one daily job: the registry's trash.purge is this one, enqueued daily; entries and media keep the trash equally long", () => {
    expect(jobRegistry.get("trash.purge")).toBe(trashPurge);
    expect(DAILY_JOBS).toContain(trashPurge);
    expect(DAILY_JOBS.filter((job) => job.type === "trash.purge")).toHaveLength(1);
    expect(ENTRY_TRASH_DAYS).toBe(TRASH_DAYS);
  });

  it("a page with a live page below it (a broken invariant, made by hand) is kept back and reported, never orphaned; the Home page is never deleted", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const parent = await page(ctx, "Parent");
    const child = await page(ctx, "Child", parent.id);
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.entries).set({ deletedAt: sql`now() - interval '40 days'` }).where(eq(t.entries.id, parent.id)));
    const home = await homeOf(ctx);
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.entries).set({ deletedAt: sql`now() - interval '40 days'` }).where(eq(t.entries.id, home)));
    const warn = vi.fn();
    const result = await purgeTrashedEntries({ log: { info: vi.fn(), warn, error: vi.fn(), child: () => ({}) } as never });
    expect(result.blocked).toBeGreaterThanOrEqual(2);
    expect((await rowsOf(ctx, [parent.id, child.id, home])).map((row) => row.title).sort()).toEqual(["Child", "Home", "Parent"]);
    expect(warn).toHaveBeenCalled();
  });

  it("a restore racing the purge: the page tree is either back whole or gone whole; in rounds", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    for (let round = 0; round < 6; round++) {
      const about = await page(ctx, `about-${round}`);
      const team = await page(ctx, "Team", about.id);
      await trashEntry(ctx, about.id);
      // Due for the purge as the job sees time (a day ahead), still restorable as the database sees it.
      await backdate(ctx, [about.id, team.id], 29);
      const tomorrow = new Date(Date.now() + 2 * DAY);
      const [restore, purge] = await Promise.allSettled([restoreEntry(ctx, about.id), purgeTrashedEntries({ now: tomorrow })]);
      // They take turns (the site's settings row first, as every tree change): neither dies of a deadlock; a restore
      // that comes second finds nothing to restore.
      expect(purge.status, `round ${round}: the purge`).toBe("fulfilled");
      if (restore.status === "rejected") expect(restore.reason, `round ${round}: the restore`).toMatchObject({ kind: "NotFound" });
      const rows = await rowsOf(ctx, [about.id, team.id]);
      expect([0, 2], `round ${round}`).toContain(rows.length);
      if (rows.length === 2) expect(rows.every((row) => row.deletedAt === null) || rows.every((row) => row.deletedAt !== null)).toBe(true);
    }
  });

  it("a batch that fails is rolled back whole and done by the next run", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const old = await page(ctx, "Old");
    const below = await page(ctx, "Below", old.id);
    await trashEntry(ctx, old.id);
    await backdate(ctx, [old.id, below.id], 31);
    expect((await dbError(whileFailing("entry_drafts", "delete", () => purgeTrashedEntries(), { atCommit: true }))).message).toMatch(/forced failure/);
    expect(await rowsOf(ctx, [old.id, below.id])).toHaveLength(2);
    expect(await purgeTrashedEntries()).toMatchObject({ purged: expect.any(Number) });
    expect(await rowsOf(ctx, [old.id, below.id])).toEqual([]);
  });
});

describe("lists", () => {
  it("the trash filter: only entries in the trash, of this site; the plain lists leave them out; a page's trash shows what went with it", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const sibling = await liveSite(a, "Sibling");
    const about = await page(ctx, "About");
    await page(ctx, "Team", about.id);
    await page(ctx, "Kept");
    await trashEntry(ctx, about.id);
    const siblingPage = await page(sibling.ctx, "Elsewhere");
    await trashEntry(sibling.ctx, siblingPage.id);
    const trash = await listPages(ctx, { status: "trash" });
    expect(trash.items.map((item) => [item.title, item.trash?.below])).toEqual([["About", 1]]);
    expect(trash.items[0]!.trash).toMatchObject({ canRestore: true, canPurge: true, underTrashedPage: false });
    expect((await listPages(ctx)).items.map((item) => item.title)).not.toContain("About");
    expect((await listPages(ctx)).items.map((item) => item.title)).not.toContain("Team");
  });

  it("the restore form: a refusal is said with the address, and nothing is reported as done", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    const about = await page(ctx, "About");
    await trashEntry(ctx, about.id);
    await page(ctx, "About");
    const outcome = await submitRestoreEntry(a.actor, a.org.slug, site.slug, about.id, new FormData());
    expect(outcome).toMatchObject({ refused: "Conflict", state: { status: "error", message: expect.stringContaining("/about") } });
    expect(outcome.revalidate).toBeUndefined();
  });
});

describe("trashing an image that content uses (the warning, M7-1)", () => {
  async function uploaded(ctx: SiteContext, name = "photo.png") {
    const bytes = await imageOf("png", 900, 600);
    const { uploads } = await requestUploads(ctx, [{ name, size: bytes.byteLength, type: "image/png" }]);
    expect(await send(uploads[0]!.upload, bytes)).toBe(200);
    expect((await completeUpload(ctx, uploads[0]!.mediaId)).status).toBe("ready");
    return uploads[0]!.mediaId;
  }
  const image = (mediaId: string) => ({ v: 1, doc: { type: "doc", content: [{ type: "image", attrs: { id: uuidv7(), v: 1, mediaId, alt: null, caption: null, size: "content", link: null } }] } });

  it("counts the published pages and posts that show it, the drafts that hold it, the logo and favicon: this site's only, not the trash's; titles for those who see every entry", async () => {
    const a = await newTenant();
    const { ctx, site, address } = await liveSite(a);
    const sibling = await liveSite(a, "Sibling");
    const mediaId = await uploaded(ctx);
    const gallery = await page(ctx, "Gallery");
    await publish(ctx, gallery.id, { content: image(mediaId) }); // published, and its draft holds it too
    const rye = await post(ctx, "Rye");
    await saveDraft(ctx, rye.id, 1, { featuredMediaId: mediaId }); // a draft's featured image
    const gone = await page(ctx, "Gone");
    await saveDraft(ctx, gone.id, 1, { content: image(mediaId) });
    await trashEntry(ctx, gone.id); // in the trash: not counted
    await setSiteImage(ctx, "logo", mediaId);
    // Another site's draft naming it (written behind the services' back: they would refuse it) is not this site's use.
    const elsewhere = await page(sibling.ctx, "Elsewhere");
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.entryDrafts).set({ content: image(mediaId) }).where(eq(t.entryDrafts.entryId, elsewhere.id)));

    expect(await mediaUsage(ctx, mediaId)).toEqual({
      published: 1, drafts: 2, publishedTitles: ["Gallery"], draftTitles: expect.arrayContaining(["Gallery", "Rye"]), logo: true, favicon: false,
    });
    const author = await addMember(a.org, "author");
    const authorCtx = await resolveSiteContext(author.actor, a.org.slug, site.slug);
    expect(await mediaUsage(authorCtx, mediaId)).toMatchObject({ published: 1, drafts: 2, publishedTitles: [], draftTitles: [] });
    const viewer = await addMember(a.org, "viewer");
    expect((await refusalOf(async () => mediaUsage(await resolveSiteContext(viewer.actor, a.org.slug, site.slug), mediaId))).kind).toBe("Forbidden");
    expect((await refusalOf(() => mediaUsage(sibling.ctx, mediaId))).kind).toBe("NotFound");

    // The trash itself checks again, and says what it found; the page stops showing it, and shows it again once restored.
    expect(await submitTrashMedia(a.actor, a.org.slug, site.slug, mediaId)).toMatchObject({
      state: { status: "success", message: "Moved to the trash. 1 published page or post no longer shows it. It can be restored for 30 days." },
    });
    const shown = async () => {
      const result = await at(address, "/gallery");
      return result?.kind === "entry" ? Object.keys(result.entry.images) : null;
    };
    expect(await shown()).toEqual([]);
    await restoreMedia(ctx, mediaId);
    expect(await shown()).toEqual([mediaId]);
  });

  it("an unused file: nothing to warn about", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const mediaId = await uploaded(ctx);
    expect(await mediaUsage(ctx, mediaId)).toEqual({ published: 0, drafts: 0, publishedTitles: [], draftTitles: [], logo: false, favicon: false });
    expect((await trashMedia(ctx, mediaId)).usage).toMatchObject({ published: 0 });
  });
});
