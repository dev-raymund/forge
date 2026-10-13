import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { describe, expect, it, vi } from "vitest";
import { createEntry, createTerm, deleteTerm, listTermsWithUsage, publishEntry, saveDraft, submitCreateTerm, updateTerm } from "@/modules/content";
import { createSite } from "@/modules/sites";
import { inTenant, resolveSiteContext, type SiteContext } from "@/modules/tenancy";
import { tags, tagsForAll, type CacheEvent } from "@/platform/cache";
import * as t from "@/platform/db/schema";
import { whileFailing } from "../fixtures/db-failure";
import { addMember, newSlug, newTenant, refusalOf } from "../fixtures/tenants";

// The renderer's reads are `'use cache'`: outside Next their cache calls do nothing, except that each tag a read applies
// is noted, so the tests can check that the term changes flush what they change (as tests/integration/public-content.test.ts).
const applied = vi.hoisted(() => ({ tags: [] as string[] }));
vi.mock("next/cache", async (original) => ({
  ...(await original<typeof import("next/cache")>()),
  cacheLife: () => {},
  cacheTag: (...names: string[]) => void applied.tags.push(...names),
}));
const { loadEntry, loadPostList, resolveRoute } = await import("@/modules/rendering");

/**
 * M5-8 against real Postgres: categories and tags of one site, made, renamed and deleted by those who may; slugs
 * unique within a taxonomy, typed ones never suffixed; a deleted term taken out of every draft and off every post in
 * one transaction, also against a draft being saved at the same moment; the public reads flushed by each change.
 */

type Tenant = Awaited<ReturnType<typeof newTenant>>;

async function liveSite(tenant: Tenant, name = "Terms") {
  const { site } = await createSite(tenant.ctx, { name, address: newSlug("terms"), language: "en", timezone: "UTC" });
  const ctx = await resolveSiteContext(tenant.actor, tenant.org.slug, site.slug);
  await inTenant(ctx, (tx) => tx.update(t.sites).set({ status: "live" }).where(eq(t.sites.id, site.id)));
  return { site, ctx };
}
const as = async (member: { actor: Tenant["actor"] }, tenant: Tenant, site: { slug: string }) => resolveSiteContext(member.actor, tenant.org.slug, site.slug);
const category = (ctx: SiteContext, name: string, extra: Record<string, unknown> = {}) => createTerm(ctx, { taxonomy: "category", name, ...extra }).then((r) => r.term);
const tag = (ctx: SiteContext, name: string, extra: Record<string, unknown> = {}) => createTerm(ctx, { taxonomy: "tag", name, ...extra }).then((r) => r.term);
const doc = (text: string) => ({ v: 1, doc: { type: "doc", content: [{ type: "paragraph", attrs: { id: uuidv7() }, content: [{ type: "text", text }] }] } });
const versionOf = async (ctx: SiteContext, id: string) =>
  (await inTenant(ctx, (tx) => tx.select({ version: t.entryDrafts.version, termIds: t.entryDrafts.termIds }).from(t.entryDrafts).where(eq(t.entryDrafts.entryId, id))))[0]!;
/** A post with these terms in its draft, published when asked. */
async function post(ctx: SiteContext, title: string, termIds: string[], options: { publish?: boolean } = {}) {
  const { entry } = await createEntry(ctx, { type: "post", title });
  await saveDraft(ctx, entry.id, 1, { content: doc(title), termIds });
  if (options.publish) await publishEntry(ctx, entry.id, 2);
  return entry;
}
const termsOf = async (ctx: SiteContext) =>
  (await inTenant(ctx, (tx) => tx.select({ id: t.terms.id, slug: t.terms.slug, parentId: t.terms.parentId }).from(t.terms).where(eq(t.terms.siteId, ctx.site.id)))).sort((a, b) =>
    a.slug.localeCompare(b.slug),
  );
const linksOf = async (ctx: SiteContext, termId: string) =>
  (await inTenant(ctx, (tx) => tx.select({ entryId: t.entryTerms.entryId }).from(t.entryTerms).where(and(eq(t.entryTerms.siteId, ctx.site.id), eq(t.entryTerms.termId, termId))))).map((row) => row.entryId);
