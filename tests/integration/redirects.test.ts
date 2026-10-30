import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { describe, expect, it, vi } from "vitest";
import {
  createEntry, createTerm, deleteTerm, movePage, publishEntry, restoreEntry, saveDraft, setHomepage, submitPublishEntry, submitUnpublishEntry, trashEntry, unpublishEntry,
  updateTerm,
} from "@/modules/content";
import { saveMenu } from "@/modules/navigation";
import { createRedirect, deleteRedirect, getRedirects, setNotFoundPage, submitCreateRedirect, updateRedirect, type RedirectChanges } from "@/modules/seo";
import { createSite, getSiteSettings, updateSiteSettings } from "@/modules/sites";
import { inTenant, resolveSiteContext, type SiteContext } from "@/modules/tenancy";
import { tags, tagsForAll, type CacheEvent } from "@/platform/cache";
import * as t from "@/platform/db/schema";
import { withTenant } from "@/platform/db/tenant";
import { whileFailing } from "../fixtures/db-failure";
import { addMember, newSlug, newTenant, refusalOf } from "../fixtures/tenants";

// The public reads are `'use cache'`: here their cache calls do nothing but note each tag a read applies, so the
// tests can check that every change to a redirect flushes a tag the redirect map was read under.
const applied = vi.hoisted(() => ({ tags: [] as string[] }));
vi.mock("next/cache", async (original) => ({
  ...(await original<typeof import("next/cache")>()),
  cacheLife: () => {},
  cacheTag: (...names: string[]) => void applied.tags.push(...names),
  revalidateTag: () => {},
  updateTag: () => {},
}));
const { loadPublicSite, loadRedirects, loadSitemapRows, notFoundPageFor, publicMenusFor, publicPageFor, publicPageSeo, publicRedirectFor, resolveSite, sitemapUrlsOf } =
  await import("@/modules/rendering");

/**
 * M8-5 against real Postgres through PgBouncer: redirects by hand (who may, what is refused, flattened, recorded,
 * flushed), the 301s Forge leaves when a live address changes (a new slug, a moved page and those below it, the Home
 * page, the blog's path, a renamed category), content taking an address back, unpublish's "redirect this address
 * to…", the public site's answer for every case, the not-found page, rollbacks, a race, and isolation.
 */

type Tenant = Awaited<ReturnType<typeof newTenant>>;
const ORIGIN = "http://localhost:3000";

async function liveSite(tenant: Tenant, name = "Harbour") {
  const address = newSlug("redir");
  const { site } = await createSite(tenant.ctx, { name, address, language: "en", timezone: "UTC" });
  await withTenant({ orgId: tenant.org.id }, (tx) => tx.update(t.sites).set({ status: "live" }).where(eq(t.sites.id, site.id)));
  return { site, address, base: `/s/${address}`, ctx: await resolveSiteContext(tenant.actor, tenant.org.slug, site.slug) };
}
const draftVersion = async (ctx: SiteContext, entryId: string) =>
  (await inTenant(ctx, (tx) => tx.select({ version: t.entryDrafts.version }).from(t.entryDrafts).where(eq(t.entryDrafts.entryId, entryId))))[0]!.version;
const save = async (ctx: SiteContext, entryId: string, draft: Record<string, unknown>) => saveDraft(ctx, entryId, await draftVersion(ctx, entryId), draft);
async function publish(ctx: SiteContext, entryId: string, draft: Record<string, unknown> = {}) {
  if (Object.keys(draft).length) await save(ctx, entryId, draft);
  return publishEntry(ctx, entryId, await draftVersion(ctx, entryId));
}
async function published(ctx: SiteContext, type: "page" | "post", title: string, { parentId, ...draft }: Record<string, unknown> = {}) {
  const { entry } = await createEntry(ctx, { type, title, ...(parentId ? { parentId: parentId as string } : {}) });
  const result = await publish(ctx, entry.id, draft);
  return { ...entry, path: result.entry.path };
}
const segments = (path: string) => (path === "/" ? [] : path.slice(1).split("/"));
/** What a visitor of `path` gets: a redirect (its status and Location), the page, or not found. */
async function visit(address: string, path: string) {
  const locator = { kind: "address" as const, address };
  const resolved = (await resolveSite(locator))!;
  const site = (await loadPublicSite(resolved.orgId, resolved.siteId))!;
  const hop = await publicRedirectFor(site, locator, segments(path));
  if (hop) return { redirect: hop.location, status: hop.status };
  const page = await publicPageFor(site, segments(path));
  return page ? { page: page.kind === "entry" ? page.entry.path : page.kind } : { notFound: true };
}
const rows = (ctx: SiteContext) =>
  inTenant(ctx, (tx) =>
    tx
      .select({ source: t.redirects.sourcePath, destination: t.redirects.destination, status: t.redirects.statusCode, origin: t.redirects.origin, active: t.redirects.isActive })
      .from(t.redirects)
      .where(and(eq(t.redirects.organizationId, ctx.org.id), eq(t.redirects.siteId, ctx.site.id)))
      .orderBy(t.redirects.sourcePath),
  );
