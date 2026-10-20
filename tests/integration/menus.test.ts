import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { describe, expect, it, vi } from "vitest";
import { createEntry, createTerm, deleteTerm, publishEntry, purgeEntry, restoreEntry, saveDraft, scheduleEntry, toLocalInput, trashEntry, unpublishEntry, updateTerm } from "@/modules/content";
import { getMenus, MENU_CONFLICT, saveMenu, submitSaveMenu } from "@/modules/navigation";
import { createSite, getSiteSettings, updateSiteSettings } from "@/modules/sites";
import { inTenant, resolveSiteContext, type SiteContext } from "@/modules/tenancy";
import { tags, tagsForAll, type CacheEvent } from "@/platform/cache";
import * as t from "@/platform/db/schema";
import { withTenant } from "@/platform/db/tenant";
import { themeFor } from "@/themes/render";
import { whileFailing } from "../fixtures/db-failure";
import { addMember, newSlug, newTenant, refusalOf } from "../fixtures/tenants";

// The public reads are `'use cache'`: here their cache calls do nothing but note each tag a read applies, so the
// tests can check that every change that alters a menu flushes a tag the menus are read under.
const applied = vi.hoisted(() => ({ tags: [] as string[] }));
vi.mock("next/cache", async (original) => ({
  ...(await original<typeof import("next/cache")>()),
  cacheLife: () => {},
  cacheTag: (...names: string[]) => void applied.tags.push(...names),
  revalidateTag: () => {},
  updateTag: () => {},
}));
const { loadMenus, loadPublicSite, publicMenusFor, renderableSite } = await import("@/modules/rendering");

/**
 * M8-3 against real Postgres through PgBouncer: a site's header and footer menus saved as a whole (checked, versioned,
 * recorded, flushed), who may, what a new link may point at, and the public site drawing only live destinations: after
 * unpublishing, the trash, a restore, a purge, a move, a term's change, and with stored links that point elsewhere.
 */

type Tenant = Awaited<ReturnType<typeof newTenant>>;

async function liveSite(tenant: Tenant, name = "Menus") {
  const address = newSlug("menu");
  const { site } = await createSite(tenant.ctx, { name, address, language: "en", timezone: "UTC" });
  await withTenant({ orgId: tenant.org.id }, (tx) => tx.update(t.sites).set({ status: "live" }).where(eq(t.sites.id, site.id)));
  return { site, address, ctx: await resolveSiteContext(tenant.actor, tenant.org.slug, site.slug) };
}
const id = () => uuidv7();
const toEntry = (entryId: string, extra: Record<string, unknown> = {}) => ({ id: id(), kind: "entry", entryId, label: "", newTab: false, ...extra });
const toTerm = (termId: string, extra: Record<string, unknown> = {}) => ({ id: id(), kind: "term", termId, label: "", newTab: false, ...extra });
const toBlog = (extra: Record<string, unknown> = {}) => ({ id: id(), kind: "archive", contentType: "post", label: "", newTab: false, ...extra });
const toUrl = (url: string, label: string, extra: Record<string, unknown> = {}) => ({ id: id(), kind: "url", url, label, newTab: false, ...extra });

const draftVersion = async (ctx: SiteContext, entryId: string) =>
  (await inTenant(ctx, (tx) => tx.select({ version: t.entryDrafts.version }).from(t.entryDrafts).where(eq(t.entryDrafts.entryId, entryId))))[0]!.version;
