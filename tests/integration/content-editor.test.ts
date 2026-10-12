import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { createEntry, ENTRY_SEARCH_LIMIT, getEntryForEditor, publishEntry, saveDraft, searchEntries, submitSaveDraft } from "@/modules/content";
import { createSite, deleteSite, getSiteOverview } from "@/modules/sites";
import { inTenant, resolveSiteContext, type OrgContext, type SiteContext } from "@/modules/tenancy";
import * as t from "@/platform/db/schema";
import { actorOf, addMember, newSlug, newTenant, refusalOf } from "../fixtures/tenants";

/**
 * M5-4 against real Postgres: what the editor and its link picker read. One
 * entry for the editor, with what the caller may do; the site's entries
 * matching a title; the overview's Home page. Only the context's site, ever.
 */

type Tenant = Awaited<ReturnType<typeof newTenant>>;
type Member = { actor: ReturnType<typeof actorOf>; ctx: OrgContext };

async function newSite(tenant: Tenant, name = "Editor") {
  const { site } = await createSite(tenant.ctx, { name, address: newSlug("editor"), language: "en", timezone: "UTC" });
  return { site, ctx: await resolveSiteContext(tenant.actor, tenant.org.slug, site.slug) };
}
const as = (member: Member, site: { slug: string }) => resolveSiteContext(member.actor, member.ctx.org.slug, site.slug);
const homeOf = async (ctx: SiteContext) =>
  (await inTenant(ctx, (tx) => tx.select({ id: t.siteSettings.homepageEntryId }).from(t.siteSettings).where(eq(t.siteSettings.siteId, ctx.site.id))))[0]!.id!;
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

describe("getEntryForEditor", () => {
  it("the entry, its draft and what the caller may do; the Home page says it is", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const home = await homeOf(ctx);
    expect(await getEntryForEditor(ctx, home, "page")).toMatchObject({
      id: home, type: "page", status: "draft", path: "/", isHome: true, publishedDraftVersion: null, canEdit: true, canPublish: true,
      draft: { title: "Home", slug: "home", version: 1, content: { v: 1, doc: { type: "doc" } } },
    });
    const { version } = await saveDraft(ctx, home, 1, { title: "Welcome" });
    await publishEntry(ctx, home, version);
    expect(await getEntryForEditor(ctx, home, "page")).toMatchObject({ status: "published", publishedDraftVersion: 2, draft: { title: "Welcome", version: 2 } });
  });

  it("what each role may do is the policies' answer: Editors pages and posts, Authors their own posts, Viewers nothing", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    const editor = await addMember(a.org, "editor");
    const author = await addMember(a.org, "author");
    const viewer = await addMember(a.org, "viewer");
    const page = (await createEntry(ctx, { type: "page", title: "Page" })).entry;
    const own = (await createEntry(await as(author, site), { type: "post", title: "Own" })).entry;
    const others = (await createEntry(ctx, { type: "post", title: "Others" })).entry;
    const flags = async (member: Member, id: string, type: "page" | "post") => {
      const entry = await getEntryForEditor(await as(member, site), id, type);
      return [entry.canEdit, entry.canPublish];
    };
    expect(await flags(editor, page.id, "page")).toEqual([true, true]);
    expect(await flags(editor, others.id, "post")).toEqual([true, true]);
    expect(await flags(author, own.id, "post")).toEqual([true, true]);
    expect(await flags(author, others.id, "post")).toEqual([false, false]);
    expect(await flags(author, page.id, "page")).toEqual([false, false]);
    expect(await flags(viewer, page.id, "page")).toEqual([false, false]);
    expect(await flags(viewer, own.id, "post")).toEqual([false, false]);
  });

  it("not found: another site's entry (even of the organization), another organization's, the other type, the trash, a deleted site, an id of nothing", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const sibling = await newSite(a, "Sibling");
    const other = await newSite(await newTenant());
    const post = (await createEntry(ctx, { type: "post", title: "Post" })).entry;
    const trashed = (await createEntry(ctx, { type: "page", title: "Trashed" })).entry;
    await inTenant(ctx, (tx) => tx.update(t.entries).set({ deletedAt: new Date() }).where(eq(t.entries.id, trashed.id)));
    const cases: [string, "page" | "post"][] = [
      [await homeOf(sibling.ctx), "page"], [await homeOf(other.ctx), "page"], [post.id, "page"], [await homeOf(ctx), "post"], [trashed.id, "page"], [uuidv7(), "page"],
    ];
    for (const [id, type] of cases) expect((await refusalOf(() => getEntryForEditor(ctx, id, type))).kind, `${id} ${type}`).toBe("NotFound");
    const doomed = await newSite(a, "Doomed");
    const home = await homeOf(doomed.ctx);
    await deleteSite(doomed.ctx);
    expect((await refusalOf(() => getEntryForEditor(doomed.ctx, home, "page"))).kind).toBe("NotFound");
  });
});