const records = (ctx: SiteContext, action: string) =>
  inTenant(ctx, (tx) => tx.select().from(t.auditLogs).where(and(eq(t.auditLogs.organizationId, ctx.org.id), eq(t.auditLogs.action, action))));
const add = (ctx: SiteContext, source: string, destination: string, statusCode = 301) => createRedirect(ctx, { source, destination, statusCode });
/** Every tag the redirect map was just read under, one of which these events flush at once. */
async function mapReads(ctx: SiteContext) {
  applied.tags.length = 0;
  await loadRedirects(ctx.org.id, ctx.site.id);
  return [...applied.tags];
}
const flushes = (events: CacheEvent[], reads: readonly string[]) => reads.some((tag) => tagsForAll(events).immediate.includes(tag));
const none: RedirectChanges = { made: [], turnedOff: [], repointed: 0 };

describe("redirects by hand", () => {
  it("added by an Owner, Admin or Editor: the old address sends visitors to the new one (308 or 307), recorded, the map flushed", async () => {
    const a = await newTenant();
    const { ctx, address, base, site } = await liveSite(a);
    const contact = await published(ctx, "page", "Contact");
    const reads = await mapReads(ctx);
    expect(reads.sort()).toEqual([tags.site(ctx.site.id), tags.config(ctx.site.id)].sort());

    const made = await add(ctx, "  /Old-Contact.html/ ", "/contact/");
    expect(made.redirect).toMatchObject({ source: "/Old-Contact.html", destination: "/contact", statusCode: 301, origin: "manual", isActive: true, external: false });
    expect(flushes(made.events, reads)).toBe(true);
    expect(await records(ctx, "redirect.created")).toEqual([
      expect.objectContaining({ resourceType: "redirect", resourceId: made.redirect.id, metadata: { name: "Harbour", source: "/Old-Contact.html", destination: "/contact", statusCode: 301 } }),
    ]);
    expect(await visit(address, "/Old-Contact.html")).toEqual({ redirect: `${base}${contact.path}`, status: 308 });
    // Exact: another spelling is another address.
    expect(await visit(address, "/old-contact.html")).toEqual({ notFound: true });

    await add(ctx, "/sale", "/", 302);
    await add(ctx, "/shop", "https://shop.example.com/rye?ref=site", 307);
    await add(ctx, "/caf%C3%A9", "/contact", 308);
    expect(await visit(address, "/sale")).toEqual({ redirect: base, status: 307 });
    expect(await visit(address, "/shop")).toEqual({ redirect: "https://shop.example.com/rye?ref=site", status: 307 });
    expect(await visit(address, "/café")).toEqual({ redirect: `${base}/contact`, status: 308 });

    for (const role of ["admin", "editor"] as const) {
      const member = await resolveSiteContext((await addMember(a.org, role)).actor, a.org.slug, site.slug);
      expect((await add(member, `/by-${role}`, "/contact")).changed, role).toBe(true);
    }
    for (const role of ["author", "viewer"] as const) {
      const member = await resolveSiteContext((await addMember(a.org, role)).actor, a.org.slug, site.slug);
      expect((await refusalOf(() => add(member, `/by-${role}`, "/contact"))).kind, role).toBe("Forbidden");
      expect((await refusalOf(() => getRedirects(member))).kind, role).toBe("Forbidden");
      expect((await refusalOf(() => updateRedirect(member, made.redirect.id, { isActive: false }))).kind, role).toBe("Forbidden");
    }
    expect((await getRedirects(ctx)).total).toBe(6);
  });

  it("refused at the field: an address the site serves, Forge's own, one already redirected; a destination it does not serve, a list page, elsewhere unsafely, itself, a loop", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const sibling = await liveSite(a, "Sibling");
    const about = await published(ctx, "page", "About us");
    const post = await published(ctx, "post", "Rye season");
    await createTerm(ctx, { taxonomy: "category", name: "Bread" });
    const { entry: draft } = await createEntry(ctx, { type: "page", title: "Not yet" });
    await published(sibling.ctx, "page", "Elsewhere");
    await add(ctx, "/taken", "/about-us");

    const sources: [string, string][] = [
      ["/", "home page cannot be redirected"],
      [about.path, "A published page or post is at /about-us"],
      [post.path, "A published page or post is at /blog/rye-season"],
      ["/blog", "the blog's address"],
      ["/blog/category/bread", "archive"],
      ["/blog/page/2", "list pages"],
      ["/blog/category/bread/page/2", "list pages"],
      ["/_forge/preview/x", "used by Forge"],
      ["/sitemap.xml", "used by Forge"],
      ["/taken", "already a redirect from /taken"],
      ["/a?b=1", "without ?"],
      ["/a%2Fb", "not %2F"],
    ];
    for (const [source, reason] of sources) {
      const refusal = await refusalOf(() => add(ctx, source, "/about-us"));
      expect(refusal.kind, source).toBe("Validation");
      expect(refusal.fieldErrors?.source?.[0], source).toContain(reason);
    }
    const destinations: [string, string][] = [
      [draft.path, "Nothing is published at /not-yet"],
      ["/elsewhere", "Nothing is published at /elsewhere"],
      ["/blog/page/2", "the list itself"],
      ["/nowhere", "Nothing is published"],
      ["javascript:alert(1)", "full address starting with https://"],
      ["data:text/html,hi", "full address starting with https://"],
      ["//evil.example", "full address starting with https://"],
      [`${ORIGIN}/s/${sibling.address}/elsewhere`, "on Forge itself"],
      ["https://user:pw@evil.example/", "user name or password"],
      ["/old-place", "own address"],
    ];
    for (const [destination, reason] of destinations) {
      const refusal = await refusalOf(() => add(ctx, "/old-place", destination));
      expect(refusal.kind, destination).toBe("Validation");
      expect(refusal.fieldErrors?.destination?.[0], destination).toContain(reason);
    }
    // A loop: /x → /taken → /about-us is fine; /about-us cannot be a source; but /y → /x while /x → /y would loop.
    await add(ctx, "/x", "/taken");
    expect((await rows(ctx)).find((row) => row.source === "/x")).toMatchObject({ destination: "/about-us" }); // flattened
    expect((await refusalOf(() => createRedirect(ctx, { source: "/x", destination: "/x", statusCode: 301 }))).fieldErrors?.source?.[0]).toContain("already a redirect");
    expect((await refusalOf(() => add(ctx, "/z", "/about-us", 303))).fieldErrors).toEqual({ statusCode: ["Choose 301, 302, 307 or 308."] });
    expect((await refusalOf(() => createRedirect(ctx, { source: "/z", destination: "/about-us", statusCode: 301, siteId: sibling.site.id }))).kind).toBe("Validation");
    expect((await rows(ctx)).map((row) => row.source)).toEqual(["/taken", "/x"]);
  });

  it("chains are flattened when written, both ways: at most one hop for visitors; a loop or a chain past ten is refused", async () => {
    const a = await newTenant();
    const { ctx, address, base } = await liveSite(a);
    const [mid, end] = [await published(ctx, "page", "Mid"), await published(ctx, "page", "End")];
    // A→B with B→C: stored A→C.
    await add(ctx, "/b", end.path);
    const flattened = await add(ctx, "/a", "/b");
    expect(flattened.redirect.destination).toBe(end.path);
    expect(flattened.notes).toEqual([`It goes straight to ${end.path}: /b redirects there.`]);
    // B→C while A→B exists: A points at C. The page at /mid goes away; /old → /mid keeps pointing there, until /mid redirects on.
    await add(ctx, "/old", mid.path);
    await unpublishEntry(ctx, mid.id);
    expect(await visit(address, "/old")).toEqual({ notFound: true }); // never to a page that is not published
    expect((await getRedirects(ctx)).redirects.find((one) => one.source === "/old")).toMatchObject({ destinationLive: false });
    const onward = await add(ctx, mid.path, end.path);
    expect(onward.notes).toEqual([`1 redirect that went there now goes straight to ${end.path}.`]);
    expect((await rows(ctx)).map((row) => [row.source, row.destination])).toEqual([["/a", end.path], ["/b", end.path], [mid.path, end.path], ["/old", end.path]]);
    expect(await visit(address, "/old")).toEqual({ redirect: `${base}${end.path}`, status: 308 });
    // A loop, through the map: /end cannot be a source (it is published); turn it into one by unpublishing, then /end → /a.
    await unpublishEntry(ctx, end.id);
    const loop = await refusalOf(() => add(ctx, end.path, "/a"));
    expect(loop.fieldErrors?.destination?.[0]).toContain("loop");

    // Past ten steps (written behind the services' back: they never leave a chain): refused.
    const b = await newTenant();
    const long = await liveSite(b);
    const target = await published(long.ctx, "page", "Target");
    await withTenant({ orgId: b.org.id }, (tx) =>
      tx.insert(t.redirects).values(
        Array.from({ length: 11 }, (_, i) => ({ organizationId: b.org.id, siteId: long.ctx.site.id, sourcePath: `/p${i}`, destination: i === 10 ? target.path : `/p${i + 1}` })),
      ),
    );
    expect((await refusalOf(() => add(long.ctx, "/start", "/p0"))).fieldErrors?.destination?.[0]).toContain("more than 10 times");
    expect((await add(long.ctx, "/start", "/p1")).redirect.destination).toBe(target.path);
  });

  it("changed, turned off and on, deleted: each recorded and flushed; turning one on checks its address again", async () => {
    const a = await newTenant();
    const { ctx, address, base } = await liveSite(a);
    const [contact, offers] = [await published(ctx, "page", "Contact"), await published(ctx, "page", "Offers")];
    const { redirect } = await add(ctx, "/old-offers", contact.path);
    let reads = await mapReads(ctx);

    const changed = await updateRedirect(ctx, redirect.id, { destination: offers.path, statusCode: 302 });
    expect(changed).toMatchObject({ changed: true, redirect: { destination: offers.path, statusCode: 302 } });
    expect(flushes(changed.events, reads)).toBe(true);
    expect(await visit(address, "/old-offers")).toEqual({ redirect: `${base}${offers.path}`, status: 307 });
    expect(await updateRedirect(ctx, redirect.id, { destination: `${offers.path}/`, statusCode: 302 })).toMatchObject({ changed: false, events: [] });

    reads = await mapReads(ctx);
    const off = await updateRedirect(ctx, redirect.id, { isActive: false });
    expect(flushes(off.events, reads)).toBe(true);
    expect(await visit(address, "/old-offers")).toEqual({ notFound: true });
    // While it is off, a page is published at its address: turning it on is refused; the page wins.
    const taker = (await createEntry(ctx, { type: "page", title: "Old offers" })).entry;
    await publish(ctx, taker.id);
    expect((await refusalOf(() => updateRedirect(ctx, redirect.id, { isActive: true }))).fieldErrors?.isActive?.[0]).toContain("A published page or post is at /old-offers");
    await unpublishEntry(ctx, taker.id);
    expect((await updateRedirect(ctx, redirect.id, { isActive: true })).redirect.isActive).toBe(true);
    expect(await visit(address, "/old-offers")).toEqual({ redirect: `${base}${offers.path}`, status: 307 });

    reads = await mapReads(ctx);
    const gone = await deleteRedirect(ctx, redirect.id);
    expect(flushes(gone.events, reads)).toBe(true);
    expect(await visit(address, "/old-offers")).toEqual({ notFound: true });
    expect((await refusalOf(() => deleteRedirect(ctx, redirect.id))).kind).toBe("NotFound");
    expect((await records(ctx, "redirect.updated")).map((row) => (row.metadata as { fields: string[] }).fields)).toEqual(
      expect.arrayContaining([["destination", "status"], ["active"], ["active"]]),
    );
    expect(await records(ctx, "redirect.deleted")).toHaveLength(1);
  });

  it("a failed record saves nothing; a redirect and a publish at its address at once take turns: the published page wins either way", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    await published(ctx, "page", "Contact");
    await expect(whileFailing("audit_logs", "insert", () => add(ctx, "/a", "/contact"))).rejects.toThrow();
    expect(await rows(ctx)).toEqual([]);

    // A post renamed to /blog/rye-bread while someone redirects /blog/rye-bread elsewhere, at the same moment, five times:
    // whichever goes first, no redirect is left on at the address the post is published at.
    for (let round = 0; round < 5; round++) {
      const post = await published(ctx, "post", `Rye ${round}`);
      await save(ctx, post.id, { slug: `rye-bread-${round}` });
      const version = await draftVersion(ctx, post.id);
      await Promise.allSettled([publishEntry(ctx, post.id, version), add(ctx, `/blog/rye-bread-${round}`, "/contact")]);
      expect(await visit(address, `/blog/rye-bread-${round}`), `round ${round}`).toEqual({ page: `/blog/rye-bread-${round}` });
      expect((await rows(ctx)).filter((row) => row.source === `/blog/rye-bread-${round}` && row.active), `round ${round}`).toEqual([]);
    }
  });
});