const auditCount = async (ctx: SiteContext, action: string) =>
  (await inTenant(ctx, (tx) => tx.select({ id: t.auditLogs.id }).from(t.auditLogs).where(and(eq(t.auditLogs.organizationId, ctx.org.id), eq(t.auditLogs.action, action))))).length;

describe("creating terms", () => {
  it("a slug from the name, the next free one when taken; a typed slug as typed, or refused; recorded", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    expect(await category(ctx, "Sourdough bread")).toMatchObject({ taxonomy: "category", name: "Sourdough bread", slug: "sourdough-bread", parentId: null });
    expect((await category(ctx, "Sourdough Bread!")).slug).toBe("sourdough-bread-2");
    expect((await tag(ctx, "Sourdough bread")).slug).toBe("sourdough-bread"); // another taxonomy: its own slugs
    expect((await tag(ctx, "Rye", { slug: "dark-rye", description: "Dark loaves" }))).toMatchObject({ slug: "dark-rye", description: "Dark loaves" });
    expect(await refusalOf(() => tag(ctx, "Another", { slug: "dark-rye" }))).toMatchObject({ kind: "Validation", fieldErrors: { slug: ["Another tag of this site already uses this slug. Choose another."] } });
    expect(await auditCount(ctx, "term.created")).toBe(4);
  });

  it("refused: an unknown taxonomy, no name, a bad slug, a parent for a tag, a parent that is a subcategory, a tag as a parent", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const top = await category(ctx, "Bread");
    const sub = await category(ctx, "Rye", { parentId: top.id });
    const aTag = await tag(ctx, "Crusty");
    const before = await termsOf(ctx);
    for (const [input, field] of [
      [{ taxonomy: "section", name: "X" }, "taxonomy"],
      [{ taxonomy: "page", name: "X" }, "taxonomy"],
      [{ taxonomy: "category", name: "   " }, "name"],
      [{ taxonomy: "category", name: "X".repeat(101) }, "name"],
      [{ taxonomy: "category", name: "X", slug: "Not A Slug" }, "slug"],
      [{ taxonomy: "category", name: "X", slug: "x".repeat(101) }, "slug"],
      [{ taxonomy: "tag", name: "X", parentId: top.id }, "parentId"],
      [{ taxonomy: "category", name: "X", parentId: sub.id }, "parentId"],
      [{ taxonomy: "category", name: "X", parentId: aTag.id }, "parentId"],
      [{ taxonomy: "category", name: "X", parentId: uuidv7() }, "parentId"],
    ] as const) {
      const refusal = await refusalOf(() => createTerm(ctx, input as never));
      expect(refusal.kind, JSON.stringify(input)).toBe("Validation");
      expect(Object.keys(refusal.fieldErrors ?? {}), JSON.stringify(input)).toContain(field);
    }
    expect(await termsOf(ctx)).toEqual(before);
    expect(top.parentId).toBeNull();
  });

  it("at the same moment: two of the same name both get a slug; two typing the same slug, one wins and the other is told", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const names = await Promise.all([tag(ctx, "Seasonal"), tag(ctx, "Seasonal"), tag(ctx, "Seasonal")]);
    expect(names.map((term) => term.slug).sort()).toEqual(["seasonal", "seasonal-2", "seasonal-3"]);
    const typed = await Promise.allSettled([tag(ctx, "One", { slug: "same" }), tag(ctx, "Two", { slug: "same" })]);
    expect(typed.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = typed.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ kind: "Validation", fieldErrors: { slug: ["Another tag of this site already uses this slug. Choose another."] } });
  });

  it("who may: categories Owner–Editor; tags also an Author (terms.assign); a Viewer nothing; a direct request too", async () => {
    const a = await newTenant();
    const { site } = await liveSite(a);
    const editor = await as(await addMember(a.org, "editor"), a, site);
    const author = await as(await addMember(a.org, "author"), a, site);
    const viewer = await as(await addMember(a.org, "viewer"), a, site);
    expect((await category(editor, "From an Editor")).slug).toBe("from-an-editor");
    expect((await tag(author, "From an Author")).slug).toBe("from-an-author");
    expect((await refusalOf(() => category(author, "Not for Authors"))).kind).toBe("Forbidden");
    expect((await refusalOf(() => tag(viewer, "Not for Viewers"))).kind).toBe("Forbidden");
    const term = await tag(editor, "Shared");
    for (const ctx of [author, viewer]) {
      expect((await refusalOf(() => updateTerm(ctx, term.id, { name: "Renamed" }))).kind).toBe("Forbidden");
      expect((await refusalOf(() => deleteTerm(ctx, term.id))).kind).toBe("Forbidden");
      expect((await refusalOf(() => listTermsWithUsage(ctx, "tag"))).kind).toBe("Forbidden");
    }
    // Through the form, as the sidebar sends it: the new tag, without re-rendering the editor.
    const viaForm = new FormData();
    viaForm.set("name", "Inline");
    viaForm.set("context", "editor");
    expect(await submitCreateTerm((await addMember(a.org, "author")).actor, a.org.slug, site.slug, "tag", viaForm)).toMatchObject({
      state: { status: "success", values: { name: "Inline", slug: "inline", taxonomy: "tag" } }, refresh: false,
    });
  });
});

