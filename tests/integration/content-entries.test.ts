import { and, asc, eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import {
  createEntry, DRAFT_CHANGED, NEWER_SAVE, parseDocument, publishEntry, saveDraft, setHomepage, submitCreateEntry, submitPublishEntry, submitSaveDraft,
  submitSetHomepage, type StoredDocument,
} from "@/modules/content";
import { createSite, deleteSite, getSiteSettings, updateSiteSettings } from "@/modules/sites";
import { inTenant, resolveSiteContext, type OrgContext, type SiteContext } from "@/modules/tenancy";
import { tagsForAll } from "@/platform/cache";
import * as t from "@/platform/db/schema";
import { withTenant } from "@/platform/db/tenant";
import { dbError } from "../fixtures/db-error";
import { whileFailing } from "../fixtures/db-failure";
import { createMedia, createUser } from "../fixtures/factories";
import { actorOf, addMember, newSlug, newTenant, refusalOf } from "../fixtures/tenants";


const TERMS_REFUSED = "A category or tag chosen here no longer exists, or is not this site’s. Untick it, or reload the page.";
/**
 * M5-3 against real Postgres, as forge_app through PgBouncer: the entry
 * services. Creating an entry and the Home page made with each site; saving a
 * draft; publishing it; changing the home page. Who may, in which site, with
 * which references, and what is left when anything fails.
 */

type Tenant = Awaited<ReturnType<typeof newTenant>>;
type Member = { actor: ReturnType<typeof actorOf>; ctx: OrgContext; user: { id: string } };

async function newSite(tenant: Tenant | Member, name = "Content") {
  const { site } = await createSite(tenant.ctx, { name, address: newSlug("content"), language: "en", timezone: "UTC" });
  return { site, ctx: await resolveSiteContext(tenant.actor, tenant.ctx.org.slug, site.slug) };
}
const as = (member: Member, site: { slug: string }) => resolveSiteContext(member.actor, member.ctx.org.slug, site.slug);

const entryOf = async (ctx: SiteContext, id: string) => (await inTenant(ctx, (tx) => tx.select().from(t.entries).where(eq(t.entries.id, id))))[0];
const draftOf = async (ctx: SiteContext, id: string) => (await inTenant(ctx, (tx) => tx.select().from(t.entryDrafts).where(eq(t.entryDrafts.entryId, id))))[0];
const revisionsOf = (ctx: SiteContext, id: string) =>
  inTenant(ctx, (tx) => tx.select().from(t.entryRevisions).where(eq(t.entryRevisions.entryId, id)).orderBy(asc(t.entryRevisions.number)));
const linkedTerms = async (ctx: SiteContext, id: string) =>
  (await inTenant(ctx, (tx) => tx.select({ termId: t.entryTerms.termId }).from(t.entryTerms).where(eq(t.entryTerms.entryId, id)))).map((row) => row.termId).sort();
const pathsOf = async (ctx: SiteContext) =>
  Object.fromEntries(
    (await inTenant(ctx, (tx) => tx.select({ title: t.entries.title, path: t.entries.path }).from(t.entries).where(and(eq(t.entries.siteId, ctx.site.id), sql`deleted_at is null`)))).map(
      (row) => [row.title, row.path],
    ),
  );
/** The page `site_settings.homepage_entry_id` names (null only where a test removed it). */
const homepageOf = async (ctx: SiteContext): Promise<string> =>
  (await inTenant(ctx, (tx) => tx.select({ id: t.siteSettings.homepageEntryId }).from(t.siteSettings).where(eq(t.siteSettings.siteId, ctx.site.id))))[0]!.id as string;
const eventsOf = async (orgId: string, action: string) =>
  (await withTenant({ orgId }, (tx) => tx.select().from(t.auditLogs).where(and(eq(t.auditLogs.organizationId, orgId), eq(t.auditLogs.action, action))).orderBy(asc(t.auditLogs.id))));
/** Everything about the site's content, as text: any change to any row changes it. */
const contentState = (ctx: SiteContext) =>
  inTenant(ctx, async (tx) => {
    const out: Record<string, string[]> = {};
    for (const table of ["entries", "entry_drafts", "entry_revisions", "terms", "entry_terms", "site_settings"]) {
      out[table] = (
        await tx.execute<{ row: string }>(sql`select row_to_json(x)::text as row from ${sql.identifier(table)} x where site_id = ${ctx.site.id} order by 1`)
      ).rows.map((row) => row.row);
    }
    return out;
  });

const paragraph = (text: string) => ({ type: "paragraph", attrs: { id: uuidv7() }, content: [{ type: "text", text }] });
const doc = (...texts: string[]): StoredDocument => ({ v: 1, doc: { type: "doc", content: texts.map(paragraph) } }) as StoredDocument;
async function term(ctx: SiteContext, taxonomy: "category" | "tag", slug = newSlug(taxonomy)) {
  const [row] = await inTenant(ctx, (tx) => tx.insert(t.terms).values({ organizationId: ctx.org.id, siteId: ctx.site.id, taxonomy, name: slug, slug }).returning());
  return row!;
}
/** Create, save a title (and anything else), publish: a live entry. */
async function live(ctx: SiteContext, input: Parameters<typeof createEntry>[1], draft: Parameters<typeof saveDraft>[3] = {}) {
  const { entry } = await createEntry(ctx, input);
  const { version } = await saveDraft(ctx, entry.id, 1, { title: input.title ?? "", ...draft });
  await publishEntry(ctx, entry.id, version);
  return (await entryOf(ctx, entry.id))!;
}

describe("the Home page, made with every site (criterion 1)", () => {
  it("a draft page at `/`, slug home, by the creator, with draft version 1 and a valid empty document, named by the site's settings", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    const rows = await inTenant(ctx, (tx) => tx.select().from(t.entries).where(eq(t.entries.siteId, site.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "page", path: "/", slug: "home", title: "Home", status: "draft", authorId: a.user.id, createdBy: a.user.id, parentId: null, locale: "en" });
    expect(await homepageOf(ctx)).toBe(rows[0]!.id);
    const draft = (await draftOf(ctx, rows[0]!.id))!;
    expect(draft).toMatchObject({ version: 1, title: "Home", slug: "home", termIds: [] });
    expect(parseDocument(draft.content)).toMatchObject({ ok: true });
    expect(draft.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // The site's own record covers it: creating a site still records one event.
    expect((await eventsOf(a.org.id, "entry.created")).length).toBe(0);
    expect((await eventsOf(a.org.id, "site.created")).length).toBe(1);
  });

  it("if the site's record cannot be written, there is no site and no Home page", async () => {
    const a = await newTenant();
    expect((await dbError(whileFailing("audit_logs", "insert", () => newSite(a)))).message).toMatch(/forced failure/);
    expect(await withTenant({ orgId: a.org.id }, (tx) => tx.execute(sql`select (select count(*)::int from sites) s, (select count(*)::int from entries) e`)).then((r) => r.rows[0])).toEqual({ s: 0, e: 0 });
  });
});

describe("createEntry (criterion 1)", () => {
  it("a page: a slug from the title, a path from the type, draft version 1, recorded; nothing public to flush", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const { entry, events } = await createEntry(ctx, { type: "page", title: "About us" });
    expect(entry).toMatchObject({ type: "page", title: "About us", slug: "about-us", path: "/about-us", status: "draft", authorId: a.user.id, parentId: null });
    expect(events).toEqual([]);
    expect(await draftOf(ctx, entry.id)).toMatchObject({ version: 1, title: "About us", slug: "about-us", template: null });
    expect((await eventsOf(a.org.id, "entry.created")).map((row) => [row.resourceId, row.siteId, row.actorId, row.metadata])).toEqual([
      [entry.id, ctx.site.id, a.user.id, { type: "page", title: "About us", path: "/about-us" }],
    ]);
  });

  it("a post lives under the blog's path, as the reading settings have it", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    expect((await createEntry(ctx, { type: "post", title: "Hello world" })).entry.path).toBe("/blog/hello-world");
    const settings = await getSiteSettings(ctx);
    await updateSiteSettings(ctx, "reading", { blogPath: "news", postsPerPage: "10" }, settings.version);
    expect((await createEntry(ctx, { type: "post", title: "Second" })).entry.path).toBe("/news/second");
  });

  it("a page under a parent; a page under the Home page is at the top level; a template is kept", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const about = (await createEntry(ctx, { type: "page", title: "About" })).entry;
    expect((await createEntry(ctx, { type: "page", title: "Team", parentId: about.id, template: "full-width" })).entry).toMatchObject({ path: "/about/team", parentId: about.id });
    const home = await homepageOf(ctx);
    expect((await createEntry(ctx, { type: "page", title: "Contact", parentId: home })).entry.path).toBe("/contact");
  });

  it("generated slugs: suffixed when taken, never a reserved path, `untitled` without a title, at most 100 characters", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    expect((await createEntry(ctx, { type: "page", title: "About" })).entry.path).toBe("/about");
    expect((await createEntry(ctx, { type: "page", title: "About" })).entry.path).toBe("/about-2");
    expect((await createEntry(ctx, { type: "page", title: "Blog" })).entry.path).toBe("/blog-2");
    expect((await createEntry(ctx, { type: "page", title: "" })).entry).toMatchObject({ slug: "untitled", title: "" });
    expect((await createEntry(ctx, { type: "page", title: "中文标题" })).entry.slug).toBe("untitled-2");
    expect((await createEntry(ctx, { type: "page", title: "x".repeat(200) })).entry.slug).toHaveLength(100);
    expect((await eventsOf(a.org.id, "entry.created")).at(-3)!.metadata).toMatchObject({ title: "Untitled" });
  });

  it("five people creating `Untitled` at once: five entries, five slugs", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const slugs = (await Promise.all(Array.from({ length: 5 }, () => createEntry(ctx, { type: "post", title: "" })))).map((created) => created.entry.slug);
    expect(slugs.sort()).toEqual(["untitled", "untitled-2", "untitled-3", "untitled-4", "untitled-5"]);
  });

  it("the parent must be a page of this site, not in the trash; posts have no parent; pages may have a template, posts not", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const sibling = await newSite(a, "Sibling");
    const b = await newSite(await newTenant());
    const post = (await createEntry(ctx, { type: "post", title: "A post" })).entry;
    const trashed = (await createEntry(ctx, { type: "page", title: "Old" })).entry;
    await inTenant(ctx, (tx) => tx.update(t.entries).set({ deletedAt: new Date() }).where(eq(t.entries.id, trashed.id)));
    const elsewhere = [(await createEntry(sibling.ctx, { type: "page", title: "Theirs" })).entry.id, (await createEntry(b.ctx, { type: "page", title: "Not ours" })).entry.id];
    for (const parentId of [uuidv7(), post.id, trashed.id, ...elsewhere]) {
      expect(await refusalOf(() => createEntry(ctx, { type: "page", title: "Child", parentId })), parentId).toMatchObject({
        kind: "Validation", fieldErrors: { parentId: ["Choose a page of this site."] },
      });
    }
    const home = await homepageOf(ctx);
    expect(await refusalOf(() => createEntry(ctx, { type: "post", title: "x", parentId: home }))).toMatchObject({ kind: "Validation", fieldErrors: { parentId: ["Posts have no parent page."] } });
    expect(await refusalOf(() => createEntry(ctx, { type: "post", title: "x", template: "landing" }))).toMatchObject({ kind: "Validation", fieldErrors: { template: ["Posts have no template."] } });
    for (const type of ["product", "Page", "__proto__", "", "pages"]) {
      expect(await refusalOf(() => createEntry(ctx, { type, title: "x" })), type).toMatchObject({ kind: "Validation", fieldErrors: { type: ["Choose a page or a post."] } });
    }
    // Ids and other fields that are not createEntry's are refused, not read.
    const forged = { type: "page", title: "x", organizationId: b.ctx.org.id, siteId: b.ctx.site.id, path: "/", status: "published" } as Parameters<typeof createEntry>[1];
    expect((await refusalOf(() => createEntry(ctx, forged))).kind).toBe("Validation");
  });

  it("who may: pages Owner–Editor, posts Owner–Author; crediting someone else takes the type's 'any' right, and a member", async () => {
    const a = await newTenant();
    const { site } = await newSite(a);
    const editor = await addMember(a.org, "editor");
    const author = await addMember(a.org, "author");
    const viewer = await addMember(a.org, "viewer");
    const outsider = await newTenant();
    const stranger = await createUser();

    expect((await createEntry(await as(editor, site), { type: "page", title: "By an Editor" })).entry.authorId).toBe(editor.user.id);
    expect((await createEntry(await as(author, site), { type: "post", title: "By an Author" })).entry.authorId).toBe(author.user.id);
    expect((await refusalOf(async () => createEntry(await as(author, site), { type: "page", title: "x" }))).kind).toBe("Forbidden");
    for (const type of ["page", "post"]) expect((await refusalOf(async () => createEntry(await as(viewer, site), { type, title: "x" }))).kind, type).toBe("Forbidden");

    // Crediting: an Editor may credit any member; not someone outside the organization.
    expect((await createEntry(await as(editor, site), { type: "post", title: "For the Author", authorId: author.user.id })).entry.authorId).toBe(author.user.id);
    for (const authorId of [stranger.id, outsider.user.id, uuidv7()]) {
      expect(await refusalOf(async () => createEntry(await as(editor, site), { type: "post", title: "x", authorId })), authorId).toMatchObject({
        kind: "Validation", fieldErrors: { authorId: ["Choose a member of this organization."] },
      });
    }
    // An Author may only be the author: crediting anyone else is refused before anyone is looked up.
    expect((await refusalOf(async () => createEntry(await as(author, site), { type: "post", title: "x", authorId: editor.user.id }))).kind).toBe("Forbidden");
    expect((await createEntry(await as(author, site), { type: "post", title: "Self", authorId: author.user.id })).entry.authorId).toBe(author.user.id);
  });

  it("all or nothing: a record that cannot be written, or a refused commit, leaves no entry and no draft", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const before = await contentState(ctx);
    for (const atCommit of [false, true]) {
      expect((await dbError(whileFailing("audit_logs", "insert", () => createEntry(ctx, { type: "page", title: "Doomed" }), { atCommit }))).message).toMatch(/forced failure/);
      expect(await contentState(ctx)).toEqual(before);
    }
  });
});