describe("redirects left by Forge when a live address changes", () => {
  it("a post republished with a new slug: its old address 301s to the new one; again, still one hop; back to the first, which takes its address back", async () => {
    const a = await newTenant();
    const { ctx, address, base } = await liveSite(a);
    const post = await published(ctx, "post", "Rye");
    let reads = await mapReads(ctx);
    const renamed = await publish(ctx, post.id, { slug: "rye-bread" });
    expect(renamed.redirects).toEqual({ made: [{ source: "/blog/rye", destination: "/blog/rye-bread" }], turnedOff: [], repointed: 0 });
    expect(flushes(renamed.events, reads)).toBe(true);
    expect(await rows(ctx)).toEqual([{ source: "/blog/rye", destination: "/blog/rye-bread", status: 301, origin: "auto", active: true }]);
    expect(await visit(address, "/blog/rye")).toEqual({ redirect: `${base}/blog/rye-bread`, status: 308 });
    expect(await visit(address, "/blog/rye-bread")).toEqual({ page: "/blog/rye-bread" });

    // Canonical and sitemap: the current address only.
    const site = (await loadPublicSite(ctx.org.id, ctx.site.id))!;
    const page = (await publicPageFor(site, ["blog", "rye-bread"]))!;
    expect(publicPageSeo(site, { kind: "address", address }, page).canonical.value).toBe(`${ORIGIN}${base}/blog/rye-bread`);
    const urls = sitemapUrlsOf(await loadSitemapRows(ctx.org.id, ctx.site.id, "en"), `${ORIGIN}${base}`, "blog").map((url) => url.loc);
    expect(urls).toContain(`${ORIGIN}${base}/blog/rye-bread`);
    expect(urls).not.toContain(`${ORIGIN}${base}/blog/rye`);

    await publish(ctx, post.id, { slug: "rye-loaf" });
    expect((await rows(ctx)).map((row) => [row.source, row.destination])).toEqual([["/blog/rye", "/blog/rye-loaf"], ["/blog/rye-bread", "/blog/rye-loaf"]]);
    reads = await mapReads(ctx);
    const back = await publish(ctx, post.id, { slug: "rye" });
    expect(back.redirects.turnedOff).toEqual([{ source: "/blog/rye", destination: "/blog/rye-loaf" }]);
    expect(flushes(back.events, reads)).toBe(true);
    expect((await rows(ctx)).map((row) => [row.source, row.destination, row.active])).toEqual([
      ["/blog/rye", "/blog/rye-loaf", false], ["/blog/rye-bread", "/blog/rye", true], ["/blog/rye-loaf", "/blog/rye", true],
    ]);
    expect(await visit(address, "/blog/rye")).toEqual({ page: "/blog/rye" });
    expect(await visit(address, "/blog/rye-bread")).toEqual({ redirect: `${base}/blog/rye`, status: 308 });
    // The same publish again (idempotent) writes nothing.
    expect((await publishEntry(ctx, post.id, await draftVersion(ctx, post.id))).redirects).toEqual(none);
  });

  it("a page moved with the pages below it: each live one redirects, a draft below it does not; a typed menu link follows through the redirect", async () => {
    const a = await newTenant();
    const { ctx, address, base } = await liveSite(a);
    const company = await published(ctx, "page", "Company");
    const about = await published(ctx, "page", "About");
    const team = await published(ctx, "page", "Team", { parentId: about.id });
    const { entry: plans } = await createEntry(ctx, { type: "page", title: "Plans", parentId: about.id });
    await saveMenu(ctx, "header", [{ id: uuidv7(), kind: "url", url: "/about/team", label: "Our team", newTab: false }], 0);

    const reads = await mapReads(ctx);
    const moved = await movePage(ctx, about.id, company.id);
    expect(moved.redirects.made.sort((x, y) => x.source.localeCompare(y.source))).toEqual([
      { source: "/about", destination: "/company/about" }, { source: "/about/team", destination: "/company/about/team" },
    ]);
    expect(flushes(moved.events, reads)).toBe(true);
    expect((await rows(ctx)).map((row) => row.source)).not.toContain(plans.path);
    expect(await visit(address, "/about/team")).toEqual({ redirect: `${base}/company/about/team`, status: 308 });
    expect(team.path).toBe("/about/team");
    // The menu link is not rewritten: it still names /about/team, which redirects.
    const site = (await loadPublicSite(ctx.org.id, ctx.site.id))!;
    expect((await publicMenusFor(site, { kind: "address", address })).header.map((item) => item.href)).toEqual([`${base}/about/team`]);
    // And back: the old addresses are the pages' again; the new ones redirect.
    const backAgain = await movePage(ctx, about.id, null);
    expect(backAgain.redirects.turnedOff.map((one) => one.source).sort()).toEqual(["/about", "/about/team"]);
    expect(await visit(address, "/about/team")).toEqual({ page: "/about/team" });
    expect(await visit(address, "/company/about/team")).toEqual({ redirect: `${base}/about/team`, status: 308 });
  });

  it("the Home page changed: the new Home's old address redirects to /, the old Home's `/` stays the site's", async () => {
    const a = await newTenant();
    const { ctx, address, base } = await liveSite(a);
    const home = (await inTenant(ctx, (tx) => tx.select().from(t.entries).where(and(eq(t.entries.siteId, ctx.site.id), eq(t.entries.path, "/")))))[0]!;
    await publish(ctx, home.id);
    const welcome = await published(ctx, "page", "Welcome");
    const changed = await setHomepage(ctx, welcome.id);
    expect(changed.redirects.made).toEqual([{ source: "/welcome", destination: "/" }]);
    expect((await rows(ctx)).map((row) => row.source)).toEqual(["/welcome"]);
    expect(await visit(address, "/welcome")).toEqual({ redirect: base, status: 308 });
    expect(await visit(address, "/")).toEqual({ page: "/" });
  });

  it("a new blog path: the old index and every archive redirect; posts stay where they are until published again", async () => {
    const a = await newTenant();
    const { ctx, address, base } = await liveSite(a);
    const { term: bread } = await createTerm(ctx, { taxonomy: "category", name: "Bread" });
    const { term: rye } = await createTerm(ctx, { taxonomy: "tag", name: "Rye" });
    const post = await published(ctx, "post", "Rye season", { termIds: [bread.id, rye.id] });
    const reads = await mapReads(ctx);
    const saved = await updateSiteSettings(ctx, "reading", { blogPath: "news", postsPerPage: 10 }, (await getSiteSettings(ctx)).version);
    expect(saved.redirects.made.map((one) => [one.source, one.destination]).sort()).toEqual([
      ["/blog", "/news"], ["/blog/category/bread", "/news/category/bread"], ["/blog/tag/rye", "/news/tag/rye"],
    ]);
    expect(flushes(saved.events, reads)).toBe(true);
    expect(await visit(address, "/blog")).toEqual({ redirect: `${base}/news`, status: 308 });
    expect(await visit(address, "/blog/category/bread")).toEqual({ redirect: `${base}/news/category/bread`, status: 308 });
    expect(await visit(address, post.path)).toEqual({ page: "/blog/rye-season" }); // still at its published address
    expect(await visit(address, "/blog/page/2")).toEqual({ notFound: true });
    // Published again: it moves under /news, with its own redirect.
    const republished = await publish(ctx, post.id, { title: "Rye season, again" });
    expect(republished.redirects.made).toEqual([{ source: "/blog/rye-season", destination: "/news/rye-season" }]);
    expect(await visit(address, "/blog/rye-season")).toEqual({ redirect: `${base}/news/rye-season`, status: 308 });
    // And back to /blog: the index and archives are the blog's again (their redirects off); /news redirects.
    const restored = await updateSiteSettings(ctx, "reading", { blogPath: "blog", postsPerPage: 10 }, (await getSiteSettings(ctx)).version);
    expect(restored.redirects.turnedOff.map((one) => one.source).sort()).toEqual(["/blog", "/blog/category/bread", "/blog/tag/rye"]);
    expect(await visit(address, "/blog")).toEqual({ page: "blog-index" });
    expect(await visit(address, "/news")).toEqual({ redirect: `${base}/blog`, status: 308 });
  });

  it("a category or tag renamed: its old archive redirects; a new term at a redirected archive takes it back; a deleted term leaves none", async () => {
    const a = await newTenant();
    const { ctx, address, base } = await liveSite(a);
    const { term: bread } = await createTerm(ctx, { taxonomy: "category", name: "Bread" });
    const reads = await mapReads(ctx);
    const renamed = await updateTerm(ctx, bread.id, { slug: "loaves" });
    expect(renamed.redirects.made).toEqual([{ source: "/blog/category/bread", destination: "/blog/category/loaves" }]);
    expect(flushes(renamed.events, reads)).toBe(true);
    expect(await visit(address, "/blog/category/bread")).toEqual({ redirect: `${base}/blog/category/loaves`, status: 308 });
    // A tag of the same slug is another address; a new category named Bread takes the old one back.
    await createTerm(ctx, { taxonomy: "tag", name: "Bread" });
    expect(await visit(address, "/blog/category/bread")).toEqual({ redirect: `${base}/blog/category/loaves`, status: 308 });
    const again = await createTerm(ctx, { taxonomy: "category", name: "Bread" });
    expect(again.redirects.turnedOff).toEqual([{ source: "/blog/category/bread", destination: "/blog/category/loaves" }]);
    expect(await visit(address, "/blog/category/bread")).toEqual({ page: "term-archive" });
    // Deleting a term makes no redirect: its archive answers "not found" (a redirect by hand can send it elsewhere).
    const before = (await rows(ctx)).length;
    await deleteTerm(ctx, again.term.id);
    expect(await rows(ctx)).toHaveLength(before);
    expect(await visit(address, "/blog/category/bread")).toEqual({ notFound: true });
  });

  it("publishing at a redirected address turns that redirect off, and says so", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    await published(ctx, "page", "Offers");
    await add(ctx, "/summer-sale", "/offers");
    const { entry } = await createEntry(ctx, { type: "page", title: "Summer sale" });
    const reads = await mapReads(ctx);
    const data = new FormData();
    data.set("version", String(await draftVersion(ctx, entry.id)));
    const outcome = await submitPublishEntry(a.actor, a.org.slug, site.slug, entry.id, data);
    expect(outcome.state).toMatchObject({ status: "success", message: "Published. The redirect from /summer-sale is turned off: the site shows its own content there now." });
    expect(flushes(outcome.invalidate!, reads)).toBe(true);
    expect((await rows(ctx)).find((row) => row.source === "/summer-sale")).toMatchObject({ active: false });
  });

  it("a failure anywhere in a path change keeps everything: no redirect, no move", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const post = await published(ctx, "post", "Rye");
    await save(ctx, post.id, { slug: "rye-bread" });
    const version = await draftVersion(ctx, post.id);
    await expect(whileFailing("redirects", "insert", () => publishEntry(ctx, post.id, version))).rejects.toThrow();
    expect(await rows(ctx)).toEqual([]);
    expect(await visit(address, "/blog/rye")).toEqual({ page: "/blog/rye" });
    expect(await visit(address, "/blog/rye-bread")).toEqual({ notFound: true });
    // And the other way round: a move refused (an address in the moved tree is taken) leaves no redirect claiming it happened.
    const one = await published(ctx, "page", "One");
    const two = await published(ctx, "page", "Two");
    await published(ctx, "page", "Inner", { parentId: two.id });
    const taken = await published(ctx, "page", "Two", { parentId: one.id, slug: "two" });
    expect(taken.path).toBe("/one/two");
    expect((await refusalOf(() => movePage(ctx, two.id, one.id))).kind).toBe("Conflict");
    expect(await rows(ctx)).toEqual([]);
    expect(await visit(address, "/two/inner")).toEqual({ page: "/two/inner" });
  });
});

