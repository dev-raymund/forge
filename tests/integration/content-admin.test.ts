import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import {
  canArrangePage, canChangeAuthor, canSeeEntry, canSeePages, changeAuthor, createEntry, getEntryForEditor, listPages, listPosts, listTerms, movePage, ownPostsOnly,
  placePage, publishEntry, saveDraft, searchEntries, setHomepage, submitChangeAuthor, submitCreateEntry, submitMovePage, submitSetHomepage,
} from "@/modules/content";
import { siteNavItems } from "@/modules/sites";
import { parsePostQuery } from "@/modules/content/shared";
import { createSite } from "@/modules/sites";
import { inTenant, resolveSiteContext, type SiteContext } from "@/modules/tenancy";
import { tags, tagsForAll } from "@/platform/cache";
import * as t from "@/platform/db/schema";
import { actorOf, addMember, newSlug, newTenant, refusalOf } from "../fixtures/tenants";

/**
 * M5-7 against real Postgres: the lists the admin shows (only the context's site; an Author's own posts and no
 * pages), creating from the forms, moving pages in the tree (paths below follow, in one transaction, or nothing
 * moves), ordering siblings, changing an author, and a new Home page from the form. Every refusal writes nothing.
 */

type Tenant = Awaited<ReturnType<typeof newTenant>>;

async function newSite(tenant: Tenant, name = "Admin") {
  const { site } = await createSite(tenant.ctx, { name, address: newSlug("adm"), language: "en", timezone: "UTC" });
  return { site, ctx: await resolveSiteContext(tenant.actor, tenant.org.slug, site.slug) };
}
const as = async (member: { actor: ReturnType<typeof actorOf> }, tenant: Tenant, site: { slug: string }) => resolveSiteContext(member.actor, tenant.org.slug, site.slug);
const page = async (ctx: SiteContext, title: string, parentId: string | null = null) => (await createEntry(ctx, { type: "page", title, parentId })).entry;
const post = async (ctx: SiteContext, title: string, authorId: string | null = null) => (await createEntry(ctx, { type: "post", title, authorId })).entry;
const doc = (text: string) => ({ v: 1, doc: { type: "doc", content: [{ type: "paragraph", attrs: { id: uuidv7() }, content: [{ type: "text", text }] }] } });
async function publish(ctx: SiteContext, id: string) {
  const [{ version }] = await inTenant(ctx, (tx) => tx.select({ version: t.entryDrafts.version }).from(t.entryDrafts).where(eq(t.entryDrafts.entryId, id))) as [{ version: number }];
  return publishEntry(ctx, id, version);
}
const pathOf = async (ctx: SiteContext, id: string) =>
  (await inTenant(ctx, (tx) => tx.select({ path: t.entries.path, parentId: t.entries.parentId }).from(t.entries).where(eq(t.entries.id, id))))[0]!;
/** Every page's title and path, as the database holds them. */
const tree = async (ctx: SiteContext) =>
  (await inTenant(ctx, (tx) => tx.select({ title: t.entries.title, path: t.entries.path }).from(t.entries).where(and(eq(t.entries.siteId, ctx.site.id), eq(t.entries.type, "page")))))
    .map((row) => `${row.title} ${row.path}`)
    .sort();
const paths = async (ctx: SiteContext) => Object.fromEntries((await tree(ctx)).map((line) => line.split(" ") as [string, string]));
const auditCount = async (ctx: SiteContext, action: string) =>
  (await inTenant(ctx, (tx) => tx.select({ id: t.auditLogs.id }).from(t.auditLogs).where(and(eq(t.auditLogs.organizationId, ctx.org.id), eq(t.auditLogs.action, action))))).length;
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