async function published(ctx: SiteContext, type: "page" | "post", title: string) {
  const { entry } = await createEntry(ctx, { type, title });
  const result = await publishEntry(ctx, entry.id, await draftVersion(ctx, entry.id));
  return { ...entry, events: result.events };
}
/** A draft post scheduled two days ahead (the site is in UTC): not on the site until then. */
async function scheduled(ctx: SiteContext, title: string) {
  const { entry } = await createEntry(ctx, { type: "post", title });
  await scheduleEntry(ctx, entry.id, { runAt: toLocalInput(new Date(Date.now() + 2 * 86_400_000), "UTC"), version: await draftVersion(ctx, entry.id) });
  return entry;
}
/** Unpublished first, as the trash requires (M7-1). */
async function binned(ctx: SiteContext, entryId: string) {
  await unpublishEntry(ctx, entryId);
  return trashEntry(ctx, entryId);
}
const versionOf = async (ctx: SiteContext, location: "header" | "footer" = "header") => (await getMenus(ctx)).menus[location].version;
const save = async (ctx: SiteContext, items: unknown[], location: "header" | "footer" = "header") => saveMenu(ctx, location, items, await versionOf(ctx, location));
const records = (ctx: SiteContext) => inTenant(ctx, (tx) => tx.select().from(t.auditLogs).where(and(eq(t.auditLogs.organizationId, ctx.org.id), eq(t.auditLogs.action, "menu.updated"))));
const form = (items: unknown, version: number | string) => {
  const data = new FormData();
  data.set("items", typeof items === "string" ? items : JSON.stringify(items));
  data.set("version", String(version));
  return data;
};

/** What the public site draws: labels and addresses, two levels. */
async function drawn(ctx: SiteContext, address: string) {
  applied.tags.length = 0;
  const site = (await loadPublicSite(ctx.org.id, ctx.site.id))!;
  const menus = await publicMenusFor(site, { kind: "address", address });
  const words = (items: { label: string; href: string; newTab?: boolean; children?: readonly unknown[] }[]): unknown[] =>
    items.map((item) => ({ [item.label]: item.href, ...(item.newTab ? { newTab: true } : {}), ...(item.children ? { under: words(item.children as never) } : {}) }));
  return { header: words(menus.header), footer: words(menus.footer) };
}
/** Every tag the public menus were just read under is flushed at once by these events. */
const flushesMenus = (events: CacheEvent[]) => {
  const immediate = tagsForAll(events).immediate;
  return applied.tags.some((tag) => immediate.includes(tag));
};

