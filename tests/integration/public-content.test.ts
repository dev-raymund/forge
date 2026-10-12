import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { describe, expect, it, vi } from "vitest";
import { createEntry, publishEntry, saveDraft, setHomepage } from "@/modules/content";
import { chooseTheme, createSite, getSiteSettings, setSiteStatus, updateSiteSettings } from "@/modules/sites";
import { inTenant, resolveSiteContext, type SiteContext } from "@/modules/tenancy";
import { tags, tagsForAll, type CacheEvent } from "@/platform/cache";
import * as t from "@/platform/db/schema";
import { withTenant } from "@/platform/db/tenant";
import { newSlug, newTenant } from "../fixtures/tenants";

// The renderer's reads are `'use cache'`. Outside Next their cache calls do nothing, except that each tag a read
// applies is noted, so the tests can check that the changes which alter a read flush it.
const applied = vi.hoisted(() => ({ tags: [] as string[] }));
vi.mock("next/cache", async (original) => ({
  ...(await original<typeof import("next/cache")>()),
  cacheLife: () => {},
  cacheTag: (...names: string[]) => void applied.tags.push(...names),
}));
const { livePaths, loadEntry, loadPostList, loadPublicSite, publicPageFor, resolveRoute, resolveSite } = await import("@/modules/rendering");

/**
 * M5-6 against real Postgres, as forge_app through PgBouncer: what a live site's
 * visitors may reach. Published content only, from its published revision, of
 * this site and its language; and every change that alters a public read
 * flushes it.
 */

type Tenant = Awaited<ReturnType<typeof newTenant>>;

async function liveSite(tenant: Tenant, name = "Bakery") {
  const address = newSlug("pub");
  const { site } = await createSite(tenant.ctx, { name, address, language: "en", timezone: "UTC" });
  const ctx = await resolveSiteContext(tenant.actor, tenant.org.slug, site.slug);
  await withTenant({ orgId: tenant.org.id }, (tx) => tx.update(t.sites).set({ status: "live" }).where(eq(t.sites.id, site.id)));
  return { site, ctx, address };
}
const doc = (...texts: string[]) => ({ v: 1, doc: { type: "doc", content: texts.map((text) => ({ type: "paragraph", attrs: { id: uuidv7() }, content: [{ type: "text", text }] })) } });
const homeOf = async (ctx: SiteContext) =>
  (await inTenant(ctx, (tx) => tx.select({ id: t.siteSettings.homepageEntryId }).from(t.siteSettings).where(eq(t.siteSettings.siteId, ctx.site.id))))[0]!.id!;

/** Saves what is given into the draft, then publishes that version. */
async function publish(ctx: SiteContext, entryId: string, draft: Record<string, unknown> = {}) {
  const current = (await inTenant(ctx, (tx) => tx.select({ version: t.entryDrafts.version }).from(t.entryDrafts).where(eq(t.entryDrafts.entryId, entryId))))[0]!.version;
  const { version } = Object.keys(draft).length ? await saveDraft(ctx, entryId, current, draft) : { version: current };
  return publishEntry(ctx, entryId, version);
}
async function newEntry(ctx: SiteContext, type: "page" | "post", title: string, extra: { parentId?: string } = {}) {
  return (await createEntry(ctx, { type, title, ...extra })).entry;
}
async function term(ctx: SiteContext, taxonomy: "category" | "tag", slug: string, name = slug) {
  const [row] = await inTenant(ctx, (tx) => tx.insert(t.terms).values({ organizationId: ctx.org.id, siteId: ctx.site.id, taxonomy, name, slug }).returning());
  return row!;
}
/** The site as a visitor's request reads it (cached data, here read fresh). */
const publicSite = async (address: string) => {
  const resolved = (await resolveSite({ kind: "address", address }))!;
  return (await loadPublicSite(resolved.orgId, resolved.siteId))!;
};
const at = async (address: string, path: string) => publicPageFor(await publicSite(address), path === "/" ? [] : path.slice(1).split("/"));
const textOf = (page: Awaited<ReturnType<typeof at>>) => (page?.kind === "entry" ? JSON.stringify(page.entry.content) : null);