describe("the pages tree", () => {
  it("this site's pages in tree order, with status, Home, and changes since publishing; filtered by status and title; nothing of another site", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const sibling = await newSite(a, "Sibling");
    const about = await page(ctx, "About us");
    const team = await page(ctx, "Team", about.id);
    await page(ctx, "100% organic");
    await page(sibling.ctx, "About the sibling");
    await saveDraft(ctx, about.id, 1, { content: doc("x") });
    await publish(ctx, about.id);
    await saveDraft(ctx, about.id, 2, { title: "About us (new)" });

    const { items, truncated } = await listPages(ctx);
    expect(truncated).toBe(false);
    expect(items.map((item) => item.title).sort()).toEqual(["100% organic", "About us (new)", "Home", "Team"]);
    expect(items.find((item) => item.id === about.id)).toMatchObject({ status: "published", changed: true, parentId: null, path: "/about-us" });
    expect(items.find((item) => item.id === team.id)).toMatchObject({ status: "draft", changed: false, parentId: about.id, path: "/about-us/team" });
    expect(items.find((item) => item.isHome)).toMatchObject({ title: "Home", path: "/" });

    expect((await listPages(ctx, { status: "published" })).items.map((item) => item.id)).toEqual([about.id]);
    expect((await listPages(ctx, { q: "%" })).items.map((item) => item.title)).toEqual(["100% organic"]);
    expect((await listPages(ctx, { q: "ABOUT" })).items.map((item) => item.title)).toEqual(["About us (new)"]); // by the drafted title too
  });

  it("an Author is refused the pages (hidden from them); a Viewer reads them", async () => {
    const a = await newTenant();
    const { site } = await newSite(a);
    const author = await addMember(a.org, "author");
    const viewer = await addMember(a.org, "viewer");
    expect((await refusalOf(async () => listPages(await as(author, a, site)))).kind).toBe("Forbidden");
    expect((await listPages(await as(viewer, a, site))).items.length).toBeGreaterThan(0);
  });
});

describe("the posts list", () => {
  it("filters by status, category (as drafted), author and title; sorts; pages through; never another site's", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    const sibling = await newSite(a, "Sibling");
    const editor = await addMember(a.org, "editor");
    const bread = (await inTenant(ctx, (tx) => tx.insert(t.terms).values({ organizationId: a.org.id, siteId: site.id, taxonomy: "category", name: "Bread", slug: "bread" }).returning()))[0]!;
    const first = await post(ctx, "Banana bread");
    const second = await post(ctx, "Apple pie", editor.user.id);
    await saveDraft(ctx, first.id, 1, { termIds: [bread.id], content: doc("x") });
    await publish(ctx, first.id);
    await post(sibling.ctx, "Sibling's post");

    const all = await listPosts(ctx, parsePostQuery({}));
    expect(all).toMatchObject({ total: 2, page: 1, pages: 1, onlyOwn: false });
    expect(all.items.find((item) => item.id === first.id)).toMatchObject({ status: "published", categories: ["Bread"], authorName: "Tenant Owner" });
    expect(all.items.find((item) => item.id === second.id)).toMatchObject({ status: "draft", categories: [], authorId: editor.user.id });
    expect((await listPosts(ctx, parsePostQuery({ status: "draft" }))).items.map((item) => item.id)).toEqual([second.id]);
    expect((await listPosts(ctx, parsePostQuery({ category: bread.id }))).items.map((item) => item.id)).toEqual([first.id]);
    expect((await listPosts(ctx, parsePostQuery({ author: editor.user.id }))).items.map((item) => item.id)).toEqual([second.id]);
    expect((await listPosts(ctx, parsePostQuery({ q: "pie" }))).items.map((item) => item.id)).toEqual([second.id]);
    expect((await listPosts(ctx, parsePostQuery({ sort: "title" }))).items.map((item) => item.title)).toEqual(["Apple pie", "Banana bread"]);
    expect((await listPosts(ctx, parsePostQuery({ sort: "oldest" }))).items.map((item) => item.id)).toEqual([first.id, second.id]);
    expect((await listPosts(ctx, parsePostQuery({ sort: "published" }))).items[0]!.id).toBe(first.id);
    // A category of another site, or nothing at all, matches nothing.
    expect((await listPosts(ctx, parsePostQuery({ category: uuidv7() }))).total).toBe(0);
    for (let i = 0; i < 26; i++) await post(ctx, `Many ${i}`);
    const paged = await listPosts(ctx, parsePostQuery({ page: "2" }));
    expect(paged).toMatchObject({ total: 28, page: 2, pages: 2 });
    expect(paged.items).toHaveLength(3);
    expect((await listPosts(ctx, parsePostQuery({ page: "99" }))).page).toBe(2); // past the end: the last page
    expect((await listTerms(ctx)).map((term) => term.name)).toEqual(["Bread"]);
  });

  it("an Author sees only their own posts, whatever the URL asks; a Viewer sees them all", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    const author = await addMember(a.org, "author");
    const viewer = await addMember(a.org, "viewer");
    const authorCtx = await as(author, a, site);
    const mine = await post(authorCtx, "Mine");
    const theirs = await post(ctx, "Theirs");
    const forAuthor = await listPosts(authorCtx, parsePostQuery({ author: a.user.id }));
    expect(forAuthor).toMatchObject({ onlyOwn: true, total: 1 });
    expect(forAuthor.items.map((item) => item.id)).toEqual([mine.id]);
    expect((await listPosts(await as(viewer, a, site), parsePostQuery({}))).total).toBe(2);

    // The editor and the link picker follow: another's post is not found; only public entries and their own are found.
    expect((await getEntryForEditor(authorCtx, mine.id, "post")).id).toBe(mine.id);
    expect((await refusalOf(() => getEntryForEditor(authorCtx, theirs.id, "post"))).kind).toBe("NotFound");
    const home = (await listPages(ctx)).items.find((item) => item.isHome)!;
    expect((await refusalOf(() => getEntryForEditor(authorCtx, home.id, "page"))).kind).toBe("NotFound");
    expect((await searchEntries(authorCtx, "")).map((match) => match.id)).toEqual([mine.id]);
    await saveDraft(ctx, theirs.id, 1, { content: doc("x") });
    await publish(ctx, theirs.id);
    expect((await searchEntries(authorCtx, "")).map((match) => match.id).sort()).toEqual([mine.id, theirs.id].sort());
  });
});