describe("renaming and moving terms", () => {
  it("the name, the slug and the description change; a slug of another term is refused; recorded with what changed", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const rye = await tag(ctx, "Rye");
    await tag(ctx, "Wheat");
    expect(await updateTerm(ctx, rye.id, { name: "Dark rye", slug: "dark-rye", description: "Heavy" })).toMatchObject({ changed: true, term: { name: "Dark rye", slug: "dark-rye", description: "Heavy" } });
    expect((await updateTerm(ctx, rye.id, { name: "Dark rye" })).changed).toBe(false);
    expect(await refusalOf(() => updateTerm(ctx, rye.id, { slug: "wheat" }))).toMatchObject({ kind: "Validation", fieldErrors: { slug: ["Another tag of this site already uses this slug. Choose another."] } });
    const [row] = await inTenant(ctx, (tx) => tx.select({ metadata: t.auditLogs.metadata }).from(t.auditLogs).where(and(eq(t.auditLogs.organizationId, a.org.id), eq(t.auditLogs.action, "term.updated"))));
    expect(row!.metadata).toEqual({ taxonomy: "tag", name: "Dark rye", slug: "dark-rye", fields: ["name", "slug", "description"], previousName: "Rye", previousSlug: "rye" });
  });

  it("categories nest one level: a parent must be a top-level category; one with subcategories stays at the top; never itself", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const bread = await category(ctx, "Bread");
    const cakes = await category(ctx, "Cakes");
    const rye = await category(ctx, "Rye", { parentId: bread.id });
    const crusty = await tag(ctx, "Crusty");
    expect((await updateTerm(ctx, cakes.id, { parentId: bread.id })).term.parentId).toBe(bread.id);
    for (const [id, parentId, message] of [
      [bread.id, rye.id, "Choose a top-level category: categories nest one level deep."],
      [bread.id, bread.id, "A category cannot be its own parent."],
      [rye.id, cakes.id, "Choose a top-level category: categories nest one level deep."],
      [crusty.id, bread.id, "Only categories have a parent."],
    ] as const) {
      expect(await refusalOf(() => updateTerm(ctx, id, { parentId })), message).toMatchObject({ kind: "Validation", fieldErrors: { parentId: [message] } });
    }
    const third = await category(ctx, "Pastry");
    expect(await refusalOf(() => updateTerm(ctx, bread.id, { parentId: third.id }))).toMatchObject({
      fieldErrors: { parentId: ["This category has subcategories: it stays at the top level. Move them first."] },
    });
    expect((await updateTerm(ctx, cakes.id, { parentId: null })).term.parentId).toBeNull();
    // Two re-parentings at the same moment cannot stack a second level.
    const [one, two] = [await category(ctx, "One"), await category(ctx, "Two")];
    await Promise.allSettled([updateTerm(ctx, one.id, { parentId: two.id }), updateTerm(ctx, two.id, { parentId: third.id })]);
    const terms = await termsOf(ctx);
    const parentOf = new Map(terms.map((term) => [term.id, term.parentId]));
    for (const term of terms) if (term.parentId) expect(parentOf.get(term.parentId), term.slug).toBeNull();
  });
});