describe("published content at its public path", () => {
  it("the Home page: its name and tagline until published; then its published revision, never the draft after it", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const home = await homeOf(ctx);
    expect(await at(address, "/")).toEqual({ kind: "site-home" });

    await saveDraft(ctx, home, 1, { title: "Welcome", content: doc("Fresh bread daily"), template: "landing" });
    expect(await at(address, "/")).toEqual({ kind: "site-home" }); // saved, not published

    await publish(ctx, home);
    const shown = await at(address, "/");
    expect(shown).toMatchObject({ kind: "entry", entry: { type: "page", title: "Welcome", path: "/", template: "landing" } });
    expect(textOf(shown)).toContain("Fresh bread daily");

    await saveDraft(ctx, home, 2, { title: "Draft title", content: doc("A draft nobody may see") });
    const still = await at(address, "/");
    expect(textOf(still)).toContain("Fresh bread daily");
    expect(textOf(still)).not.toContain("A draft nobody may see");
    expect(still).toMatchObject({ entry: { title: "Welcome" } });

    await publish(ctx, home);
    expect(textOf(await at(address, "/"))).toContain("A draft nobody may see");
  });

  it("pages at their stored paths, nested; posts under the blog's path; drafts and other spellings are not found", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const about = await newEntry(ctx, "page", "About");
    await publish(ctx, about.id, { content: doc("About us") });
    const team = await newEntry(ctx, "page", "Team", { parentId: about.id });
    await publish(ctx, team.id, { content: doc("The team") });
    const post = await newEntry(ctx, "post", "Hello world");
    await publish(ctx, post.id, { content: doc("First post"), excerpt: "Hi" });
    const draft = await newEntry(ctx, "page", "Secret plans");
    await saveDraft(ctx, draft.id, 1, { content: doc("Not yet") });

    expect(await at(address, "/about")).toMatchObject({ kind: "entry", entry: { type: "page", path: "/about", title: "About" } });
    expect(await at(address, "/about/team")).toMatchObject({ kind: "entry", entry: { path: "/about/team" } });
    expect(await at(address, "/blog/hello-world")).toMatchObject({ kind: "entry", entry: { type: "post", path: "/blog/hello-world" } });
    for (const path of ["/secret-plans", "/About", "/team", "/about/team/extra", "/blog/hello-world/extra", "/hello-world", "/home", "/blog/page/2", "/sitemap.xml"]) {
      expect(await at(address, path), path).toBeNull();
    }
    // One segment that holds a slash (`about%2Fteam`, as Next decodes it) is not `/about/team`.
    expect(await publicPageFor(await publicSite(address), ["about/team"])).toBeNull();
  });

  it("in the trash, of another site, of another organization, in another language: none of it is reachable", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const sibling = await liveSite(a, "Sibling");
    const b = await newTenant();
    const other = await liveSite(b, "Other");
    // The same path on three sites: each finds its own.
    const mine = await newEntry(ctx, "page", "Contact");
    await publish(ctx, mine.id, { content: doc("Mine") });
    const theirs = await newEntry(sibling.ctx, "page", "Contact");
    await publish(sibling.ctx, theirs.id, { content: doc("Sibling's") });
    const foreign = await newEntry(other.ctx, "page", "Contact");
    await publish(other.ctx, foreign.id, { content: doc("Other org's") });
    expect(textOf(await at(address, "/contact"))).toContain("Mine");
    expect(textOf(await at(sibling.address, "/contact"))).toContain("Sibling's");
    expect(textOf(await at(other.address, "/contact"))).toContain("Other org's");
    // Ids of another site, or of another organization, find nothing here.
    expect(await loadEntry(a.org.id, ctx.site.id, theirs.id)).toBeNull();
    expect(await loadEntry(a.org.id, ctx.site.id, foreign.id)).toBeNull();
    expect(await loadEntry(a.org.id, sibling.site.id, foreign.id)).toBeNull();
    expect(await loadEntry(b.org.id, ctx.site.id, mine.id)).toBeNull(); // RLS, and the query names the site anyway

    // The trash (as M7-1 will put it there: unpublished first).
    const trashed = await newEntry(ctx, "page", "Old offer");
    await publish(ctx, trashed.id, { content: doc("Expired") });
    await inTenant(ctx, (tx) => tx.update(t.entries).set({ status: "draft", publishedRevisionId: null, deletedAt: new Date() }).where(eq(t.entries.id, trashed.id)));
    expect(await at(address, "/old-offer")).toBeNull();
    expect(await loadEntry(a.org.id, ctx.site.id, trashed.id)).toBeNull();

    // Another language of the same site (not used in V1): not this site's language, not shown.
    const german = await newEntry(ctx, "page", "Uber uns");
    await publish(ctx, german.id, { content: doc("Hallo") });
    await inTenant(ctx, (tx) => tx.update(t.entries).set({ locale: "de" }).where(eq(t.entries.id, german.id)));
    expect(await at(address, "/uber-uns")).toBeNull();
    expect(await livePaths(a.org.id, ctx.site.id, "en", [german.id])).toEqual({});
  });

  it("`entry:` links resolve only to this site's live entries", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const sibling = await liveSite(a, "Sibling");
    const other = await liveSite(await newTenant(), "Other");
    const live = await newEntry(ctx, "page", "Live");
    await publish(ctx, live.id, { content: doc("x") });
    const draft = await newEntry(ctx, "page", "Draft");
    const siblings = await newEntry(sibling.ctx, "page", "Theirs");
    await publish(sibling.ctx, siblings.id, { content: doc("x") });
    const foreign = await newEntry(other.ctx, "page", "Foreign");
    await publish(other.ctx, foreign.id, { content: doc("x") });
    expect(await livePaths(a.org.id, ctx.site.id, "en", [live.id, draft.id, siblings.id, foreign.id, uuidv7(), "not-an-id", "'; drop table entries; --"])).toEqual({ [live.id]: "/live" });

    // And on a page: the links it holds are mapped, the rest are not.
    const page = await newEntry(ctx, "page", "Links");
    const content = { v: 1, doc: { type: "doc", content: [{ type: "paragraph", attrs: { id: uuidv7() }, content: [{ type: "text", text: "to live", marks: [{ type: "link", attrs: { href: `entry:${live.id}` } }] }] }] } };
    await publish(ctx, page.id, { content });
    const shown = await at(address, "/links");
    expect(shown).toMatchObject({ kind: "entry", links: { [live.id]: "/live" } });
  });
});