describe("creating from the forms", () => {
  it("opens the editor; a generated slug takes the next free one; a new Home page from the form moves the old one", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    const first = await submitCreateEntry(a.actor, a.org.slug, site.slug, "page", form({ title: "Services" }));
    expect(first).toMatchObject({ state: { status: "success" }, redirectTo: expect.stringMatching(new RegExp(`^/${a.org.slug}/sites/${site.slug}/pages/[0-9a-f-]{36}$`)) });
    const second = await submitCreateEntry(a.actor, a.org.slug, site.slug, "page", form({ title: "Services", template: "landing" }));
    expect(second.state.values).toMatchObject({ path: "/services-2" });

    const made = await submitCreateEntry(a.actor, a.org.slug, site.slug, "page", form({ title: "Welcome", home: "on" }));
    expect(made).toMatchObject({ state: { status: "success", values: { path: "/" } } });
    expect(await paths(ctx)).toMatchObject({ Welcome: "/", Home: "/home" });
  });

  it("refused before anything is written: an Editor asking for a new Home page, an Author making a page, a parent or an author from elsewhere", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    const other = await newSite(a, "Other");
    const otherPage = await page(other.ctx, "Elsewhere");
    const editor = await addMember(a.org, "editor");
    const author = await addMember(a.org, "author");
    const stranger = await newTenant();
    const before = (await listPages(ctx)).items.length;
    expect(await submitCreateEntry(editor.actor, a.org.slug, site.slug, "page", form({ title: "Take over", home: "on" }))).toMatchObject({ refused: "Forbidden" });
    expect(await submitCreateEntry(author.actor, a.org.slug, site.slug, "page", form({ title: "Not mine to make" }))).toMatchObject({ refused: "Forbidden" });
    expect(await submitCreateEntry(a.actor, a.org.slug, site.slug, "page", form({ title: "Lost", parentId: otherPage.id }))).toMatchObject({ refused: "Validation" });
    expect(await submitCreateEntry(a.actor, a.org.slug, site.slug, "post", form({ title: "Credited", authorId: stranger.user.id }))).toMatchObject({ refused: "Validation" });
    expect(await submitCreateEntry(author.actor, a.org.slug, site.slug, "post", form({ title: "As someone else", authorId: a.user.id }))).toMatchObject({ refused: "Forbidden" });
    expect((await listPages(ctx)).items.length).toBe(before);
    expect((await listPosts(ctx, parsePostQuery({}))).total).toBe(0);
  });
});