describe("unpublished, in the trash, restored", () => {
  it("unpublish: its address answers not found, or redirects where the person says (for those who manage redirects); a refused destination refuses the unpublish", async () => {
    const a = await newTenant();
    const { ctx, address, base, site } = await liveSite(a);
    const [offer, offers] = [await published(ctx, "page", "Old offer"), await published(ctx, "page", "Offers")];
    const draft = (await createEntry(ctx, { type: "page", title: "Draft" })).entry;

    // A destination it does not serve: nothing happens.
    const refused = await refusalOf(() => unpublishEntry(ctx, offer.id, { redirectTo: draft.path }));
    expect(refused).toMatchObject({ kind: "Validation", fieldErrors: { redirectTo: [expect.stringContaining("Nothing is published at /draft")] } });
    expect(await visit(address, offer.path)).toEqual({ page: offer.path });

    const reads = await mapReads(ctx);
    const unpublished = await unpublishEntry(ctx, offer.id, { redirectTo: offers.path });
    expect(unpublished.redirects.made).toEqual([{ source: offer.path, destination: offers.path }]);
    expect(flushes(unpublished.events, reads)).toBe(true);
    expect(await visit(address, offer.path)).toEqual({ redirect: `${base}${offers.path}`, status: 308 });
    expect((await records(ctx, "redirect.created")).at(-1)).toMatchObject({ metadata: { source: offer.path, destination: offers.path, statusCode: 301 } });

    // The form says where visitors go; an Author (who may unpublish their post) may not send them anywhere.
    const post = await published(ctx, "post", "Gone soon");
    const data = new FormData();
    data.set("redirectTo", offers.path);
    expect((await submitUnpublishEntry(a.actor, a.org.slug, site.slug, post.id, data)).state.message).toBe(
      `Unpublished: it is no longer on the site. Visitors of ${post.path} go to ${offers.path}.`,
    );
    const author = await addMember(a.org, "author");
    const authorCtx = await resolveSiteContext(author.actor, a.org.slug, site.slug);
    const own = (await createEntry(authorCtx, { type: "post", title: "Mine" })).entry;
    await publishEntry(ctx, own.id, await draftVersion(ctx, own.id));
    expect((await refusalOf(() => unpublishEntry(authorCtx, own.id, { redirectTo: offers.path }))).kind).toBe("Forbidden");
    expect((await unpublishEntry(authorCtx, own.id)).changed).toBe(true);
    expect(await visit(address, own.path)).toEqual({ notFound: true });
  });

  it("trashed, restored and published: never public in between; a redirect left at its address is turned off when it is published again", async () => {
    const a = await newTenant();
    const { ctx, address, base } = await liveSite(a);
    const [page, other] = [await published(ctx, "page", "Seasonal"), await published(ctx, "page", "Other")];
    await unpublishEntry(ctx, page.id);
    await trashEntry(ctx, page.id);
    expect(await visit(address, page.path)).toEqual({ notFound: true });
    // While it is in the trash, someone sends its old address elsewhere.
    await add(ctx, page.path, other.path);
    expect(await visit(address, page.path)).toEqual({ redirect: `${base}${other.path}`, status: 308 });
    // Restored as a draft: still not public, the redirect still answers.
    await restoreEntry(ctx, page.id);
    expect(await visit(address, page.path)).toEqual({ redirect: `${base}${other.path}`, status: 308 });
    // Published: the page takes its address back.
    const back = await publish(ctx, page.id);
    expect(back.redirects.turnedOff).toEqual([{ source: page.path, destination: other.path }]);
    expect(await visit(address, page.path)).toEqual({ page: page.path });
  });
});