describe("searchEntries (the link picker)", () => {
  it("this site's pages and posts whose title contains the text, drafted or live; the trash, other sites and other organizations never", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const sibling = await newSite(a, "Sibling");
    const other = await newSite(await newTenant());
    const about = (await createEntry(ctx, { type: "page", title: "About us" })).entry;
    const post = (await createEntry(ctx, { type: "post", title: "News about us" })).entry;
    const renamed = (await createEntry(ctx, { type: "page", title: "Old name" })).entry;
    await saveDraft(ctx, renamed.id, 1, { title: "Brand new about" });
    const trashed = (await createEntry(ctx, { type: "page", title: "About the trash" })).entry;
    await inTenant(ctx, (tx) => tx.update(t.entries).set({ deletedAt: new Date() }).where(eq(t.entries.id, trashed.id)));
    await createEntry(sibling.ctx, { type: "page", title: "About the sibling" });
    await createEntry(other.ctx, { type: "page", title: "About the other" });

    const found = await searchEntries(ctx, "ABOUT");
    expect(found.map((match) => match.id).sort()).toEqual([about.id, post.id, renamed.id].sort());
    expect(found.find((match) => match.id === renamed.id)).toMatchObject({ title: "Brand new about", path: "/old-name", type: "page", status: "draft" });
    expect(found.find((match) => match.id === post.id)).toMatchObject({ type: "post", path: "/blog/news-about-us" });
    // Nothing typed: the latest of this site, Home page included.
    expect((await searchEntries(ctx, "")).map((match) => match.id)).toContain(await homeOf(ctx));
  });

  it("what someone types is text: % and _ match only themselves; at most ten results", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    await createEntry(ctx, { type: "page", title: "100% organic" });
    await createEntry(ctx, { type: "page", title: "snake_case" });
    expect((await searchEntries(ctx, "%")).map((match) => match.title)).toEqual(["100% organic"]);
    expect((await searchEntries(ctx, "_")).map((match) => match.title)).toEqual(["snake_case"]);
    for (let i = 0; i < ENTRY_SEARCH_LIMIT + 3; i++) await createEntry(ctx, { type: "post", title: `Many ${i}` });
    expect(await searchEntries(ctx, "many")).toHaveLength(ENTRY_SEARCH_LIMIT);
  });

  it("every member may search (reading is every role's); someone outside cannot even have the context", async () => {
    const a = await newTenant();
    const { site } = await newSite(a);
    const viewer = await addMember(a.org, "viewer");
    expect((await searchEntries(await as(viewer, site), "home")).length).toBe(1);
    const outsider = await newTenant();
    expect((await refusalOf(() => resolveSiteContext(outsider.actor, a.org.slug, site.slug))).kind).toBe("NotFound");
  });
});

describe("the overview's Home page, and autosave's answer", () => {
  it("a new site's draft Home page; published once published; none for a site without one", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const home = await homeOf(ctx);
    expect((await getSiteOverview(ctx)).home).toEqual({ id: home, title: "Home", status: "draft" });
    await publishEntry(ctx, home, 1);
    expect((await getSiteOverview(ctx)).home).toMatchObject({ status: "published" });
    // A site made before M5-3: no Home page.
    await inTenant(ctx, (tx) => tx.delete(t.entries).where(eq(t.entries.id, home)));
    expect((await getSiteOverview(ctx)).home).toBeNull();
  });

  it("a successful autosave does not ask for the page to be rendered again; a failed one is an error, never a success", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    const home = await homeOf(ctx);
    const saved = await submitSaveDraft(a.actor, a.org.slug, site.slug, home, form({ version: "1", draft: JSON.stringify({ title: "Saved" }) }));
    expect(saved).toMatchObject({ state: { status: "success", values: { version: "2" } }, refresh: false });
    const stale = await submitSaveDraft(a.actor, a.org.slug, site.slug, home, form({ version: "1", draft: JSON.stringify({ title: "Stale" }) }));
    expect(stale).toMatchObject({ refused: "Conflict", state: { status: "error" } });
  });
});