describe("saveDraft (criterion 2)", () => {
  it("writes the fields sent, moves the version on, and leaves the live entry alone", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const { entry } = await createEntry(ctx, { type: "page", title: "Draft" });
    const before = await draftOf(ctx, entry.id);
    expect(await saveDraft(ctx, entry.id, 1, { title: "Draft, renamed", content: doc("Hello") })).toEqual({ version: 2 });
    const draft = (await draftOf(ctx, entry.id))!;
    expect(draft).toMatchObject({ version: 2, title: "Draft, renamed", slug: "draft", updatedBy: a.user.id });
    expect(draft.contentHash).not.toBe(before!.contentHash);
    expect(await entryOf(ctx, entry.id)).toMatchObject({ title: "Draft", status: "draft" });
    // Attributes the schema does not know (Tiptap's link target/rel) are not kept.
    const linked = { v: 1, doc: { type: "doc", content: [{ type: "paragraph", attrs: { id: uuidv7() }, content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "/about", target: "_blank", onclick: "x" } }] }] }] } };
    await saveDraft(ctx, entry.id, 2, { content: linked });
    expect(JSON.stringify((await draftOf(ctx, entry.id))!.content)).not.toMatch(/target|onclick/);
  });

  it("a version that is not the draft's is a Conflict, and nothing it sent is written; two saves from one version: one wins", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const { entry } = await createEntry(ctx, { type: "page", title: "Contested" });
    await saveDraft(ctx, entry.id, 1, { title: "First" });
    expect(await refusalOf(() => saveDraft(ctx, entry.id, 1, { title: "Stale" }))).toMatchObject({ kind: "Conflict", message: DRAFT_CHANGED });
    expect(await draftOf(ctx, entry.id)).toMatchObject({ version: 2, title: "First" });
    const results = await Promise.allSettled([saveDraft(ctx, entry.id, 2, { title: "Tab one" }), saveDraft(ctx, entry.id, 2, { title: "Tab two" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { kind: "Conflict" } });
    expect((await draftOf(ctx, entry.id))!.version).toBe(3);
  });

  it("the document: only the allow-list, within 1 MB and 2,000 nodes; anything else is refused and nothing is written", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const { entry } = await createEntry(ctx, { type: "page", title: "Doc" });
    const id = () => uuidv7();
    const bad: [string, unknown][] = [
      ["an unknown node", { v: 1, doc: { type: "doc", content: [{ type: "html", attrs: { id: id(), html: "<script>alert(1)</script>" } }] } }],
      ["a javascript: link", { v: 1, doc: { type: "doc", content: [{ type: "paragraph", attrs: { id: id() }, content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }] } }],
      ["a heading level 1", { v: 1, doc: { type: "doc", content: [{ type: "heading", attrs: { id: id(), level: 1 }, content: [{ type: "text", text: "x" }] }] } }],
      ["two nodes with one id", { v: 1, doc: { type: "doc", content: [{ type: "paragraph", attrs: { id: "01920000-0000-7000-8000-000000000001" } }, { type: "paragraph", attrs: { id: "01920000-0000-7000-8000-000000000001" } }] } }],
      ["columns inside columns", { v: 1, doc: { type: "doc", content: [{ type: "columns", attrs: { id: id(), v: 1, count: 2 }, content: [
        { type: "column", attrs: { id: id() }, content: [{ type: "columns", attrs: { id: id(), v: 1, count: 2 }, content: [] }] },
        { type: "column", attrs: { id: id() }, content: [paragraph("x")] },
      ] }] } }],
      ["too many nodes", { v: 1, doc: { type: "doc", content: Array.from({ length: 1_001 }, () => paragraph("x")) } }],
      ["more than 1 MB", { v: 1, doc: { type: "doc", content: [paragraph("x".repeat(99_000)), ...Array.from({ length: 11 }, () => paragraph("y".repeat(99_000)))] } }],
      ["not a document", "<p>hello</p>"],
      ["an older format", { v: 0, doc: { type: "doc", content: [paragraph("x")] } }],
    ];
    const before = await draftOf(ctx, entry.id);
    for (const [what, content] of bad) {
      const refused = await refusalOf(() => saveDraft(ctx, entry.id, 1, { content }));
      expect(refused.kind, what).toBe("Validation");
      expect(Object.keys(refused.fieldErrors ?? {}), what).toEqual(["content"]);
    }
    expect(await draftOf(ctx, entry.id)).toEqual(before);
  });

  it("a slug someone typed is used as typed or refused, never suffixed; the Home page may have any slug, it stays at `/`", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    await createEntry(ctx, { type: "page", title: "Taken" });
    const { entry } = await createEntry(ctx, { type: "page", title: "Mine" });
    for (const [slug, message] of [
      ["Not A Slug", "Use lowercase letters, numbers and single hyphens, like about-us."],
      ["a--b", "Use lowercase letters, numbers and single hyphens, like about-us."],
      ["x".repeat(101), "Use at most 100 characters."],
      ["", "Enter a slug."],
      ["blog", "That address belongs to the blog (/blog)."],
    ] as const) {
      expect(await refusalOf(() => saveDraft(ctx, entry.id, 1, { slug })), slug).toMatchObject({ kind: "Validation", fieldErrors: { slug: [message] } });
    }
    // Taken by another page: saved as typed. Publishing it is what is refused (below).
    expect(await saveDraft(ctx, entry.id, 1, { slug: "taken" })).toEqual({ version: 2 });
    expect((await draftOf(ctx, entry.id))!.slug).toBe("taken");
    const home = await homepageOf(ctx);
    await saveDraft(ctx, home, 1, { slug: "blog" });
    expect((await draftOf(ctx, home))!.slug).toBe("blog");
  });

  it("what the type has: pages no excerpt, image or terms; posts no template; no extra fields; nothing else can be changed through the draft", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const page = (await createEntry(ctx, { type: "page", title: "Page" })).entry;
    const post = (await createEntry(ctx, { type: "post", title: "Post" })).entry;
    const { media } = await createMedia({ orgId: ctx.org.id, siteId: ctx.site.id, userId: a.user.id });
    const tag = await term(ctx, "tag");
    for (const [draft, field] of [
      [{ excerpt: "Short" }, "excerpt"], [{ featuredMediaId: media.id }, "featuredMediaId"], [{ termIds: [tag.id] }, "termIds"],
    ] as [Parameters<typeof saveDraft>[3], string][]) {
      expect(await refusalOf(() => saveDraft(ctx, page.id, 1, draft)), field).toMatchObject({ kind: "Validation", fieldErrors: { [field]: [expect.stringMatching(/^Pages have no/)] } });
    }
    expect(await refusalOf(() => saveDraft(ctx, post.id, 1, { template: "landing" }))).toMatchObject({ kind: "Validation", fieldErrors: { template: ["Posts have no template."] } });
    expect(await refusalOf(() => saveDraft(ctx, post.id, 1, { fields: { price: 1 } }))).toMatchObject({ kind: "Validation", fieldErrors: { fields: ["Posts have no such fields."] } });
    for (const key of ["path", "status", "authorId", "parentId", "version", "organizationId", "seo"]) {
      expect((await refusalOf(() => saveDraft(ctx, post.id, 1, { [key]: "x" } as never))).kind, key).toBe("Validation");
    }
    expect(await saveDraft(ctx, post.id, 1, { excerpt: "Short", featuredMediaId: media.id, termIds: [tag.id] })).toEqual({ version: 2 });
  });

  it("terms: each one of this site, of a taxonomy the type uses; another site's, another organization's or a missing one is refused", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const sibling = await newSite(a, "Sibling");
    const other = await newSite(await newTenant());
    const post = (await createEntry(ctx, { type: "post", title: "Post" })).entry;
    const [category, tag] = [await term(ctx, "category"), await term(ctx, "tag")];
    const strangers = [(await term(sibling.ctx, "tag")).id, (await term(other.ctx, "tag")).id, uuidv7()];
    for (const id of strangers) {
      expect(await refusalOf(() => saveDraft(ctx, post.id, 1, { termIds: [category.id, id] })), id).toMatchObject({
        kind: "Validation", fieldErrors: { termIds: [TERMS_REFUSED] },
      });
    }
    expect((await refusalOf(() => saveDraft(ctx, post.id, 1, { termIds: [tag.id, tag.id] }))).fieldErrors).toEqual({ termIds: ["A term is listed twice."] });
    expect(await saveDraft(ctx, post.id, 1, { termIds: [category.id, tag.id] })).toEqual({ version: 2 });
    expect((await draftOf(ctx, post.id))!.termIds.sort()).toEqual([category.id, tag.id].sort());
    // Saving terms is not publishing them.
    expect(await linkedTerms(ctx, post.id)).toEqual([]);
  });

  it("a featured image must be one of this site's: the database's composite key refuses the rest", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const sibling = await newSite(a, "Sibling");
    const post = (await createEntry(ctx, { type: "post", title: "Post" })).entry;
    const theirs = await createMedia({ orgId: ctx.org.id, siteId: sibling.ctx.site.id, userId: a.user.id });
    for (const featuredMediaId of [theirs.media.id, uuidv7()]) {
      expect(await refusalOf(() => saveDraft(ctx, post.id, 1, { featuredMediaId })), featuredMediaId).toMatchObject({
        kind: "Validation", fieldErrors: { featuredMediaId: ["Choose an image of this site."] },
      });
    }
  });

  it("who may: pages Owner–Editor; posts their Author, or Owner–Editor for anyone's; terms take terms.assign; Viewers nothing", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    const editor = await addMember(a.org, "editor");
    const author = await addMember(a.org, "author");
    const otherAuthor = await addMember(a.org, "author");
    const viewer = await addMember(a.org, "viewer");
    const page = (await createEntry(ctx, { type: "page", title: "Page" })).entry;
    const own = (await createEntry(await as(author, site), { type: "post", title: "Own" })).entry;
    const tag = await term(ctx, "tag");

    expect(await saveDraft(await as(author, site), own.id, 1, { title: "Own, edited", termIds: [tag.id] })).toEqual({ version: 2 });
    expect((await refusalOf(async () => saveDraft(await as(otherAuthor, site), own.id, 2, { title: "Not mine" }))).kind).toBe("Forbidden");
    expect((await refusalOf(async () => saveDraft(await as(author, site), page.id, 1, { title: "x" }))).kind).toBe("Forbidden");
    expect(await saveDraft(await as(editor, site), own.id, 2, { title: "Edited by an Editor" })).toEqual({ version: 3 });
    expect(await saveDraft(await as(editor, site), page.id, 1, { title: "Page, edited" })).toEqual({ version: 2 });
    for (const draft of [{ title: "x" }, { termIds: [tag.id] }]) {
      expect((await refusalOf(async () => saveDraft(await as(viewer, site), own.id, 3, draft))).kind).toBe("Forbidden");
    }
    expect(await draftOf(ctx, own.id)).toMatchObject({ version: 3, title: "Edited by an Editor" });
  });

  it("an entry of another site, even of the same organization, or of another organization, or in the trash, is not found", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const sibling = await newSite(a, "Sibling");
    const other = await newSite(await newTenant());
    const trashed = (await createEntry(ctx, { type: "page", title: "Trashed" })).entry;
    await inTenant(ctx, (tx) => tx.update(t.entries).set({ deletedAt: new Date() }).where(eq(t.entries.id, trashed.id)));
    const theirs = [(await createEntry(sibling.ctx, { type: "page", title: "Sibling's" })).entry, (await createEntry(other.ctx, { type: "page", title: "Other's" })).entry];
    const before = [await contentState(sibling.ctx), await contentState(other.ctx)];
    for (const entry of [trashed, ...theirs]) {
      expect((await refusalOf(() => saveDraft(ctx, entry.id, 1, { title: "Hijacked" }))).kind, entry.title).toBe("NotFound");
      expect((await refusalOf(() => publishEntry(ctx, entry.id, 1))).kind, entry.title).toBe("NotFound");
      expect((await refusalOf(() => setHomepage(ctx, entry.id))).kind, entry.title).toBe("NotFound");
    }
    expect([await contentState(sibling.ctx), await contentState(other.ctx)]).toEqual(before);
  });
});