describe("the not-found page", () => {
  it("a published page of the site, set by those who manage redirects; drawn while it is published; refused otherwise", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    const missing = await published(ctx, "page", "Lost");
    const post = await published(ctx, "post", "A post");
    const draft = (await createEntry(ctx, { type: "page", title: "Draft" })).entry;
    const home = (await inTenant(ctx, (tx) => tx.select().from(t.entries).where(and(eq(t.entries.siteId, ctx.site.id), eq(t.entries.path, "/")))))[0]!;
    await publish(ctx, home.id);
    const other = await liveSite(a, "Other");
    const theirs = await published(other.ctx, "page", "Theirs");

    for (const [id, reason] of [[post.id, "a post cannot"], [draft.id, "Publish the page first"], [home.id, "home page cannot"]] as const) {
      expect((await refusalOf(() => setNotFoundPage(ctx, id))).fieldErrors?.entryId?.[0], id).toContain(reason);
    }
    expect((await refusalOf(() => setNotFoundPage(ctx, theirs.id))).kind).toBe("NotFound");
    const viewer = await resolveSiteContext((await addMember(a.org, "viewer")).actor, a.org.slug, site.slug);
    expect((await refusalOf(() => setNotFoundPage(viewer, missing.id))).kind).toBe("Forbidden");

    applied.tags.length = 0;
    await loadPublicSite(ctx.org.id, ctx.site.id);
    const reads = [...applied.tags];
    const set = await setNotFoundPage(ctx, missing.id);
    expect(set.changed).toBe(true);
    expect(flushes(set.events, reads)).toBe(true);
    expect(await setNotFoundPage(ctx, missing.id)).toEqual({ changed: false, events: [] });
    expect(await records(ctx, "site.settings_changed")).toEqual(expect.arrayContaining([expect.objectContaining({ metadata: { name: "Harbour", group: "seo", fields: ["notFoundPage"] } })]));
    const shown = await notFoundPageFor((await loadPublicSite(ctx.org.id, ctx.site.id))!);
    expect(shown).toMatchObject({ kind: "entry", entry: { title: "Lost", path: "/lost" } });
    expect((await getRedirects(ctx)).notFoundPage).toEqual({ id: missing.id, title: "Lost", path: "/lost", live: true });
    // Unpublished: the theme's page again (the setting stays, flagged).
    await unpublishEntry(ctx, missing.id);
    expect(await notFoundPageFor((await loadPublicSite(ctx.org.id, ctx.site.id))!)).toBeNull();
    expect((await getRedirects(ctx)).notFoundPage).toMatchObject({ live: false });
    expect((await setNotFoundPage(ctx, null)).changed).toBe(true);
    expect((await loadPublicSite(ctx.org.id, ctx.site.id))!.notFoundEntryId).toBeNull();
  });
});