describe("the blog index and the archives", () => {
  it("published posts only, newest first, a page at a time; a category's or tag's own posts; unknown terms and pages past the end are not found", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const bread = await term(ctx, "category", "bread", "Bread");
    const rye = await term(ctx, "tag", "rye", "Rye");
    const posts = [];
    for (const title of ["First", "Second", "Third"]) {
      const post = await newEntry(ctx, "post", title);
      await publish(ctx, post.id, { content: doc(title), excerpt: `${title} excerpt`, termIds: title === "Second" ? [rye.id] : [bread.id] });
      posts.push(post);
    }
    await newEntry(ctx, "post", "Unpublished");
    const page = await newEntry(ctx, "page", "Not a post");
    await publish(ctx, page.id, { content: doc("x") });

    const all = await loadPostList(a.org.id, ctx.site.id, "en", 1, 10, null);
    expect(all.total).toBe(3);
    expect(all.posts.map((post) => post.title)).toEqual(["Third", "Second", "First"]);
    expect(all.posts[0]).toMatchObject({ path: "/blog/third", excerpt: "Third excerpt", publishedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
    expect((await loadPostList(a.org.id, ctx.site.id, "en", 2, 2, null)).posts.map((post) => post.title)).toEqual(["First"]);
    expect((await loadPostList(a.org.id, ctx.site.id, "en", 1, 10, bread.id)).posts.map((post) => post.title)).toEqual(["Third", "First"]);

    // Through the site's reading settings: two a page.
    const settings = await getSiteSettings(ctx);
    await updateSiteSettings(ctx, "reading", { blogPath: "blog", postsPerPage: "2" }, settings.version);
    expect(await at(address, "/blog")).toMatchObject({ kind: "blog-index", page: 1, pages: 2, posts: [{ title: "Third" }, { title: "Second" }] });
    expect(await at(address, "/blog/page/2")).toMatchObject({ kind: "blog-index", page: 2, pages: 2, posts: [{ title: "First" }] });
    expect(await at(address, "/blog/page/3")).toBeNull();
    expect(await at(address, "/blog/category/bread")).toMatchObject({ kind: "term-archive", taxonomy: "category", term: { name: "Bread", slug: "bread" }, pages: 1 });
    expect(await at(address, "/blog/tag/rye")).toMatchObject({ kind: "term-archive", posts: [{ title: "Second" }] });
    for (const path of ["/blog/tag/bread", "/blog/category/rye", "/blog/category/nothing", "/blog/category/bread/page/2"]) expect(await at(address, path), path).toBeNull();

    // A post's categories and tags, from what was published.
    expect(await at(address, "/blog/second")).toMatchObject({ entry: { terms: [{ taxonomy: "tag", name: "Rye", slug: "rye" }] } });
  });

  it("a blog with no posts is an empty first page; another site's posts and terms are never listed", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const sibling = await liveSite(a, "Sibling");
    const theirs = await newEntry(sibling.ctx, "post", "Theirs");
    const theirTerm = await term(sibling.ctx, "category", "news");
    await publish(sibling.ctx, theirs.id, { content: doc("x"), termIds: [theirTerm.id] });
    expect(await at(address, "/blog")).toEqual({ kind: "blog-index", page: 1, pages: 1, posts: [] });
    expect(await at(address, "/blog/category/news")).toBeNull();
    expect(await loadPostList(a.org.id, ctx.site.id, "en", 1, 10, theirTerm.id)).toEqual({ posts: [], total: 0 });
  });

  it("when the blog's path changes, the index and archives move; posts stay at the path they were published at until published again", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const post = await newEntry(ctx, "post", "Old news");
    await publish(ctx, post.id, { content: doc("x") });
    await updateSiteSettings(ctx, "reading", { blogPath: "news", postsPerPage: "10" }, (await getSiteSettings(ctx)).version);
    expect(await at(address, "/news")).toMatchObject({ kind: "blog-index", posts: [{ path: "/blog/old-news" }] });
    expect(await at(address, "/blog")).toBeNull();
    expect(await at(address, "/blog/old-news")).toMatchObject({ kind: "entry" });
    await publish(ctx, post.id, { content: doc("y") });
    expect(await at(address, "/news/old-news")).toMatchObject({ kind: "entry", entry: { path: "/news/old-news" } });
    expect(await at(address, "/blog/old-news")).toBeNull();
  });
});