describe("saving a menu", () => {
  it("the four kinds, two levels, saved as a whole at the next version, recorded, and the site's config flushed; the same menu again changes nothing", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a, "Harbour");
    const about = await published(ctx, "page", "About us");
    const { term: bread } = await createTerm(ctx, { taxonomy: "category", name: "Bread" });
    const items = [
      toEntry(about.id, { children: [toUrl("/contact", "Contact"), toUrl("https://shop.example.com", "Shop", { newTab: true })] }),
      toTerm(bread.id, { label: "Our bread" }),
      toBlog(),
    ];
    expect(await versionOf(ctx)).toBe(0);
    const saved = await saveMenu(ctx, "header", items, 0);
    expect(saved).toMatchObject({ changed: true, version: 1, events: [{ type: "site.configChanged", siteId: ctx.site.id }] });
    expect(tagsForAll(saved.events).immediate).toEqual([tags.config(ctx.site.id)]);
    const [row] = await inTenant(ctx, (tx) => tx.select().from(t.menus).where(eq(t.menus.siteId, ctx.site.id)));
    expect(row).toMatchObject({ location: "header", version: 1, updatedBy: a.user.id });
    expect(row!.items).toEqual(saved.items);
    expect(await records(ctx)).toEqual([expect.objectContaining({ resourceType: "menu", resourceId: row!.id, siteId: ctx.site.id, metadata: { name: "Harbour", location: "header", items: 5 } })]);

    expect(await drawn(ctx, address)).toEqual({
      header: [
        { "About us": `/s/${address}/about-us`, under: [{ Contact: `/s/${address}/contact` }, { Shop: "https://shop.example.com", newTab: true }] },
        { "Our bread": `/s/${address}/blog/category/bread` },
        { Blog: `/s/${address}/blog` },
      ],
      footer: [],
    });

    // The same items again: nothing written, recorded or flushed, whatever version is sent.
    expect(await saveMenu(ctx, "header", saved.items, 0)).toMatchObject({ changed: false, version: 1, events: [] });
    expect(await records(ctx)).toHaveLength(1);
    // A change: version 2, and the footer is a menu of its own.
    expect((await saveMenu(ctx, "header", saved.items.slice(1), 1)).version).toBe(2);
    expect((await save(ctx, [toBlog({ label: "News" })], "footer")).version).toBe(1);
    expect((await drawn(ctx, address)).footer).toEqual([{ News: `/s/${address}/blog` }]);
  });

  it("refused as a whole, keyed by the link: an unsafe address, a third level, too many links; nothing written", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const unsafe = toUrl("javascript:alert(1)", "Click");
    const refusal = await refusalOf(() => saveMenu(ctx, "header", [toBlog(), unsafe], 0));
    expect(refusal.kind).toBe("Validation");
    expect(refusal.fieldErrors).toEqual({ [`item.${unsafe.id}`]: [expect.stringContaining("full address")] });
    const child = toUrl("/b", "B", { children: [toUrl("/c", "C")] });
    expect((await refusalOf(() => saveMenu(ctx, "header", [toUrl("/a", "A", { children: [child] })], 0))).fieldErrors).toEqual({ [`item.${child.id}`]: [expect.stringContaining("two levels")] });
    const many = Array.from({ length: 101 }, (_, n) => toUrl(`/p${n}`, `P${n}`));
    expect((await refusalOf(() => saveMenu(ctx, "header", many, 0))).fieldErrors).toEqual({ items: ["A menu holds at most 100 links."] });
    expect((await refusalOf(() => saveMenu(ctx, "sidebar", [], 0))).kind).toBe("NotFound");
    expect(await inTenant(ctx, (tx) => tx.select().from(t.menus).where(eq(t.menus.siteId, ctx.site.id)))).toEqual([]);
  });

  it("a new link must point at this site's page, post, category or tag, not in the trash; a link already in the menu is kept as it is", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const other = await liveSite(a, "Second site");
    const b = await newTenant();
    const { ctx: bCtx } = await liveSite(b);
    const theirs = await published(other.ctx, "page", "Elsewhere");
    const foreign = await published(bCtx, "page", "Not yours");
    const { term: theirTerm } = await createTerm(other.ctx, { taxonomy: "category", name: "Theirs" });
    const kept = await published(ctx, "page", "Kept");
    const { entry: trashed } = await createEntry(ctx, { type: "page", title: "Binned" });
    await trashEntry(ctx, trashed.id);

    for (const [item, message] of [
      [toEntry(theirs.id), "Choose a page or post of this site that is not in the trash."],
      [toEntry(foreign.id), "Choose a page or post of this site that is not in the trash."],
      [toEntry(trashed.id), "Choose a page or post of this site that is not in the trash."],
      [toEntry(uuidv7()), "Choose a page or post of this site that is not in the trash."],
      [toTerm(theirTerm.id), "Choose a category or tag of this site."],
      [toTerm(uuidv7()), "Choose a category or tag of this site."],
    ] as const) {
      expect((await refusalOf(() => saveMenu(ctx, "header", [item], 0))).fieldErrors, JSON.stringify(item)).toEqual({ [`item.${item.id}`]: [message] });
    }

    // In the menu first, then trashed: saving again (to add something else) keeps it, as it is.
    const link = toEntry(kept.id);
    await saveMenu(ctx, "header", [link], 0);
    await binned(ctx, kept.id);
    const again = await saveMenu(ctx, "header", [link, toBlog()], 1);
    expect(again.items.map((one) => one.kind)).toEqual(["entry", "archive"]);
  });

  it("at the version the page opened: someone else's save since is a Conflict, and nothing is written", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    await saveMenu(ctx, "header", [toBlog()], 0);
    const first = await refusalOf(() => saveMenu(ctx, "header", [toBlog({ label: "News" })], 0));
    expect(first).toMatchObject({ kind: "Conflict", message: MENU_CONFLICT });
    await saveMenu(ctx, "header", [toBlog({ label: "Journal" })], 1);
    expect((await refusalOf(() => saveMenu(ctx, "header", [toBlog({ label: "Late" })], 1))).kind).toBe("Conflict");
    expect((await getMenus(ctx)).menus.header.items[0]!.label).toBe("Journal");
    // Through the form: the same answer, in the page's words.
    const outcome = await submitSaveMenu(a.actor, a.org.slug, ctx.site.slug, "header", form([toBlog({ label: "Late" })], 1));
    expect(outcome).toMatchObject({ refused: "Conflict", state: { status: "error", message: MENU_CONFLICT } });
    expect((await submitSaveMenu(a.actor, a.org.slug, ctx.site.slug, "header", form("{not json", 2))).state.fieldErrors).toEqual({ items: [expect.stringContaining("could not be read")] });
  });

  it("Owners, Admins and Editors; not Authors or Viewers, by the service or the form", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    let version = 0;
    for (const role of ["admin", "editor"] as const) {
      const member = await addMember(a.org, role);
      const theirs = await resolveSiteContext(member.actor, a.org.slug, site.slug);
      expect((await getMenus(theirs)).menus.header.version).toBe(version);
      version = (await saveMenu(theirs, "header", [toBlog({ label: role })], version)).version;
    }
    for (const role of ["author", "viewer"] as const) {
      const member = await addMember(a.org, role);
      const theirs = await resolveSiteContext(member.actor, a.org.slug, site.slug);
      expect((await refusalOf(() => getMenus(theirs))).kind, role).toBe("Forbidden");
      expect((await refusalOf(() => saveMenu(theirs, "header", [toBlog()], version))).kind, role).toBe("Forbidden");
      expect((await submitSaveMenu(member.actor, a.org.slug, site.slug, "header", form([toBlog()], version))).refused, role).toBe("Forbidden");
    }
    expect((await getMenus(ctx)).menus.header.items[0]!.label).toBe("editor");
  });

  it("touches nothing else: the site's settings, its other menu, another site's menus; a failed record saves nothing", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const other = await liveSite(a, "Other");
    await saveMenu(other.ctx, "header", [toBlog({ label: "Theirs" })], 0);
    await saveMenu(ctx, "footer", [toBlog({ label: "Footer" })], 0);
    const settingsBefore = await inTenant(ctx, (tx) => tx.select().from(t.siteSettings).where(eq(t.siteSettings.siteId, ctx.site.id)));
    await saveMenu(ctx, "header", [toBlog({ label: "Mine" })], 0);
    expect(await inTenant(ctx, (tx) => tx.select().from(t.siteSettings).where(eq(t.siteSettings.siteId, ctx.site.id)))).toEqual(settingsBefore);
    expect((await getMenus(ctx)).menus.footer.items[0]!.label).toBe("Footer");
    expect((await getMenus(other.ctx)).menus.header.items[0]!.label).toBe("Theirs");

    await expect(whileFailing("audit_logs", "insert", () => saveMenu(ctx, "header", [toBlog({ label: "Unrecorded" })], 1))).rejects.toThrow();
    expect((await getMenus(ctx)).menus.header).toMatchObject({ version: 1, items: [expect.objectContaining({ label: "Mine" })] });
  });
});