describe("one site's redirects are its own", () => {
  it("never read, matched or changed from another site, of the same organization or another", async () => {
    const a = await newTenant();
    const one = await liveSite(a, "One");
    const two = await liveSite(a, "Two");
    await published(one.ctx, "page", "Here");
    await published(two.ctx, "page", "Here");
    const { redirect } = await add(one.ctx, "/old", "/here");
    expect(await visit(two.address, "/old")).toEqual({ notFound: true });
    expect(Object.keys(await loadRedirects(two.ctx.org.id, two.ctx.site.id))).toEqual([]);
    expect((await refusalOf(() => updateRedirect(two.ctx, redirect.id, { isActive: false }))).kind).toBe("NotFound");
    expect((await refusalOf(() => deleteRedirect(two.ctx, redirect.id))).kind).toBe("NotFound");
    // From the form, with the other site's slug in the URL: not found, nothing written.
    const b = await newTenant("Other");
    const data = new FormData();
    data.set("source", "/x");
    data.set("destination", "/");
    const outcome = await submitCreateRedirect(b.actor, b.org.slug, one.site.slug, data);
    expect(outcome.refused).toBe("NotFound");
    expect((await rows(one.ctx)).map((row) => row.source)).toEqual(["/old"]);
    // A site's map is cached under its own tags only.
    applied.tags.length = 0;
    await loadRedirects(one.ctx.org.id, one.ctx.site.id);
    expect(applied.tags.every((tag) => tag.includes(one.ctx.site.id))).toBe(true);
  });
});