describe("every change that alters a public read flushes it", () => {
  /** The tags a read applied. */
  async function tagsOf(read: () => Promise<unknown>) {
    applied.tags = [];
    await read();
    return new Set(applied.tags);
  }
  const flushes = (events: CacheEvent[], read: Set<string>) => {
    const { immediate, stale } = tagsForAll(events);
    return { immediately: immediate.some((tag) => read.has(tag)), eventually: [...immediate, ...stale].some((tag) => read.has(tag)) };
  };

  it("each read is tagged with its site, and with what it depends on", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    const home = await homeOf(ctx);
    const id = site.id;
    expect(await tagsOf(() => resolveRoute(a.org.id, id, "en", "blog", ["about"]))).toEqual(new Set([tags.site(id), tags.routes(id)]));
    expect(await tagsOf(() => loadEntry(a.org.id, id, home))).toEqual(new Set([tags.site(id), tags.entry(id, home)]));
    expect(await tagsOf(() => loadPostList(a.org.id, id, "en", 1, 10, null))).toEqual(new Set([tags.site(id), tags.list(id, "post")]));
    expect(await tagsOf(() => livePaths(a.org.id, id, "en", [home]))).toEqual(new Set([tags.site(id), tags.routes(id)]));
    expect(await tagsOf(() => loadPublicSite(a.org.id, id))).toEqual(new Set([tags.site(id), tags.config(id)]));
  });

  it("publishing (first time and again), a path change with pages below, a new Home page, status, theme and reading settings", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    const id = site.id;
    const route = await tagsOf(() => resolveRoute(a.org.id, id, "en", "blog", ["services"]));
    const links = await tagsOf(() => livePaths(a.org.id, id, "en", []));
    const list = await tagsOf(() => loadPostList(a.org.id, id, "en", 1, 10, null));
    const config = await tagsOf(() => loadPublicSite(a.org.id, id));

    // A new page: its route and the links to it now, and its own render.
    const services = await newEntry(ctx, "page", "Services");
    const first = await publish(ctx, services.id, { content: doc("v1") });
    const entry = await tagsOf(() => loadEntry(a.org.id, id, services.id));
    for (const read of [route, links, entry]) expect(flushes(first.events, read).immediately).toBe(true);

    // Republished: its render now, without a purge.
    const again = await publish(ctx, services.id, { content: doc("v2") });
    expect(flushes(again.events, entry).immediately).toBe(true);

    // A post: the blog index and the archives (stale-while-revalidate, D-27), and its own route now.
    const post = await newEntry(ctx, "post", "News");
    const published = await publish(ctx, post.id, { content: doc("x") });
    expect(flushes(published.events, list)).toEqual({ immediately: false, eventually: true });
    expect(flushes(published.events, route).immediately).toBe(true);

    // A path change with a live page below: the page below has moved too.
    const child = await newEntry(ctx, "page", "Pricing", { parentId: services.id });
    await publish(ctx, child.id, { content: doc("x") });
    const childEntry = await tagsOf(() => loadEntry(a.org.id, id, child.id));
    const moved = await publish(ctx, services.id, { slug: "what-we-do" });
    expect(moved.moved.map((page) => page.id)).toContain(child.id);
    expect(flushes(moved.events, childEntry).immediately).toBe(true);
    expect(flushes(moved.events, route).immediately).toBe(true);

    // A new Home page: `/` resolves again.
    const changed = await setHomepage(ctx, child.id);
    expect(flushes(changed.events, route).immediately).toBe(true);

    // Status and theme: everything of the site (the umbrella tag).
    const status = await setSiteStatus(ctx, { status: "coming_soon" });
    const theme = await chooseTheme(ctx, { theme: "journal" });
    for (const read of [route, links, list, entry, config]) {
      expect(flushes(status.events, read).immediately).toBe(true);
      expect(flushes(theme.events, read).immediately).toBe(true);
    }

    // Reading settings: the site's config, which hands the blog's path and page size to every other read as part of its key.
    const reading = await updateSiteSettings(ctx, "reading", { blogPath: "journal", postsPerPage: "5" }, (await getSiteSettings(ctx)).version);
    expect(flushes(reading.events, config).immediately).toBe(true);
    expect((await loadPublicSite(a.org.id, id))!.reading).toEqual({ blogPath: "journal", postsPerPage: 5 });
  });

  it("a change to one site flushes nothing of another", async () => {
    const a = await newTenant();
    const one = await liveSite(a);
    const two = await liveSite(a, "Two");
    const page = await newEntry(one.ctx, "page", "Only here");
    const { events } = await publish(one.ctx, page.id, { content: doc("x") });
    const { immediate, stale } = tagsForAll(events);
    expect([...immediate, ...stale].every((tag) => tag.includes(one.site.id))).toBe(true);
    expect([...immediate, ...stale].some((tag) => tag.includes(two.site.id))).toBe(false);
  });
});