describe("the editor's view of a menu", () => {
  it("says what each link points at and whether the site shows it: live, not published, scheduled, in the trash, deleted", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const live = await published(ctx, "page", "Live page");
    const { entry: draft } = await createEntry(ctx, { type: "page", title: "Draft page" });
    const later = await scheduled(ctx, "Later post");
    const inTrash = await published(ctx, "page", "Binned page");
    const purged = await published(ctx, "page", "Purged page");
    const { term } = await createTerm(ctx, { taxonomy: "category", name: "Bread" });
    const { term: gone } = await createTerm(ctx, { taxonomy: "category", name: "Gone" });
    const items = [toEntry(live.id), toEntry(draft.id), toEntry(later.id), toEntry(inTrash.id), toEntry(purged.id), toTerm(term.id), toTerm(gone.id), toBlog()];
    await saveMenu(ctx, "header", items, 0);
    await binned(ctx, inTrash.id);
    await binned(ctx, purged.id);
    await purgeEntry(ctx, purged.id);
    await deleteTerm(ctx, gone.id);

    const { menus, categories, blogPath } = await getMenus(ctx);
    const state = (key: string) => menus.header.targets[key];
    expect(state(`entry:${live.id}`)).toEqual({ title: "Live page", detail: "Page · /live-page", state: "live" });
    expect(state(`entry:${draft.id}`)).toMatchObject({ title: "Draft page", state: "unpublished" });
    expect(state(`entry:${later.id}`)).toMatchObject({ title: "Later post", state: "scheduled" });
    expect(state(`entry:${inTrash.id}`)).toMatchObject({ state: "trashed" });
    expect(state(`entry:${purged.id}`)).toMatchObject({ state: "deleted" });
    expect(state(`term:${term.id}`)).toEqual({ title: "Bread", detail: "Category · /blog/category/bread", state: "live" });
    expect(state(`term:${gone.id}`)).toMatchObject({ state: "deleted" });
    expect(state("archive:post")).toEqual({ title: "Blog", detail: "All posts · /blog", state: "live" });
    // Nothing was rewritten: every link is still there.
    expect(menus.header.items).toHaveLength(8);
    expect(categories.map((one) => one.name)).toEqual(["Bread"]);
    expect(blogPath).toBe("/blog");
  });
});