describe("deleting a term", () => {
  it("taken out of every draft and off every published post, its subcategories at the top level, no entry deleted; recorded with the counts", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const bread = await category(ctx, "Bread");
    const rye = await category(ctx, "Rye", { parentId: bread.id });
    const keep = await tag(ctx, "Keep");
    const live = await post(ctx, "Live", [bread.id, keep.id], { publish: true });
    const draft = await post(ctx, "Draft", [bread.id]);
    const other = await post(ctx, "Other", [keep.id]);
    expect((await listTermsWithUsage(ctx, "category")).find((term) => term.id === bread.id)).toMatchObject({ posts: 1, drafts: 2 });

    const result = await deleteTerm(ctx, bread.id);
    expect(result).toMatchObject({ posts: 1, drafts: 2 });
    expect((await versionOf(ctx, live.id)).termIds).toEqual([keep.id]);
    expect((await versionOf(ctx, draft.id)).termIds).toEqual([]);
    expect((await versionOf(ctx, other.id)).termIds).toEqual([keep.id]);
    expect(await linksOf(ctx, bread.id)).toEqual([]);
    expect(await linksOf(ctx, keep.id)).toEqual([live.id]);
    expect((await termsOf(ctx)).find((term) => term.id === rye.id)).toMatchObject({ parentId: null });
    const entries = await inTenant(ctx, (tx) => tx.select({ id: t.entries.id }).from(t.entries).where(and(eq(t.entries.siteId, ctx.site.id), eq(t.entries.type, "post"))));
    expect(entries).toHaveLength(3);
    // The draft still saves and publishes: nothing it names is gone.
    expect((await publishEntry(ctx, draft.id, (await versionOf(ctx, draft.id)).version)).changed).toBe(true);
    const [row] = await inTenant(ctx, (tx) => tx.select({ metadata: t.auditLogs.metadata }).from(t.auditLogs).where(and(eq(t.auditLogs.organizationId, a.org.id), eq(t.auditLogs.action, "term.deleted"))));
    expect(row!.metadata).toEqual({ taxonomy: "category", name: "Bread", slug: "bread", posts: 1, drafts: 2 });
    // A draft version is not moved: an editor open on it keeps saving.
    expect((await saveDraft(ctx, other.id, (await versionOf(ctx, other.id)).version, { title: "Still saving" })).version).toBeGreaterThan(1);
  });

  it("all or nothing: when the audit record cannot be written, the term, its links and every draft are as they were", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const bread = await category(ctx, "Bread");
    const live = await post(ctx, "Live", [bread.id], { publish: true });
    const draft = await post(ctx, "Draft", [bread.id]);
    const failure = await whileFailing("audit_logs", "insert", () => refusalOf(() => deleteTerm(ctx, bread.id)).catch((error) => error));
    expect(failure).toBeTruthy();
    expect((await termsOf(ctx)).map((term) => term.id)).toContain(bread.id);
    expect(await linksOf(ctx, bread.id)).toEqual([live.id]);
    expect((await versionOf(ctx, draft.id)).termIds).toEqual([bread.id]);
    expect((await versionOf(ctx, live.id)).termIds).toEqual([bread.id]);
  });

  it("at the same moment as a save that names it: either the save comes first and the delete cleans it, or the save is refused; never a stale reference", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    for (let round = 0; round < 6; round++) {
      const doomed = await tag(ctx, `Doomed ${round}`);
      const keep = await tag(ctx, `Keep ${round}`);
      const { entry } = await createEntry(ctx, { type: "post", title: `Race ${round}` });
      const [saved, deleted] = await Promise.allSettled([saveDraft(ctx, entry.id, 1, { termIds: [keep.id, doomed.id] }), deleteTerm(ctx, doomed.id)]);
      expect(deleted.status, `round ${round}`).toBe("fulfilled");
      const after = await versionOf(ctx, entry.id);
      expect(after.termIds, `round ${round}`).not.toContain(doomed.id);
      if (saved.status === "fulfilled") expect(after.termIds).toEqual([keep.id]); // saved first, then cleaned
      else expect((saved.reason as { kind: string }).kind).toBe("Validation"); // the term was gone: refused, nothing written
      expect((await termsOf(ctx)).some((term) => term.id === doomed.id)).toBe(false);
    }
  });

  it("at the same moment as a publish of a draft that names it: no error but a refusal, and no stale link", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    for (let round = 0; round < 4; round++) {
      const doomed = await tag(ctx, `Gone ${round}`);
      const entry = await post(ctx, `Publish ${round}`, [doomed.id]);
      const [published, deleted] = await Promise.allSettled([publishEntry(ctx, entry.id, 2), deleteTerm(ctx, doomed.id)]);
      expect(deleted.status, `round ${round}`).toBe("fulfilled");
      if (published.status === "rejected") expect((published.reason as { kind: string }).kind, `round ${round}`).toBe("Validation");
      expect(await linksOf(ctx, doomed.id)).toEqual([]);
      expect((await versionOf(ctx, entry.id)).termIds).toEqual([]);
    }
  });

  it("an editor still sending a deleted term is refused with a message, and saves again once it stops", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const gone = await tag(ctx, "Gone");
    const entry = await post(ctx, "Open", [gone.id]);
    await deleteTerm(ctx, gone.id);
    expect(await refusalOf(() => saveDraft(ctx, entry.id, 2, { termIds: [gone.id] }))).toMatchObject({
      kind: "Validation", fieldErrors: { termIds: ["A category or tag chosen here no longer exists, or is not this site’s. Untick it, or reload the page."] },
    });
    expect((await saveDraft(ctx, entry.id, 2, { termIds: [] })).version).toBe(3);
  });
});