describe("moving a page", () => {
  it("under another page: its path and every path below follow, in one transaction; live pages are flushed; recorded", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const services = await page(ctx, "Services");
    const team = await page(ctx, "Team");
    const lead = await page(ctx, "Lead", team.id);
    const deep = await page(ctx, "Deep", lead.id);
    for (const id of [team.id, lead.id]) {
      await saveDraft(ctx, id, 1, { content: doc("x") });
      await publish(ctx, id);
    }
    const leadEntry = tags.entry(ctx.site.id, lead.id);

    const result = await movePage(ctx, team.id, services.id);
    expect(result).toMatchObject({ changed: true, entry: { path: "/services/team", parentId: services.id } });
    expect(result.moved.map((page) => [page.title, page.from, page.to])).toEqual([
      ["Team", "/team", "/services/team"], ["Lead", "/team/lead", "/services/team/lead"], ["Deep", "/team/lead/deep", "/services/team/lead/deep"],
    ]);
    expect(await paths(ctx)).toMatchObject({ Team: "/services/team", Lead: "/services/team/lead", Deep: "/services/team/lead/deep" });
    // The live ones are flushed (their routes and own renders); the draft one is not public.
    const { immediate } = tagsForAll(result.events);
    expect(immediate).toEqual(expect.arrayContaining([tags.entry(ctx.site.id, team.id), leadEntry, tags.routes(ctx.site.id)]));
    expect(immediate).not.toContain(tags.entry(ctx.site.id, deep.id));
    expect(await auditCount(ctx, "entry.moved")).toBe(1);

    // Back to the top level; the same parent twice changes nothing.
    expect((await movePage(ctx, team.id, null)).entry.path).toBe("/team");
    expect((await movePage(ctx, team.id, null)).changed).toBe(false);
    expect(await auditCount(ctx, "entry.moved")).toBe(2);
  });

  it("refused, and nothing moves: a loop, itself, a post, a page in the trash, another site's page, a post moved, a reserved address, a taken address", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const other = await newSite(a, "Other");
    const about = await page(ctx, "About");
    const team = await page(ctx, "Team", about.id);
    const blogPage = await page(ctx, "Blog", about.id); // "/about/blog" is fine below a page; at the top level it is the blog's
    const someone = await page(ctx, "Someone");
    await page(ctx, "Team", someone.id); // "/someone/team": "Team" under Someone would collide
    const trashed = await page(ctx, "Old");
    await inTenant(ctx, (tx) => tx.update(t.entries).set({ deletedAt: new Date() }).where(eq(t.entries.id, trashed.id)));
    const elsewhere = await page(other.ctx, "Elsewhere");
    const aPost = await post(ctx, "A post");
    const before = await tree(ctx);

    const refused = async (id: string, parentId: string | null) => refusalOf(() => movePage(ctx, id, parentId));
    expect(await refused(about.id, team.id)).toMatchObject({ kind: "Validation", fieldErrors: { parentId: ["That page is below this one. Choose a page that is not inside it."] } });
    expect(await refused(about.id, about.id)).toMatchObject({ kind: "Validation", fieldErrors: { parentId: ["A page cannot be its own parent."] } });
    expect(await refused(team.id, aPost.id)).toMatchObject({ kind: "Validation", fieldErrors: { parentId: ["Choose a page of this site."] } });
    expect(await refused(team.id, trashed.id)).toMatchObject({ kind: "Validation" });
    expect(await refused(team.id, elsewhere.id)).toMatchObject({ kind: "Validation" });
    expect(await refused(team.id, uuidv7())).toMatchObject({ kind: "Validation" });
    expect(await refused(aPost.id, about.id)).toMatchObject({ kind: "Validation", fieldErrors: { parentId: ["Only pages have a parent page."] } });
    expect(await refused(blogPage.id, null)).toMatchObject({ kind: "Validation", fieldErrors: { parentId: ["That address belongs to the blog (/blog)."] } });
    expect(await refused(team.id, someone.id)).toMatchObject({ kind: "Conflict", message: expect.stringContaining("/someone/team") });
    expect(await tree(ctx)).toEqual(before);
    expect(await auditCount(ctx, "entry.moved")).toBe(0);
  });

  it("a taken address refuses the whole move: the page stays, and so do the pages below it", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const archive = await page(ctx, "Archive");
    await page(ctx, "Old", archive.id); // /archive/old
    const old = await page(ctx, "Old"); // /old
    const news = await page(ctx, "News", old.id); // /old/news
    const target = await page(ctx, "Target");
    await page(ctx, "Old", target.id); // /target/old
    const before = await tree(ctx);
    // Moving /old under Archive: /archive/old is taken.
    expect((await refusalOf(() => movePage(ctx, old.id, archive.id))).kind).toBe("Conflict");
    expect((await refusalOf(() => movePage(ctx, old.id, target.id))).message).toContain("/target/old");
    expect(await tree(ctx)).toEqual(before);
    expect((await pathOf(ctx, news.id)).path).toBe("/old/news");
  });

  it("two moves at the same moment that would make a loop: one wins, the other is refused, and there is no loop", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const left = await page(ctx, "Left");
    const right = await page(ctx, "Right");
    const results = await Promise.allSettled([movePage(ctx, left.id, right.id), movePage(ctx, right.id, left.id)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [l, r] = [await pathOf(ctx, left.id), await pathOf(ctx, right.id)];
    expect(l.parentId === right.id && r.parentId === left.id).toBe(false);
  });

  it("the Home page keeps `/` under any parent; a new Home page still works after moves", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const home = (await listPages(ctx)).items.find((item) => item.isHome)!;
    const about = await page(ctx, "About");
    expect((await movePage(ctx, home.id, about.id)).entry.path).toBe("/");
    const welcome = await page(ctx, "Welcome", about.id);
    await setHomepage(ctx, welcome.id);
    expect(await paths(ctx)).toMatchObject({ Welcome: "/", Home: "/about/home", About: "/about" });
  });

  it("only those who edit pages: an Author and a Viewer are refused, a direct request too", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    const about = await page(ctx, "About");
    const team = await page(ctx, "Team");
    for (const role of ["author", "viewer"] as const) {
      const member = await as(await addMember(a.org, role), a, site);
      expect((await refusalOf(() => movePage(member, team.id, about.id))).kind, role).toBe("Forbidden");
      expect((await refusalOf(() => placePage(member, team.id, null))).kind, role).toBe("Forbidden");
    }
    const editor = await as(await addMember(a.org, "editor"), a, site);
    expect((await movePage(editor, team.id, about.id)).changed).toBe(true);
  });
});