describe("what the public site draws", () => {
  it("only live destinations: unpublished, trashed, restored or purged pages leave at once, a republished one comes back with its new title and path; every change flushes the menus", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const about = await published(ctx, "page", "About");
    const team = await published(ctx, "page", "Team");
    await saveMenu(ctx, "header", [toEntry(about.id, { children: [toEntry(team.id), toBlog()] }), toUrl("/contact", "Contact")], 0);
    const full = { header: [{ About: `/s/${address}/about`, under: [{ Team: `/s/${address}/team` }, { Blog: `/s/${address}/blog` }] }, { Contact: `/s/${address}/contact` }], footer: [] };
    expect(await drawn(ctx, address)).toEqual(full);
    expect(applied.tags).toEqual(expect.arrayContaining([tags.config(ctx.site.id), tags.routes(ctx.site.id)]));

    // Unpublished: its link goes, and the links under it take its place.
    const off = await unpublishEntry(ctx, about.id);
    expect(flushesMenus(off.events)).toBe(true);
    expect((await drawn(ctx, address)).header).toEqual([{ Team: `/s/${address}/team` }, { Blog: `/s/${address}/blog` }, { Contact: `/s/${address}/contact` }]);

    // Published again under another title and path: back, as it is now, without the menu being touched.
    const draft = await saveDraft(ctx, about.id, await draftVersion(ctx, about.id), { title: "About the bakery", slug: "the-bakery" });
    const back = await publishEntry(ctx, about.id, draft.version);
    expect(flushesMenus(back.events)).toBe(true);
    expect((await drawn(ctx, address)).header[0]).toEqual({ "About the bakery": `/s/${address}/the-bakery`, under: [{ Team: `/s/${address}/team` }, { Blog: `/s/${address}/blog` }] });

    // A draft's new title is not the site's: the published one stays until it is published.
    await saveDraft(ctx, about.id, await draftVersion(ctx, about.id), { title: "Secret new title" });
    expect(JSON.stringify(await drawn(ctx, address))).not.toContain("Secret");

    // Unpublished and in the trash: gone at once; restored, it is a draft (not on the site); purged, gone for good; the
    // menu still holds both links.
    const offTeam = await unpublishEntry(ctx, team.id);
    expect(flushesMenus(offTeam.events)).toBe(true);
    await trashEntry(ctx, team.id);
    expect(JSON.stringify(await drawn(ctx, address))).not.toContain("Team");
    await restoreEntry(ctx, team.id);
    expect(JSON.stringify(await drawn(ctx, address))).not.toContain("Team");
    await trashEntry(ctx, team.id);
    await purgeEntry(ctx, team.id);
    expect(JSON.stringify(await drawn(ctx, address))).not.toContain("Team");
    expect((await getMenus(ctx)).menus.header.items[0]!.children!.map((one) => one.kind)).toEqual(["entry", "archive"]);
  });

  it("categories and the blog follow their names and paths; a deleted category leaves; never another site's page, a scheduled post, or a damaged link", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const other = await liveSite(a, "Other");
    const theirs = await published(other.ctx, "page", "Their page");
    const later = await scheduled(ctx, "Later");
    const { term } = await createTerm(ctx, { taxonomy: "category", name: "Bread" });
    await saveMenu(ctx, "footer", [toTerm(term.id), toBlog(), toEntry(later.id)], 0);
    // Written behind the app's back: another site's page, a link that does not read as one, a third level.
    await withTenant({ orgId: a.org.id }, (tx) =>
      tx.update(t.menus).set({
        items: [toTerm(term.id), toBlog(), toEntry(later.id), toEntry(theirs.id, { label: "Theirs" }), { kind: "url", url: "javascript:alert(1)", label: "x", id: id() }, toUrl("/a", "A", { children: [toUrl("/b", "B", { children: [toUrl("/c", "C")] })] })],
      }).where(and(eq(t.menus.siteId, ctx.site.id), eq(t.menus.location, "footer"))),
    );
    expect((await drawn(ctx, address)).footer).toEqual([
      { Bread: `/s/${address}/blog/category/bread` },
      { Blog: `/s/${address}/blog` },
      { A: `/s/${address}/a`, under: [{ B: `/s/${address}/b` }] },
    ]);

    const renamed = await updateTerm(ctx, term.id, { name: "Loaves", slug: "loaves" });
    expect(flushesMenus(renamed.events)).toBe(true);
    const settings = await getSiteSettings(ctx);
    const moved = await updateSiteSettings(ctx, "reading", { blogPath: "news", postsPerPage: String(settings.reading.postsPerPage) }, settings.version);
    expect(flushesMenus(moved.events)).toBe(true);
    expect((await drawn(ctx, address)).footer.slice(0, 2)).toEqual([{ Loaves: `/s/${address}/news/category/loaves` }, { Blog: `/s/${address}/news` }]);
    const deleted = await deleteTerm(ctx, term.id);
    expect(flushesMenus(deleted.events)).toBe(true);
    expect((await drawn(ctx, address)).footer[0]).toEqual({ Blog: `/s/${address}/news` });
  });

  it("each site its own menus, read under its own tags; the theme draws them under the site's address", async () => {
    const a = await newTenant();
    const one = await liveSite(a, "One");
    const two = await liveSite(a, "Two");
    await saveMenu(one.ctx, "header", [toUrl("/one", "One")], 0);
    await saveMenu(two.ctx, "header", [toUrl("/two", "Two")], 0);
    applied.tags.length = 0;
    const menus = await loadMenus(a.org.id, one.ctx.site.id, "en", "blog");
    expect(menus.header).toEqual([{ label: "One", path: "/one", newTab: false, children: [] }]);
    expect(applied.tags.every((tag) => !tag.includes(two.ctx.site.id))).toBe(true);
    // Saving the second site's menu flushes none of the first site's tags.
    const saved = await saveMenu(two.ctx, "header", [toUrl("/two", "Two again")], 1);
    expect(tagsForAll(saved.events).immediate.some((tag) => applied.tags.includes(tag))).toBe(false);
    const site = (await loadPublicSite(a.org.id, one.ctx.site.id))!;
    const { context } = themeFor(renderableSite(site, { kind: "address", address: one.address }, await publicMenusFor(site, { kind: "address", address: one.address })));
    expect(context.menus.header).toEqual([{ label: "One", href: `/s/${one.address}/one` }]);
  });
});