describe("one site's terms are its own", () => {
  it("two sites of one organization: the lists, renaming, deleting, a parent, and assigning never cross; the other site is untouched", async () => {
    const a = await newTenant();
    const one = await liveSite(a, "One");
    const two = await liveSite(a, "Two");
    const theirs = await category(two.ctx, "Theirs");
    const theirTag = await tag(two.ctx, "Their tag");
    const mine = await category(one.ctx, "Mine");
    expect((await listTermsWithUsage(one.ctx, "category")).map((term) => term.name)).toEqual(["Mine"]);
    expect((await refusalOf(() => updateTerm(one.ctx, theirs.id, { name: "Hijacked" }))).kind).toBe("NotFound");
    expect((await refusalOf(() => deleteTerm(one.ctx, theirTag.id))).kind).toBe("NotFound");
    expect((await refusalOf(() => createTerm(one.ctx, { taxonomy: "category", name: "Child", parentId: theirs.id }))).kind).toBe("Validation");
    expect((await refusalOf(() => updateTerm(one.ctx, mine.id, { parentId: theirs.id }))).kind).toBe("Validation");
    const { entry } = await createEntry(one.ctx, { type: "post", title: "Here" });
    expect((await refusalOf(() => saveDraft(one.ctx, entry.id, 1, { termIds: [theirTag.id] }))).kind).toBe("Validation");
    expect((await termsOf(two.ctx)).map((term) => term.slug)).toEqual(["their-tag", "theirs"]);
    // Another organization's terms are not even seen.
    const b = await newTenant();
    const foreign = await liveSite(b, "Foreign");
    expect((await refusalOf(() => deleteTerm(foreign.ctx, mine.id))).kind).toBe("NotFound");
  });
});