describe("publishEntry (criterion 3)", () => {
  it("first publish: the revision, then the projection pointing at it, the terms, the record and the events", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const [category, tag] = [await term(ctx, "category"), await term(ctx, "tag")];
    const { entry } = await createEntry(ctx, { type: "post", title: "Hello" });
    const { version } = await saveDraft(ctx, entry.id, 1, { title: "Hello, world", slug: "hello-world", excerpt: "Hi", content: doc("Body"), termIds: [category.id, tag.id] });
    const published = await publishEntry(ctx, entry.id, version);

    expect(published).toMatchObject({ changed: true, revision: 1, entry: { status: "published", path: "/blog/hello-world", title: "Hello, world" } });
    const [revision] = await revisionsOf(ctx, entry.id);
    expect(revision).toMatchObject({ number: 1, kind: "publish", title: "Hello, world", slug: "hello-world", excerpt: "Hi", sourceDraftVersion: version, createdBy: a.user.id });
    expect(revision!.termIds.sort()).toEqual([category.id, tag.id].sort());
    expect(revision!.contentHash).toBe((await draftOf(ctx, entry.id))!.contentHash);
    const row = (await entryOf(ctx, entry.id))!;
    expect(row).toMatchObject({ status: "published", publishedRevisionId: revision!.id, title: "Hello, world", slug: "hello-world", path: "/blog/hello-world", excerpt: "Hi" });
    expect(row.publishedAt).toBeInstanceOf(Date);
    expect(row.firstPublishedAt).toEqual(row.publishedAt);
    // The revision exists before the entry names it: the table's CHECK and composite key would refuse the other order.
    expect(await linkedTerms(ctx, entry.id)).toEqual([category.id, tag.id].sort());
    expect((await eventsOf(a.org.id, "entry.published")).map((e) => e.metadata)).toEqual([{ type: "post", title: "Hello, world", path: "/blog/hello-world", revision: 1 }]);
    expect(published.events).toEqual([{ type: "entry.published", siteId: ctx.site.id, entryId: entry.id, contentType: "post", pathChanged: false }]);
    expect(tagsForAll(published.events).immediate).toEqual([`site:${ctx.site.id}:entry:${entry.id}`, `site:${ctx.site.id}:routes`]);
  });

  it("publishing again: the next revision number, the same date, the new terms; nothing of the first revision changes", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const [one, two] = [await term(ctx, "tag"), await term(ctx, "tag")];
    const first = await live(ctx, { type: "post", title: "Post" }, { termIds: [one.id] });
    const [r1] = await revisionsOf(ctx, first.id);
    const { version } = await saveDraft(ctx, first.id, 2, { title: "Post, revised", termIds: [two.id] });
    expect((await publishEntry(ctx, first.id, version)).revision).toBe(2);
    const revisions = await revisionsOf(ctx, first.id);
    expect(revisions.map((r) => [r.number, r.kind, r.title, r.sourceDraftVersion])).toEqual([[1, "publish", "Post", 2], [2, "publish", "Post, revised", 3]]);
    expect(revisions[0]).toEqual(r1);
    const row = (await entryOf(ctx, first.id))!;
    expect(row).toMatchObject({ publishedRevisionId: revisions[1]!.id, title: "Post, revised", publishedAt: first.publishedAt, firstPublishedAt: first.firstPublishedAt });
    expect(await linkedTerms(ctx, first.id)).toEqual([two.id]);
  });

  it("idempotent: the same draft version published again (a retry, a double click, after a later save) writes and records nothing", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const entry = await live(ctx, { type: "page", title: "Once" });
    const before = await contentState(ctx);
    for (let i = 0; i < 2; i++) expect(await publishEntry(ctx, entry.id, 2)).toMatchObject({ changed: false, revision: 1, events: [] });
    expect(await contentState(ctx)).toEqual(before);
    await saveDraft(ctx, entry.id, 2, { title: "Later" });
    expect(await publishEntry(ctx, entry.id, 2)).toMatchObject({ changed: false, revision: 1 });
    expect((await eventsOf(a.org.id, "entry.published")).length).toBe(1);
  });

  it("a newer save than the one asked to publish is a Conflict, and nothing is published", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const { entry } = await createEntry(ctx, { type: "page", title: "Racing" });
    await saveDraft(ctx, entry.id, 1, { title: "Newer" });
    const before = await contentState(ctx);
    expect(await refusalOf(() => publishEntry(ctx, entry.id, 1))).toMatchObject({ kind: "Conflict", message: NEWER_SAVE });
    expect(await contentState(ctx)).toEqual(before);
  });

  it("publishes of one entry at once are serialised: one revision, one record, every caller told it is published", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const { entry } = await createEntry(ctx, { type: "post", title: "Busy" });
    const results = await Promise.all(Array.from({ length: 5 }, () => publishEntry(ctx, entry.id, 1)));
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(results.every((r) => r.revision === 1)).toBe(true);
    expect(await revisionsOf(ctx, entry.id)).toHaveLength(1);
    expect((await eventsOf(a.org.id, "entry.published")).length).toBe(1);
  });

  it("a slug change moves the page and every page below it; live ones are flushed at their new addresses", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const about = await live(ctx, { type: "page", title: "About" });
    const team = await live(ctx, { type: "page", title: "Team", parentId: about.id });
    await createEntry(ctx, { type: "page", title: "People", parentId: team.id }); // a draft: moved, but nothing to flush
    const { version } = await saveDraft(ctx, about.id, 2, { slug: "company" });
    const published = await publishEntry(ctx, about.id, version);
    expect(await pathsOf(ctx)).toMatchObject({ About: "/company", Team: "/company/team", People: "/company/team/people" });
    expect(published.moved.map((page) => [page.title, page.from, page.to])).toEqual([["Team", "/about/team", "/company/team"], ["People", "/about/team/people", "/company/team/people"]]);
    expect(published.events).toEqual([
      { type: "entry.published", siteId: ctx.site.id, entryId: about.id, contentType: "page", pathChanged: true },
      { type: "entry.moved", siteId: ctx.site.id, entryId: team.id, contentType: "page" },
    ]);
  });

  it("an address another entry holds: a Conflict naming it, and nothing is published or moved", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    await createEntry(ctx, { type: "page", title: "Taken" });
    const about = await live(ctx, { type: "page", title: "About" });
    await createEntry(ctx, { type: "page", title: "Team", parentId: about.id });
    const mine = (await createEntry(ctx, { type: "page", title: "Mine" })).entry;
    const { version } = await saveDraft(ctx, mine.id, 1, { slug: "taken" });
    let before = await contentState(ctx);
    expect(await refusalOf(() => publishEntry(ctx, mine.id, version))).toMatchObject({ kind: "Conflict", message: expect.stringContaining("/taken") });
    expect(await contentState(ctx)).toEqual(before);

    // A page below that would land on a taken address refuses the whole publish too. Here /x is free (its page is in the
    // trash), but the page that was below it, /x/team, is not: About's own Team cannot move there.
    const x = (await createEntry(ctx, { type: "page", title: "X" })).entry;
    await createEntry(ctx, { type: "page", title: "Team", parentId: x.id });
    await inTenant(ctx, (tx) => tx.update(t.entries).set({ deletedAt: new Date() }).where(eq(t.entries.id, x.id)));
    const { version: v } = await saveDraft(ctx, about.id, 2, { slug: "x" });
    before = await contentState(ctx);
    expect(await refusalOf(() => publishEntry(ctx, about.id, v))).toMatchObject({ kind: "Conflict", message: expect.stringContaining("/x/team") });
    expect(await contentState(ctx)).toEqual(before);
  });

  it("what is published is checked again: terms of another site, a broken document, a loop or a trashed page above, put there behind the app's back", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const sibling = await newSite(a, "Sibling");
    const post = (await createEntry(ctx, { type: "post", title: "Post" })).entry;
    const foreignTerm = await term(sibling.ctx, "tag");
    await inTenant(ctx, (tx) => tx.update(t.entryDrafts).set({ termIds: [foreignTerm.id] }).where(eq(t.entryDrafts.entryId, post.id)));
    expect((await refusalOf(() => publishEntry(ctx, post.id, 1))).fieldErrors).toEqual({ termIds: [TERMS_REFUSED] });

    const page = (await createEntry(ctx, { type: "page", title: "Broken" })).entry;
    await inTenant(ctx, (tx) => tx.update(t.entryDrafts).set({ content: { v: 1, doc: { type: "doc", content: [{ type: "script" }] } } }).where(eq(t.entryDrafts.entryId, page.id)));
    expect((await refusalOf(() => publishEntry(ctx, page.id, 1))).fieldErrors).toEqual({ content: ["This content contains something Forge cannot save."] });

    const parent = (await createEntry(ctx, { type: "page", title: "Parent" })).entry;
    const child = (await createEntry(ctx, { type: "page", title: "Child", parentId: parent.id })).entry;
    await inTenant(ctx, (tx) => tx.update(t.entries).set({ parentId: child.id }).where(eq(t.entries.id, parent.id)));
    expect((await refusalOf(() => publishEntry(ctx, child.id, 1))).fieldErrors).toEqual({ parentId: ["The pages above this one form a loop. Choose another parent."] });

    const orphanParent = (await createEntry(ctx, { type: "page", title: "Gone" })).entry;
    const orphan = (await createEntry(ctx, { type: "page", title: "Orphan", parentId: orphanParent.id })).entry;
    await inTenant(ctx, (tx) => tx.update(t.entries).set({ deletedAt: new Date() }).where(eq(t.entries.id, orphanParent.id)));
    expect((await refusalOf(() => publishEntry(ctx, orphan.id, 1))).fieldErrors).toEqual({ parentId: ["A page above this one is in the trash or is not a page. Choose another parent."] });

    for (const id of [post.id, page.id, child.id, orphan.id]) expect((await entryOf(ctx, id))!.status, id).toBe("draft");
    expect(await inTenant(ctx, (tx) => tx.select().from(t.entryRevisions).where(eq(t.entryRevisions.siteId, ctx.site.id)))).toEqual([]);
  });

  it("the Home page stays at `/` whatever its slug", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const home = await homepageOf(ctx);
    const { version } = await saveDraft(ctx, home, 1, { slug: "welcome", title: "Welcome", content: doc("Hi") });
    expect((await publishEntry(ctx, home, version)).entry).toMatchObject({ path: "/", slug: "welcome", status: "published" });
  });

  it("all or nothing: a record that cannot be written, or a refused commit, leaves no revision, no terms and an unpublished entry", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const tag = await term(ctx, "tag");
    const { entry } = await createEntry(ctx, { type: "post", title: "Fragile" });
    await saveDraft(ctx, entry.id, 1, { termIds: [tag.id] });
    const before = await contentState(ctx);
    for (const atCommit of [false, true]) {
      expect((await dbError(whileFailing("audit_logs", "insert", () => publishEntry(ctx, entry.id, 2), { atCommit }))).message).toMatch(/forced failure/);
      expect(await contentState(ctx)).toEqual(before);
    }
    // And the projection's own write failing: the revision written before it goes too.
    expect((await dbError(whileFailing("entry_terms", "insert", () => publishEntry(ctx, entry.id, 2)))).message).toMatch(/forced failure/);
    expect(await contentState(ctx)).toEqual(before);
  });

  it("who may: pages Owner–Editor; posts their Author or Owner–Editor; Viewers never", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    const editor = await addMember(a.org, "editor");
    const author = await addMember(a.org, "author");
    const otherAuthor = await addMember(a.org, "author");
    const viewer = await addMember(a.org, "viewer");
    const page = (await createEntry(ctx, { type: "page", title: "Page" })).entry;
    const own = (await createEntry(await as(author, site), { type: "post", title: "Own" })).entry;
    for (const [who, id] of [[viewer, page.id], [viewer, own.id], [author, page.id], [otherAuthor, own.id]] as const) {
      expect((await refusalOf(async () => publishEntry(await as(who, site), id, 1))).kind).toBe("Forbidden");
    }
    expect((await revisionsOf(ctx, own.id)).length).toBe(0);
    expect((await publishEntry(await as(author, site), own.id, 1)).changed).toBe(true);
    expect((await publishEntry(await as(editor, site), page.id, 1)).changed).toBe(true);
  });
});