describe("ordering siblings", () => {
  it("puts a page before another at its level, or last; recorded; another level's page or a post is refused", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const [one, two, three] = [await page(ctx, "A one"), await page(ctx, "B two"), await page(ctx, "C three")];
    const child = await page(ctx, "Child", one.id);
    const topLevel = async () => (await listPages(ctx)).items.filter((item) => item.parentId === null && !item.isHome).map((item) => item.title);
    expect(await topLevel()).toEqual(["A one", "B two", "C three"]);
    expect(await placePage(ctx, three.id, one.id)).toMatchObject({ changed: true, position: 1 });
    expect(await topLevel()).toEqual(["C three", "A one", "B two"]);
    expect(await placePage(ctx, three.id, null)).toMatchObject({ changed: true, position: 4 }); // after Home too: last
    expect(await topLevel()).toEqual(["A one", "B two", "C three"]);
    expect((await placePage(ctx, three.id, null)).changed).toBe(false);
    expect((await refusalOf(() => placePage(ctx, two.id, child.id))).kind).toBe("Validation");
    expect((await refusalOf(() => placePage(ctx, two.id, two.id))).kind).toBe("Validation");
    expect(await auditCount(ctx, "entry.reordered")).toBe(2);
  });
});

describe("changing the author", () => {
  it("Owner–Editor credit a member; recorded with both names", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    const writer = await addMember(a.org, "author");
    const editor = await as(await addMember(a.org, "editor"), a, site);
    const story = await post(ctx, "Story");
    expect(await changeAuthor(editor, story.id, writer.user.id)).toMatchObject({ changed: true, entry: { authorId: writer.user.id } });
    expect((await changeAuthor(editor, story.id, writer.user.id)).changed).toBe(false);
    const [row] = await inTenant(ctx, (tx) => tx.select({ metadata: t.auditLogs.metadata }).from(t.auditLogs).where(and(eq(t.auditLogs.organizationId, a.org.id), eq(t.auditLogs.action, "entry.author_changed"))));
    expect(row!.metadata).toMatchObject({ type: "post", title: "Story", authorName: "A author", previousAuthorName: "Tenant Owner" });
    // The Author now sees it as theirs.
    expect((await getEntryForEditor(await as(writer, a, site), story.id, "post")).canEdit).toBe(true);
  });

  it("refused, nothing changed: an Author (even of their own post), a Viewer, someone outside the organization, not an id", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    const writer = await addMember(a.org, "author");
    const writerCtx = await as(writer, a, site);
    const own = await post(writerCtx, "Own");
    const viewer = await as(await addMember(a.org, "viewer"), a, site);
    const stranger = await newTenant();
    expect((await refusalOf(() => changeAuthor(writerCtx, own.id, a.user.id))).kind).toBe("Forbidden");
    expect((await refusalOf(() => changeAuthor(viewer, own.id, a.user.id))).kind).toBe("Forbidden");
    expect((await refusalOf(() => changeAuthor(ctx, own.id, stranger.user.id))).kind).toBe("Validation");
    expect((await refusalOf(() => changeAuthor(ctx, own.id, "not-an-id"))).kind).toBe("Validation");
    expect((await refusalOf(() => changeAuthor(ctx, uuidv7(), a.user.id))).kind).toBe("NotFound");
    expect((await getEntryForEditor(ctx, own.id, "post")).settings.authorId).toBe(writer.user.id);
    expect(await auditCount(ctx, "entry.author_changed")).toBe(0);
  });
});