describe("the public site follows each term change", () => {
  async function tagsOf(read: () => Promise<unknown>) {
    applied.tags = [];
    await read();
    return new Set(applied.tags);
  }
  const flushes = (events: CacheEvent[], read: Set<string>) => {
    const { immediate, stale } = tagsForAll(events);
    return { immediately: immediate.some((name) => read.has(name)), eventually: [...immediate, ...stale].some((name) => read.has(name)) };
  };

  it("create, rename, re-slug, delete: the archive's address and the posts that show the term at once; the lists stale-while-revalidate; another site never", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    const other = await liveSite(a, "Other");
    const otherRoute = await tagsOf(() => resolveRoute(a.org.id, other.site.id, "en", "blog", ["blog", "category", "bread"]));

    // Before it exists, the archive is cached as "no such page".
    const archive = await tagsOf(() => resolveRoute(a.org.id, site.id, "en", "blog", ["blog", "category", "bread"]));
    const created = await createTerm(ctx, { taxonomy: "category", name: "Bread" });
    expect(flushes(created.events, archive).immediately).toBe(true);
    expect(await resolveRoute(a.org.id, site.id, "en", "blog", ["blog", "category", "bread"])).toMatchObject({ kind: "term-archive", term: { name: "Bread" } });

    const bread = created.term;
    const live = await post(ctx, "Live", [bread.id], { publish: true });
    const page = await tagsOf(() => loadEntry(a.org.id, site.id, live.id));
    const list = await tagsOf(() => loadPostList(a.org.id, site.id, "en", 1, 10, bread.id));
    expect((await loadEntry(a.org.id, site.id, live.id))!.terms).toEqual([{ taxonomy: "category", name: "Bread", slug: "bread", description: "" }]);

    const renamed = await updateTerm(ctx, bread.id, { name: "Loaves", slug: "loaves" });
    for (const read of [archive, page]) expect(flushes(renamed.events, read).immediately).toBe(true);
    expect(flushes(renamed.events, list)).toEqual({ immediately: false, eventually: true });
    expect(await resolveRoute(a.org.id, site.id, "en", "blog", ["blog", "category", "bread"])).toBeNull(); // no redirect: M8-5's
    expect((await loadEntry(a.org.id, site.id, live.id))!.terms).toMatchObject([{ name: "Loaves", slug: "loaves" }]);

    const deleted = await deleteTerm(ctx, bread.id);
    for (const read of [archive, page]) expect(flushes(deleted.events, read).immediately).toBe(true);
    expect(await resolveRoute(a.org.id, site.id, "en", "blog", ["blog", "category", "loaves"])).toBeNull();
    expect((await loadEntry(a.org.id, site.id, live.id))!.terms).toEqual([]);
    expect(await loadPostList(a.org.id, site.id, "en", 1, 10, bread.id)).toEqual({ posts: [], total: 0 });

    // Nothing of another site, by any of these events.
    for (const events of [created.events, renamed.events, deleted.events]) {
      const { immediate, stale } = tagsForAll(events);
      expect([...immediate, ...stale].every((name) => name.includes(site.id)), JSON.stringify(events)).toBe(true);
      expect(flushes(events, otherRoute).eventually).toBe(false);
    }
  });

  it("a term on more posts than the limit flushes the site at once instead of each post", async () => {
    const { tagsFor } = await import("@/platform/cache");
    const siteId = uuidv7();
    const many = Array.from({ length: 201 }, () => uuidv7());
    expect(tagsFor({ type: "term.changed", siteId, entryIds: many }).immediate).toEqual([tags.routes(siteId), tags.site(siteId)]);
    expect(tagsFor({ type: "term.changed", siteId, entryIds: many.slice(0, 2) }).immediate).toEqual([tags.routes(siteId), tags.entry(siteId, many[0]!), tags.entry(siteId, many[1]!)]);
  });

  it("a draft's change of terms does not change the live archive until it is published", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    const rye = await tag(ctx, "Rye");
    const entry = await post(ctx, "Season", [], { publish: true });
    await saveDraft(ctx, entry.id, 2, { termIds: [rye.id] });
    expect((await loadPostList(a.org.id, site.id, "en", 1, 10, rye.id)).total).toBe(0);
    expect((await loadEntry(a.org.id, site.id, entry.id))!.terms).toEqual([]);
    const published = await publishEntry(ctx, entry.id, 3);
    expect((await loadPostList(a.org.id, site.id, "en", 1, 10, rye.id)).posts.map((p) => p.title)).toEqual(["Season"]);
    // The publish's own events flush the post at once and the lists stale-while-revalidate (M5-6, D-27).
    const { immediate, stale } = tagsForAll(published.events);
    expect(immediate).toContain(tags.entry(site.id, entry.id));
    expect(stale).toContain(tags.list(site.id, "post"));
  });
});