describe("setHomepage", () => {
  /** A site whose Home has a page below it, and a Welcome page with one below it; both trees published. */
  async function siteWithTwoTrees(tenant: Tenant) {
    const { ctx } = await newSite(tenant);
    const home = await homepageOf(ctx);
    await publishEntry(ctx, home, 1);
    const contact = await live(ctx, { type: "page", title: "Contact", parentId: home });
    const welcome = await live(ctx, { type: "page", title: "Welcome" });
    const team = await live(ctx, { type: "page", title: "Team", parentId: welcome.id });
    return { ctx, home, contact, welcome, team };
  }

  it("the old Home leaves `/` for an ordinary path, the new one takes it, and the pages below each follow; the setting and the record say so", async () => {
    const a = await newTenant();
    const { ctx, home, contact, welcome, team } = await siteWithTwoTrees(a);
    expect(await pathsOf(ctx)).toEqual({ Home: "/", Contact: "/contact", Welcome: "/welcome", Team: "/welcome/team" });

    const result = await setHomepage(ctx, welcome.id);
    expect(await pathsOf(ctx)).toEqual({ Home: "/home", Contact: "/home/contact", Welcome: "/", Team: "/team" });
    expect(await homepageOf(ctx)).toBe(welcome.id);
    // The tree is unchanged: every page keeps its parent.
    expect((await entryOf(ctx, contact.id))!.parentId).toBe(home);
    expect((await entryOf(ctx, team.id))!.parentId).toBe(welcome.id);
    expect(result.changed).toBe(true);
    expect(result.moved.map((page) => [page.title, page.from, page.to]).sort()).toEqual(
      [["Contact", "/contact", "/home/contact"], ["Home", "/", "/home"], ["Team", "/welcome/team", "/team"], ["Welcome", "/welcome", "/"]].sort(),
    );
    expect(result.events[0]).toEqual({ type: "site.configChanged", siteId: ctx.site.id });
    expect(result.events.slice(1).map((event) => (event as { entryId: string }).entryId).sort()).toEqual([home, contact.id, welcome.id, team.id].sort());
    expect((await eventsOf(a.org.id, "site.homepage_changed")).map((e) => [e.resourceType, e.resourceId, e.metadata])).toEqual([
      ["site", ctx.site.id, { name: "Content", title: "Welcome", previousTitle: "Home" }],
    ]);
    // And back: the first Home returns to `/` and its page to the top level.
    await setHomepage(ctx, home);
    expect(await pathsOf(ctx)).toEqual({ Home: "/", Contact: "/contact", Welcome: "/welcome", Team: "/welcome/team" });
  });

  it("the page that already is the Home page: nothing changes and nothing is recorded", async () => {
    const a = await newTenant();
    const { ctx, home } = await siteWithTwoTrees(a);
    const before = await contentState(ctx);
    expect(await setHomepage(ctx, home)).toEqual({ changed: false, moved: [], events: [] });
    expect(await contentState(ctx)).toEqual(before);
    expect(await eventsOf(a.org.id, "site.homepage_changed")).toEqual([]);
  });

  it("when the old Home's address is held (by the new Home itself), it takes the next one, draft included", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const home = await homepageOf(ctx);
    const other = (await createEntry(ctx, { type: "page", title: "Home" })).entry;
    expect(other.path).toBe("/home");
    await setHomepage(ctx, other.id);
    expect((await entryOf(ctx, home))!).toMatchObject({ path: "/home-2", slug: "home-2" });
    expect((await draftOf(ctx, home))!.slug).toBe("home-2");
    expect((await entryOf(ctx, other.id))!.path).toBe("/");
  });

  it("a page below the new Home that would land on a taken address refuses the whole change: nothing moves", async () => {
    const a = await newTenant();
    const { ctx, welcome } = await siteWithTwoTrees(a);
    expect((await createEntry(ctx, { type: "page", title: "Team" })).entry.path).toBe("/team"); // where Welcome's Team would go
    const before = await contentState(ctx);
    expect(await refusalOf(() => setHomepage(ctx, welcome.id))).toMatchObject({ kind: "Conflict", message: expect.stringContaining("/team") });
    expect(await contentState(ctx)).toEqual(before);
    expect(await eventsOf(a.org.id, "site.homepage_changed")).toEqual([]);
  });

  it("only a page of this site, not in the trash; a site without a Home page gets one", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const post = (await createEntry(ctx, { type: "post", title: "Post" })).entry;
    expect(await refusalOf(() => setHomepage(ctx, post.id))).toMatchObject({ kind: "Validation", fieldErrors: { entryId: ["Only a page can be the home page."] } });
    // A site made before M5-3 had no Home page: the page simply takes `/`.
    await inTenant(ctx, (tx) => tx.delete(t.entries).where(and(eq(t.entries.siteId, ctx.site.id), eq(t.entries.path, "/"))));
    expect(await homepageOf(ctx)).toBeNull();
    const page = (await createEntry(ctx, { type: "page", title: "First" })).entry;
    expect((await setHomepage(ctx, page.id)).changed).toBe(true);
    expect(await pathsOf(ctx)).toMatchObject({ First: "/" });
    expect(await homepageOf(ctx)).toBe(page.id);
    expect((await eventsOf(a.org.id, "site.homepage_changed")).at(-1)!.metadata).toEqual({ name: "Content", title: "First" });
  });

  it("who may: site.settings.manage (Owner, Admin); Editors and the rest are refused", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    const page = (await createEntry(ctx, { type: "page", title: "Page" })).entry;
    for (const role of ["editor", "author", "viewer"] as const) {
      const member = await addMember(a.org, role);
      expect((await refusalOf(async () => setHomepage(await as(member, site), page.id))).kind, role).toBe("Forbidden");
    }
    const admin = await addMember(a.org, "admin");
    expect((await setHomepage(await as(admin, site), page.id)).changed).toBe(true);
  });

  it("two changes at once take turns: one page at `/`, the setting naming it, no address held twice", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const pages = await Promise.all(["One", "Two", "Three"].map((title) => createEntry(ctx, { type: "page", title }).then((created) => created.entry)));
    await Promise.all(pages.map((page) => setHomepage(ctx, page.id)));
    const rows = await inTenant(ctx, (tx) => tx.select().from(t.entries).where(and(eq(t.entries.siteId, ctx.site.id), sql`deleted_at is null`)));
    const atRoot = rows.filter((row) => row.path === "/");
    expect(atRoot).toHaveLength(1);
    expect(await homepageOf(ctx)).toBe(atRoot[0]!.id);
    expect(new Set(rows.map((row) => row.path)).size).toBe(rows.length);
    expect((await eventsOf(a.org.id, "site.homepage_changed")).length).toBe(3);
  });

  it("all or nothing: a record that cannot be written leaves every path and the setting as they were", async () => {
    const a = await newTenant();
    const { ctx, welcome } = await siteWithTwoTrees(a);
    const before = await contentState(ctx);
    expect((await dbError(whileFailing("audit_logs", "insert", () => setHomepage(ctx, welcome.id)))).message).toMatch(/forced failure/);
    expect(await contentState(ctx)).toEqual(before);
  });
});