describe("who sees and does what (M5-7), by role", () => {
  it("pages hidden from Authors, their own posts only; arranging pages Owner–Editor; crediting others Owner–Editor", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    const paths = { overview: "/o", appearance: "/a", settings: "/s" };
    const rows: Record<string, unknown> = {};
    for (const role of ["owner", "admin", "editor", "author", "viewer"] as const) {
      const member = role === "owner" ? ctx : await as(await addMember(a.org, role), a, site);
      const someonesPost = { type: "post" as const, organizationId: a.org.id, authorId: uuidv7() };
      const ownPost = { ...someonesPost, authorId: member.actor.userId };
      const aPage = { type: "page" as const, organizationId: a.org.id, authorId: null };
      rows[role] = [
        canSeePages(member), ownPostsOnly(member), canSeeEntry(member, someonesPost), canSeeEntry(member, ownPost),
        canArrangePage(member, aPage), canChangeAuthor(member, someonesPost), canChangeAuthor(member, ownPost),
        siteNavItems({ ...paths, pages: canSeePages(member) ? "/pages" : null, posts: "/posts" }, member).map((item) => item.label).join(" "),
      ];
    }
    expect(rows).toEqual({
      owner: [true, false, true, true, true, true, true, "Overview Pages Posts Appearance Settings"],
      admin: [true, false, true, true, true, true, true, "Overview Pages Posts Appearance Settings"],
      editor: [true, false, true, true, true, true, true, "Overview Pages Posts"],
      author: [false, true, false, true, false, false, false, "Overview Posts"],
      viewer: [true, false, true, true, false, false, false, "Overview Pages Posts"],
    });
  });

  it("the sidebar's actions answer without re-rendering the editor's page (it keeps its draft); the tree refreshes itself", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    const about = await page(ctx, "About");
    const team = await page(ctx, "Team");
    const writer = await addMember(a.org, "author");
    const story = await post(ctx, "Story");
    const data = (fields: Record<string, string>) => form(fields);
    expect(await submitMovePage(a.actor, a.org.slug, site.slug, team.id, data({ parentId: about.id }))).toMatchObject({
      state: { status: "success", values: { path: "/about/team", parentId: about.id } }, refresh: false,
    });
    expect(await submitChangeAuthor(a.actor, a.org.slug, site.slug, story.id, data({ authorId: writer.user.id }))).toMatchObject({ state: { status: "success" }, refresh: false });
    expect(await submitSetHomepage(a.actor, a.org.slug, site.slug, about.id, data({}))).toMatchObject({ state: { status: "success" }, refresh: false });
    expect(await submitMovePage(a.actor, a.org.slug, site.slug, team.id, data({ parentId: "not-an-id" }))).toMatchObject({ refused: "Validation" });
    // The editor's data carries what the sidebar shows.
    expect((await getEntryForEditor(ctx, story.id, "post")).settings).toMatchObject({ authorId: writer.user.id, authorName: "A author", canChangeAuthor: true, canArrange: false });
    expect((await getEntryForEditor(ctx, team.id, "page")).settings).toMatchObject({ parentId: about.id, canArrange: true, canSetHomepage: true, blogPath: "blog" });
  });
});