describe("the forms behind the Server Actions (criterion 4)", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.set(name, value);
    return data;
  };

  it("create, save, publish and set the homepage; the entry is the URL's site's, whatever else the form says", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    const b = await newSite(await newTenant());
    const theirs = await contentState(b.ctx);
    const created = await submitCreateEntry(a.actor, a.org.slug, site.slug, "page", form({ title: "From a form", organizationId: b.ctx.org.id, siteId: b.ctx.site.id, status: "published", path: "/" }));
    expect(created).toMatchObject({ state: { status: "success", message: "Page created.", values: { title: "From a form", path: "/from-a-form" } }, invalidate: [] });
    const entryId = created.state.values!.entryId!;
    expect((await entryOf(ctx, entryId))!).toMatchObject({ siteId: site.id, status: "draft", path: "/from-a-form" });

    const saved = await submitSaveDraft(a.actor, a.org.slug, site.slug, entryId, form({ version: "1", draft: JSON.stringify({ title: "Saved", content: doc("Text") }) }));
    expect(saved.state).toEqual({ status: "success", values: { version: "2" } });

    const published = await submitPublishEntry(a.actor, a.org.slug, site.slug, entryId, form({ version: "2" }));
    expect(published).toMatchObject({ state: { status: "success", message: "Published.", values: { path: "/from-a-form", revision: "1" } }, invalidate: [{ type: "entry.published", entryId }] });
    expect((await submitPublishEntry(a.actor, a.org.slug, site.slug, entryId, form({ version: "2" }))).state.message).toBe("Already published.");

    const home = await submitSetHomepage(a.actor, a.org.slug, site.slug, entryId, form({}));
    expect(home).toMatchObject({ state: { status: "success", message: "This page is now the home page." }, invalidate: expect.arrayContaining([{ type: "site.configChanged", siteId: site.id }]) });
    expect(await contentState(b.ctx)).toEqual(theirs);
  });

  it("refusals: a malformed or oversized draft, a version that is not a number, an entry id that is not an id", async () => {
    const a = await newTenant();
    const { site, ctx } = await newSite(a);
    const { entry } = await createEntry(ctx, { type: "page", title: "Form" });
    expect(await submitSaveDraft(a.actor, a.org.slug, site.slug, entry.id, form({ version: "1", draft: "{not json" }))).toMatchObject({ refused: "Validation" });
    expect(await submitSaveDraft(a.actor, a.org.slug, site.slug, entry.id, form({ version: "1", draft: JSON.stringify({ title: "x".repeat(1_300_000) }) }))).toMatchObject({
      refused: "Validation", state: { fieldErrors: { content: ["This content is too large to save (the limit is 1 MB)."] } },
    });
    for (const version of ["", "two", "1.5", "0", "-1"]) {
      expect(await submitPublishEntry(a.actor, a.org.slug, site.slug, entry.id, form({ version })), version).toMatchObject({ refused: "Validation" });
    }
    for (const id of ["not-an-id", "", "../x"]) {
      expect(await submitPublishEntry(a.actor, a.org.slug, site.slug, id, form({ version: "1" })), id).toMatchObject({ refused: "NotFound" });
    }
    expect((await draftOf(ctx, entry.id))!.version).toBe(1);
  });
});

describe("regressions", () => {
  it("a deleted site keeps its content (soft delete, ADR 0011); its entries can no longer be reached through it", async () => {
    const a = await newTenant();
    const { ctx } = await newSite(a);
    const { entry } = await createEntry(ctx, { type: "page", title: "Kept" });
    await deleteSite(ctx);
    expect(await withTenant({ orgId: a.org.id }, (tx) => tx.select({ id: t.entries.id }).from(t.entries).where(eq(t.entries.id, entry.id)))).toHaveLength(1);
    expect((await refusalOf(() => saveDraft(ctx, entry.id, 1, { title: "x" }))).kind).toBe("NotFound");
  });
});
