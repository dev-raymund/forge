import { and, eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { beforeAll, describe, expect, it } from "vitest";
import { getPool } from "@/platform/db/client";
import * as t from "@/platform/db/schema";
import { withPlatform, withTenant, type TenantTx } from "@/platform/db/tenant";
import { dbError, PG } from "../fixtures/db-error";
import { createMedia, createPublishedEntry, createSite, createTenantGraph } from "../fixtures/factories";

/**
 * M5-1 against real Postgres, as forge_app through PgBouncer: the content
 * schema (plan §4.2) that M1-1 created and nothing has used yet. Everything
 * here is the database's own guarantee, before any content service exists:
 * the shape, the keys, the constraints, the delete rules, the grants and RLS.
 * The application's rules (who may write what) arrive with M5-3.
 */

const CONTENT_TABLES = ["entries", "entry_drafts", "entry_revisions", "terms", "entry_terms"] as const;
type ContentTable = (typeof CONTENT_TABLES)[number];

type Graph = Awaited<ReturnType<typeof createTenantGraph>>;
type Site = { orgId: string; siteId: string; userId: string };
let A: Graph;
let B: Graph;
/** A second site of A's organization. */
let A2: Site;
const siteOf = (graph: Graph): Site => ({ orgId: graph.org.id, siteId: graph.site.id, userId: graph.user.id });

const RLS_VIOLATION = { code: PG.insufficientPrivilege, message: expect.stringMatching(/row-level security/) };
const fk = (constraint: string) => ({ code: PG.foreignKeyViolation, constraint });
const check = (constraint: string) => ({ code: PG.checkViolation, constraint });
const unique = (constraint: string) => ({ code: PG.uniqueViolation, constraint });

let counter = 0;
const slug = (prefix = "entry") => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
const asTenant = <T>(site: Pick<Site, "orgId" | "userId">, work: (tx: TenantTx) => Promise<T>) => withTenant({ orgId: site.orgId, userId: site.userId }, work);

/** A draft page (or post) in the site: the entry row only. */
async function newEntry(site: Site, values: Partial<typeof t.entries.$inferInsert> = {}) {
  const s = values.slug ?? slug();
  const [row] = await asTenant(site, (tx) =>
    tx.insert(t.entries).values({ organizationId: site.orgId, siteId: site.siteId, type: "page", locale: "en", slug: s, path: `/${s}`, ...values }).returning(),
  );
  return row!;
}
async function newTerm(site: Site, values: Partial<typeof t.terms.$inferInsert> = {}) {
  const [row] = await asTenant(site, (tx) =>
    tx.insert(t.terms).values({ organizationId: site.orgId, siteId: site.siteId, taxonomy: "category", name: "Topic", slug: slug("term"), ...values }).returning(),
  );
  return row!;
}
async function newRevision(site: Site, entryId: string, number: number) {
  const [row] = await asTenant(site, (tx) =>
    tx
      .insert(t.entryRevisions)
      .values({ organizationId: site.orgId, siteId: site.siteId, entryId, number, kind: "save", title: "T", slug: "t", content: { v: 1 }, contentHash: "h", sourceDraftVersion: 1 })
      .returning(),
  );
  return row!;
}
/** One statement as the tenant, expected to fail; returns the Postgres error. */
const refused = (site: Pick<Site, "orgId" | "userId">, statement: ReturnType<typeof sql>) => dbError(asTenant(site, (tx) => tx.execute(statement)));
const rowsOf = async (site: Pick<Site, "orgId" | "userId">, statement: ReturnType<typeof sql>) => (await asTenant(site, (tx) => tx.execute(statement))).rows;

beforeAll(async () => {
  [A, B] = await Promise.all([createTenantGraph(), createTenantGraph()]);
  const second = await createSite(A.org.id, A.user.id);
  A2 = { orgId: A.org.id, siteId: second.id, userId: A.user.id };
});

describe("the five tables, as the migrations made them (plan §4.2)", () => {
  const columnsOf = async (table: string) =>
    (await getPool().query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = $1", [table])).rows
      .map((row) => row.column_name)
      .sort();

  it("each table has the plan's columns (plus the timestamp convention), and no others", async () => {
    const expected: Record<ContentTable, string[]> = {
      entries: [
        "id", "organization_id", "site_id", "type", "locale", "parent_id", "author_id", "status", "title", "slug", "path", "excerpt", "featured_media_id",
        "published_revision_id", "published_at", "first_published_at", "scheduled_at", "sort_order", "created_by", "updated_by", "deleted_at", "created_at", "updated_at",
      ],
      entry_drafts: [
        "entry_id", "organization_id", "site_id", "title", "slug", "excerpt", "featured_media_id", "template", "content", "fields", "seo", "term_ids", "version",
        "content_hash", "updated_by", "updated_at",
      ],
      entry_revisions: [
        "id", "organization_id", "site_id", "entry_id", "number", "kind", "label", "title", "slug", "excerpt", "featured_media_id", "template", "content", "fields", "seo",
        "term_ids", "content_hash", "source_draft_version", "created_by", "created_at",
      ],
      terms: ["id", "organization_id", "site_id", "taxonomy", "parent_id", "name", "slug", "description", "created_at", "updated_at"],
      entry_terms: ["organization_id", "site_id", "entry_id", "term_id"],
    };
    for (const table of CONTENT_TABLES) expect(await columnsOf(table), table).toEqual([...expected[table]].sort());
  });

  it("the keys and indexes: the path key (partial, per site and locale), the list indexes, the tree index, the trigram index on draft titles", async () => {
    const { rows } = await getPool().query<{ indexname: string; indexdef: string }>(
      "select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = any($1)",
      [CONTENT_TABLES],
    );
    const index = Object.fromEntries(rows.map((row) => [row.indexname, row.indexdef.replace(/ USING btree| ON public\./g, (m) => (m === " USING btree" ? "" : " ON "))]));
    expect(index.entries_site_locale_path_unique).toBe("CREATE UNIQUE INDEX entries_site_locale_path_unique ON entries (site_id, locale, path) WHERE (deleted_at IS NULL)");
    expect(index.entries_list_published_idx).toBe("CREATE INDEX entries_list_published_idx ON entries (site_id, type, status, published_at DESC NULLS LAST)");
    expect(index.entries_list_updated_idx).toBe("CREATE INDEX entries_list_updated_idx ON entries (site_id, type, updated_at DESC NULLS LAST) WHERE (deleted_at IS NULL)");
    expect(index.entries_tree_idx).toBe("CREATE INDEX entries_tree_idx ON entries (site_id, parent_id, sort_order)");
    expect(index.entry_drafts_title_trgm_idx).toBe("CREATE INDEX entry_drafts_title_trgm_idx ON entry_drafts USING gin (title gin_trgm_ops)");
    expect(index.entry_revisions_entry_number_unique).toBe("CREATE UNIQUE INDEX entry_revisions_entry_number_unique ON entry_revisions (entry_id, number)");
    expect(index.terms_site_taxonomy_slug_unique).toBe("CREATE UNIQUE INDEX terms_site_taxonomy_slug_unique ON terms (site_id, taxonomy, slug)");
    expect(index.entry_terms_pk).toBe("CREATE UNIQUE INDEX entry_terms_pk ON entry_terms (entry_id, term_id)");
    expect(index.entry_terms_term_idx).toBe("CREATE INDEX entry_terms_term_idx ON entry_terms (term_id)");
  });

  it("the foreign keys: every reference inside a site is composite on (site_id, …); optional ones SET NULL only their own column", async () => {
    const { rows } = await getPool().query<{ conname: string; def: string }>(
      `select conname, pg_get_constraintdef(oid) as def from pg_constraint
       where contype = 'f' and conrelid = any (select oid from pg_class where relname = any($1) and relnamespace = 'public'::regnamespace)`,
      [CONTENT_TABLES],
    );
    const fks = Object.fromEntries(rows.map((row) => [row.conname, row.def]));
    const siteFk = "FOREIGN KEY (organization_id, site_id) REFERENCES sites(organization_id, id) ON DELETE CASCADE";
    for (const table of CONTENT_TABLES) expect(fks[`${table}_site_fk`], table).toBe(siteFk);
    expect(fks).toMatchObject({
      entries_parent_fk: "FOREIGN KEY (site_id, parent_id) REFERENCES entries(site_id, id) ON DELETE SET NULL (parent_id)",
      entries_featured_media_fk: "FOREIGN KEY (site_id, featured_media_id) REFERENCES media_assets(site_id, id) ON DELETE SET NULL (featured_media_id)",
      entries_published_revision_fk: "FOREIGN KEY (id, published_revision_id) REFERENCES entry_revisions(entry_id, id)",
      entry_drafts_entry_fk: "FOREIGN KEY (site_id, entry_id) REFERENCES entries(site_id, id) ON DELETE CASCADE",
      entry_drafts_featured_media_fk: "FOREIGN KEY (site_id, featured_media_id) REFERENCES media_assets(site_id, id) ON DELETE SET NULL (featured_media_id)",
      entry_revisions_entry_fk: "FOREIGN KEY (site_id, entry_id) REFERENCES entries(site_id, id) ON DELETE CASCADE",
      terms_parent_fk: "FOREIGN KEY (site_id, parent_id) REFERENCES terms(site_id, id) ON DELETE SET NULL (parent_id)",
      entry_terms_entry_fk: "FOREIGN KEY (site_id, entry_id) REFERENCES entries(site_id, id) ON DELETE CASCADE",
      entry_terms_term_fk: "FOREIGN KEY (site_id, term_id) REFERENCES terms(site_id, id) ON DELETE CASCADE",
    });
    // Revisions are history: their featured media is a value, not a live reference.
    expect(Object.keys(fks).filter((name) => name.startsWith("entry_revisions_")).sort()).toEqual(["entry_revisions_created_by_users_id_fk", "entry_revisions_entry_fk", "entry_revisions_site_fk"]);
  });

  it("RLS enabled and forced on each, with the one tenant policy for reads and writes", async () => {
    const { rows } = await getPool().query<{ relname: string; enabled: boolean; forced: boolean }>(
      "select relname, relrowsecurity as enabled, relforcerowsecurity as forced from pg_class where relname = any($1) and relnamespace = 'public'::regnamespace",
      [CONTENT_TABLES],
    );
    expect(rows.sort((x, y) => x.relname.localeCompare(y.relname))).toEqual([...CONTENT_TABLES].sort().map((relname) => ({ relname, enabled: true, forced: true })));
    const policies = await getPool().query<{ tablename: string; policyname: string; cmd: string; qual: string; with_check: string }>(
      "select tablename, policyname, cmd, qual, with_check from pg_policies where tablename = any($1)",
      [CONTENT_TABLES],
    );
    expect(policies.rows).toHaveLength(CONTENT_TABLES.length);
    for (const policy of policies.rows) {
      expect(policy, policy.tablename).toMatchObject({
        policyname: `${policy.tablename}_tenant_isolation`, cmd: "ALL", qual: "(organization_id = app_current_org_id())", with_check: "(organization_id = app_current_org_id())",
      });
    }
  });

  it("grants: the runtime role reads and writes every content table, but may never UPDATE a revision", async () => {
    const privileges = async (table: string) =>
      (
        await getPool().query<{ s: boolean; i: boolean; u: boolean; d: boolean }>(
          `select has_table_privilege(current_user, $1, 'SELECT') s, has_table_privilege(current_user, $1, 'INSERT') i,
                  has_table_privilege(current_user, $1, 'UPDATE') u, has_table_privilege(current_user, $1, 'DELETE') d`,
          [table],
        )
      ).rows[0];
    for (const table of ["entries", "entry_drafts", "terms", "entry_terms"]) expect(await privileges(table), table).toEqual({ s: true, i: true, u: true, d: true });
    // DELETE stays, for pruning old revisions; never UPDATE (D-13: revisions are immutable).
    expect(await privileges("entry_revisions")).toEqual({ s: true, i: true, u: false, d: true });
    for (const statement of [sql`update entry_revisions set title = 'x'`, sql`update entry_revisions set content = '{}'::jsonb where id = ${A.revision.id}`]) {
      expect(await refused(siteOf(A), statement)).toMatchObject({ code: PG.insufficientPrivilege, message: expect.stringMatching(/permission denied/) });
    }
  });
});

describe("defaults and required fields", () => {
  it("a new entry is a draft, with empty title and excerpt, first in its level, and stamped", async () => {
    const entry = await newEntry(siteOf(A));
    expect(entry).toMatchObject({
      status: "draft", title: "", excerpt: "", sortOrder: 0, parentId: null, publishedRevisionId: null, publishedAt: null, firstPublishedAt: null, scheduledAt: null, deletedAt: null,
    });
    expect(entry.createdAt).toBeInstanceOf(Date);
    expect(entry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/); // UUIDv7
  });

  it("a draft starts at version 1, with an empty document, fields, SEO and terms", async () => {
    const entry = await newEntry(siteOf(A));
    const [draft] = await asTenant(siteOf(A), (tx) => tx.insert(t.entryDrafts).values({ entryId: entry.id, organizationId: A.org.id, siteId: A.site.id, slug: entry.slug }).returning());
    expect(draft).toMatchObject({ version: 1, title: "", excerpt: "", content: {}, fields: {}, seo: {}, termIds: [], contentHash: "", template: null, featuredMediaId: null });
  });

  it("a new term has an empty description and no parent", async () => {
    const term = await newTerm(siteOf(A), { taxonomy: "tag" });
    expect(term).toMatchObject({ description: "", parentId: null, taxonomy: "tag" });
  });

  it("the columns without a meaningful default must be given", async () => {
    const { org, site } = A;
    const missing: [ReturnType<typeof sql>, string][] = [
      [sql`insert into entries (id, organization_id, site_id, locale, slug, path) values (${uuidv7()}, ${org.id}, ${site.id}, 'en', 'x', '/x')`, "type"],
      [sql`insert into entries (id, organization_id, site_id, type, slug, path) values (${uuidv7()}, ${org.id}, ${site.id}, 'page', 'x', '/x')`, "locale"],
      [sql`insert into entries (id, organization_id, site_id, type, locale, path) values (${uuidv7()}, ${org.id}, ${site.id}, 'page', 'en', '/x')`, "slug"],
      [sql`insert into entries (id, organization_id, site_id, type, locale, slug) values (${uuidv7()}, ${org.id}, ${site.id}, 'page', 'en', 'x')`, "path"],
      [sql`insert into entries (id, organization_id, type, locale, slug, path) values (${uuidv7()}, ${org.id}, 'page', 'en', 'x', '/x')`, "site_id"],
      [sql`insert into entry_drafts (entry_id, organization_id, site_id) values (${A.entry.id}, ${org.id}, ${site.id})`, "slug"],
      [sql`insert into entry_revisions (id, organization_id, site_id, entry_id, number, kind, title, slug, content_hash, source_draft_version) values (${uuidv7()}, ${org.id}, ${site.id}, ${A.entry.id}, 90, 'save', 't', 't', 'h', 1)`, "content"],
      [sql`insert into entry_revisions (id, organization_id, site_id, entry_id, number, kind, title, slug, content, source_draft_version) values (${uuidv7()}, ${org.id}, ${site.id}, ${A.entry.id}, 91, 'save', 't', 't', '{}', 1)`, "content_hash"],
      [sql`insert into terms (id, organization_id, site_id, taxonomy, slug) values (${uuidv7()}, ${org.id}, ${site.id}, 'tag', 'x')`, "name"],
      [sql`insert into terms (id, organization_id, site_id, name, slug) values (${uuidv7()}, ${org.id}, ${site.id}, 'X', 'x')`, "taxonomy"],
    ];
    for (const [statement, column] of missing) {
      expect(await refused(siteOf(A), statement), column).toMatchObject({ code: PG.notNullViolation, message: expect.stringContaining(`column "${column}"`) });
    }
  });
});

describe("CHECK constraints: the invariants the database keeps whatever the code does", () => {
  it("entries: type, status, slug and path formats, and the lifecycle rules", async () => {
    const site = siteOf(A);
    const ok = { organization_id: site.orgId, site_id: site.siteId, type: "page", locale: "en", status: "draft", slug: "ok", path: "/ok" };
    const insert = (over: Record<string, unknown>) => {
      const row = { id: uuidv7(), ...ok, ...over };
      const columns = sql.join(Object.keys(row).map((column) => sql.identifier(column)), sql`, `);
      return sql`insert into entries (${columns}) values (${sql.join(Object.values(row).map((value) => sql`${value}`), sql`, `)})`;
    };
    const cases: [Record<string, unknown>, string][] = [
      [{ type: "product" }, "entries_type_check"],
      [{ type: "Page" }, "entries_type_check"],
      [{ status: "archived" }, "entries_status_check"],
      ...["", "Upper", "two words", "a--b", "-a", "a-", "a/b", "ünï", "<script>"].map((value): [Record<string, unknown>, string] => [{ slug: value }, "entries_slug_format"]),
      ...["", "no-slash", "/Upper", "/a//b", "/a/", "/a b", "//x", "/../x", "/x?y"].map((value): [Record<string, unknown>, string] => [{ path: value }, "entries_path_format"]),
      [{ status: "published" }, "entries_published_has_revision"],
      [{ status: "scheduled" }, "entries_scheduled_has_time"],
      [{ status: "draft", scheduled_at: new Date().toISOString() }, "entries_scheduled_has_time"],
      [{ type: "post", parent_id: A.entry.id }, "entries_only_pages_nest"],
    ];
    for (const [over, constraint] of cases) expect(await refused(site, insert(over)), JSON.stringify(over)).toMatchObject(check(constraint));

    // Paths may nest; a scheduled entry has its time.
    await newEntry(site, { slug: "child", path: `/${slug("parent")}/child` });
    await newEntry(site, { type: "post", status: "scheduled", scheduledAt: new Date(Date.now() + 86_400_000) });
  });

  it("a published entry cannot be put in the trash, and a trashed one cannot be published", async () => {
    expect(await refused(siteOf(A), sql`update entries set deleted_at = now() where id = ${A.entry.id}`)).toMatchObject(check("entries_trash_not_live"));
    const trashed = await newEntry(siteOf(A), { deletedAt: new Date() });
    const revision = await newRevision(siteOf(A), trashed.id, 1);
    expect(
      await refused(siteOf(A), sql`update entries set status = 'published', published_revision_id = ${revision.id}, published_at = now() where id = ${trashed.id}`),
    ).toMatchObject(check("entries_trash_not_live"));
  });

  it("drafts, revisions and terms", async () => {
    const site = siteOf(A);
    const entry = await newEntry(site);
    expect(
      await refused(site, sql`insert into entry_drafts (entry_id, organization_id, site_id, slug, version) values (${entry.id}, ${site.orgId}, ${site.siteId}, 'x', 0)`),
    ).toMatchObject(check("entry_drafts_version_positive"));
    expect(
      await refused(
        site,
        sql`insert into entry_revisions (id, organization_id, site_id, entry_id, number, kind, title, slug, content, content_hash, source_draft_version)
            values (${uuidv7()}, ${site.orgId}, ${site.siteId}, ${entry.id}, 1, 'autosave', 't', 't', '{}', 'h', 1)`,
      ),
    ).toMatchObject(check("entry_revisions_kind_check"));
    const term = (taxonomy: string, termSlug: string, parent: string | null = null) =>
      sql`insert into terms (id, organization_id, site_id, taxonomy, name, slug, parent_id) values (${uuidv7()}, ${site.orgId}, ${site.siteId}, ${taxonomy}, 'N', ${termSlug}, ${parent})`;
    expect(await refused(site, term("label", "x"))).toMatchObject(check("terms_taxonomy_check"));
    expect(await refused(site, term("tag", "Not A Slug"))).toMatchObject(check("terms_slug_format"));
    const category = await newTerm(site);
    expect(await refused(site, term("tag", slug("tag"), category.id))).toMatchObject(check("terms_only_categories_nest"));
    expect((await newTerm(site, { parentId: category.id })).parentId).toBe(category.id);
  });
});

describe("uniqueness at the right scope", () => {
  it("a path is unique per site and locale while in use: the same path in another locale, another site of the organization or another organization is fine", async () => {
    const path = `/${slug("about")}`;
    const s = path.slice(1);
    await newEntry(siteOf(A), { slug: s, path });
    expect(await dbError(newEntry(siteOf(A), { slug: s, path }))).toMatchObject(unique("entries_site_locale_path_unique"));
    expect(await dbError(newEntry(siteOf(A), { type: "post", slug: s, path }))).toMatchObject(unique("entries_site_locale_path_unique"));
    await newEntry(siteOf(A), { slug: s, path, locale: "fil" });
    await newEntry(A2, { slug: s, path });
    await newEntry(siteOf(B), { slug: s, path });
  });

  it("the trash releases a path; bringing the old entry back while the path is taken is refused", async () => {
    const site = siteOf(A);
    const s = slug("trashed");
    const old = await newEntry(site, { slug: s, path: `/${s}` });
    await asTenant(site, (tx) => tx.update(t.entries).set({ deletedAt: new Date() }).where(eq(t.entries.id, old.id)));
    await newEntry(site, { slug: s, path: `/${s}` });
    expect(await refused(site, sql`update entries set deleted_at = null where id = ${old.id}`)).toMatchObject(unique("entries_site_locale_path_unique"));
  });

  it("two transactions claiming one path at once: exactly one wins, the other is refused when the first commits", async () => {
    const site = siteOf(A);
    const s = slug("race");
    const claim = () =>
      asTenant(site, async (tx) => {
        await tx.insert(t.entries).values({ organizationId: site.orgId, siteId: site.siteId, type: "page", locale: "en", slug: s, path: `/${s}` });
        await tx.execute(sql`select pg_sleep(0.3)`);
      });
    const results = await Promise.allSettled([claim(), claim(), claim()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results.filter((r): r is PromiseRejectedResult => r.status === "rejected")) {
      expect(await dbError(Promise.reject(result.reason))).toMatchObject(unique("entries_site_locale_path_unique"));
    }
    expect(await rowsOf(site, sql`select count(*)::int as n from entries where site_id = ${site.siteId} and path = ${`/${s}`}`)).toEqual([{ n: 1 }]);
  });

  it("a term's slug is unique per site and taxonomy; a revision's number per entry", async () => {
    const s = slug("topic");
    await newTerm(siteOf(A), { slug: s });
    expect(await dbError(newTerm(siteOf(A), { slug: s }))).toMatchObject(unique("terms_site_taxonomy_slug_unique"));
    await newTerm(siteOf(A), { slug: s, taxonomy: "tag" });
    await newTerm(A2, { slug: s });
    const entry = await newEntry(siteOf(A));
    await newRevision(siteOf(A), entry.id, 1);
    expect(await dbError(newRevision(siteOf(A), entry.id, 1))).toMatchObject(unique("entry_revisions_entry_number_unique"));
    await newRevision(siteOf(A), (await newEntry(siteOf(A))).id, 1);
  });

  it("an entry has one draft; a term is linked to an entry once", async () => {
    expect(
      await refused(siteOf(A), sql`insert into entry_drafts (entry_id, organization_id, site_id, slug) values (${A.entry.id}, ${A.org.id}, ${A.site.id}, 'again')`),
    ).toMatchObject(unique("entry_drafts_pkey"));
    expect(
      await refused(siteOf(A), sql`insert into entry_terms (organization_id, site_id, entry_id, term_id) values (${A.org.id}, ${A.site.id}, ${A.entry.id}, ${A.term.id})`),
    ).toMatchObject(unique("entry_terms_pk"));
  });
});

describe("references stay inside one site: another site's rows cannot be linked, even by a known id (the issue's test)", () => {
  it("a parent page from another site of the same organization, or from another organization", async () => {
    const otherSitesPage = await newEntry(A2);
    for (const parent of [otherSitesPage.id, B.entry.id]) {
      expect(await dbError(newEntry(siteOf(A), { parentId: parent }))).toMatchObject(fk("entries_parent_fk"));
      expect(await refused(siteOf(A), sql`update entries set parent_id = ${parent} where id = ${A.entry.id}`)).toMatchObject(fk("entries_parent_fk"));
    }
  });

  it("a term from another site, for a published assignment; a parent category from another site", async () => {
    const entry = await newEntry(siteOf(A));
    const otherSitesTerm = await newTerm(A2);
    for (const term of [otherSitesTerm.id, B.term.id]) {
      expect(
        await refused(siteOf(A), sql`insert into entry_terms (organization_id, site_id, entry_id, term_id) values (${A.org.id}, ${A.site.id}, ${entry.id}, ${term})`),
      ).toMatchObject(fk("entry_terms_term_fk"));
      expect(await dbError(newTerm(siteOf(A), { parentId: term }))).toMatchObject(fk("terms_parent_fk"));
    }
    // The assignment named under the other site instead: then the entry is the stranger.
    expect(
      await refused(siteOf(A), sql`insert into entry_terms (organization_id, site_id, entry_id, term_id) values (${A.org.id}, ${A2.siteId}, ${entry.id}, ${otherSitesTerm.id})`),
    ).toMatchObject(fk("entry_terms_entry_fk"));
  });

  it("a draft or a revision for another site's entry", async () => {
    const otherSitesPage = await newEntry(A2);
    expect(
      await refused(siteOf(A), sql`insert into entry_drafts (entry_id, organization_id, site_id, slug) values (${otherSitesPage.id}, ${A.org.id}, ${A.site.id}, 'x')`),
    ).toMatchObject(fk("entry_drafts_entry_fk"));
    expect(await dbError(newRevision(siteOf(A), otherSitesPage.id, 1))).toMatchObject(fk("entry_revisions_entry_fk"));
  });

  it("a draft's featured image from another site; a published revision of another entry", async () => {
    const { media } = await createMedia(A2);
    expect(await refused(siteOf(A), sql`update entry_drafts set featured_media_id = ${media.id} where entry_id = ${A.entry.id}`)).toMatchObject(fk("entry_drafts_featured_media_fk"));
    const other = await createPublishedEntry(siteOf(A));
    expect(await refused(siteOf(A), sql`update entries set published_revision_id = ${other.revision.id} where id = ${A.entry.id}`)).toMatchObject(fk("entries_published_revision_fk"));
  });

  it("a content row cannot claim another organization's site, whichever organization it names", async () => {
    // Named as A's own row on B's site: the composite (organization_id, site_id) key has no such site.
    expect(await dbError(newEntry({ ...siteOf(A), siteId: B.site.id }))).toMatchObject(fk("entries_site_fk"));
    expect(await dbError(newTerm({ ...siteOf(A), siteId: B.site.id }))).toMatchObject(fk("terms_site_fk"));
    // Named as B's row, from A's context: RLS refuses it before any key is looked at.
    expect(
      await refused(siteOf(A), sql`insert into entries (id, organization_id, site_id, type, locale, slug, path) values (${uuidv7()}, ${B.org.id}, ${B.site.id}, 'page', 'en', 'x', '/x')`),
    ).toMatchObject(RLS_VIOLATION);
  });
});

describe("deletes follow the plan's rules", () => {
  it("deleting a parent page keeps the child and its site; deleting a parent category keeps the child", async () => {
    const site = siteOf(A);
    const parent = await newEntry(site);
    const child = await newEntry(site, { parentId: parent.id });
    const category = await newTerm(site);
    const sub = await newTerm(site, { parentId: category.id });
    await asTenant(site, async (tx) => {
      await tx.delete(t.entries).where(eq(t.entries.id, parent.id));
      await tx.delete(t.terms).where(eq(t.terms.id, category.id));
    });
    expect(await rowsOf(site, sql`select site_id, parent_id from entries where id = ${child.id}`)).toEqual([{ site_id: site.siteId, parent_id: null }]);
    expect(await rowsOf(site, sql`select site_id, parent_id from terms where id = ${sub.id}`)).toEqual([{ site_id: site.siteId, parent_id: null }]);
  });

  it("deleting an image clears it from the entry and its draft; the revisions keep what they recorded", async () => {
    const site = siteOf(A);
    const { media } = await createMedia(site);
    const published = await createPublishedEntry(site, media.id);
    await asTenant(site, async (tx) => {
      await tx.update(t.entryDrafts).set({ featuredMediaId: media.id }).where(eq(t.entryDrafts.entryId, published.entry.id));
      await tx.update(t.entries).set({ featuredMediaId: media.id }).where(eq(t.entries.id, published.entry.id));
    });
    await asTenant(site, (tx) => tx.insert(t.entryRevisions).values({ ...revisionOf(site, published.entry.id, 2), featuredMediaId: media.id }));
    await asTenant(site, (tx) => tx.delete(t.mediaAssets).where(eq(t.mediaAssets.id, media.id)));
    expect(await rowsOf(site, sql`select featured_media_id from entries where id = ${published.entry.id}`)).toEqual([{ featured_media_id: null }]);
    expect(await rowsOf(site, sql`select featured_media_id from entry_drafts where entry_id = ${published.entry.id}`)).toEqual([{ featured_media_id: null }]);
    expect(await rowsOf(site, sql`select featured_media_id from entry_revisions where entry_id = ${published.entry.id} and number = 2`)).toEqual([{ featured_media_id: media.id }]);
  });

  it("deleting an entry, even a published one, takes its draft, revisions and term links with it; the terms stay; a homepage pointing at it is cleared", async () => {
    const site = siteOf(A);
    const { entry, term } = await createPublishedEntry(site);
    await asTenant(site, (tx) => tx.update(t.siteSettings).set({ homepageEntryId: entry.id }).where(eq(t.siteSettings.siteId, site.siteId)));
    await asTenant(site, (tx) => tx.delete(t.entries).where(eq(t.entries.id, entry.id)));
    const left = await rowsOf(
      site,
      sql`select (select count(*)::int from entry_drafts where entry_id = ${entry.id}) drafts, (select count(*)::int from entry_revisions where entry_id = ${entry.id}) revisions,
                 (select count(*)::int from entry_terms where entry_id = ${entry.id}) links, (select count(*)::int from terms where id = ${term.id}) terms,
                 (select homepage_entry_id from site_settings where site_id = ${site.siteId}) homepage`,
    );
    expect(left).toEqual([{ drafts: 0, revisions: 0, links: 0, terms: 1, homepage: null }]);
  });

  it("deleting a term removes its links and nothing else", async () => {
    const site = siteOf(A);
    const { entry, term } = await createPublishedEntry(site);
    await asTenant(site, (tx) => tx.delete(t.terms).where(eq(t.terms.id, term.id)));
    expect(await rowsOf(site, sql`select count(*)::int as n from entry_terms where term_id = ${term.id}`)).toEqual([{ n: 0 }]);
    expect(await rowsOf(site, sql`select status from entries where id = ${entry.id}`)).toEqual([{ status: "published" }]);
  });

  it("old revisions can be pruned; the published one cannot be deleted while it is published", async () => {
    const site = siteOf(A);
    const { entry, revision } = await createPublishedEntry(site);
    const older = await newRevision(site, entry.id, 2);
    await asTenant(site, (tx) => tx.delete(t.entryRevisions).where(eq(t.entryRevisions.id, older.id)));
    expect(await refused(site, sql`delete from entry_revisions where id = ${revision.id}`)).toMatchObject(fk("entries_published_revision_fk"));
  });
});

const revisionOf = (site: Site, entryId: string, number: number) => ({
  organizationId: site.orgId, siteId: site.siteId, entryId, number, kind: "save" as const, title: "T", slug: "t", content: { v: 1 }, contentHash: "h", sourceDraftVersion: 1,
});

describe("RLS on every content table", () => {
  /** The organization of every row of the table the context can see. */
  const orgsSeen = async (table: ContentTable, orgId: string | null) => {
    const query = sql`select organization_id as org from ${sql.identifier(table)}`;
    const rows = orgId === null ? await withPlatform((tx) => tx.execute(query)) : await withTenant({ orgId }, (tx) => tx.execute(query));
    return new Set((rows.rows as { org: string }[]).map((row) => row.org));
  };

  it.each(CONTENT_TABLES)("%s: the organization sees its own rows only; no context, or an organization that does not exist, sees nothing", async (table) => {
    expect(await orgsSeen(table, A.org.id)).toEqual(new Set([A.org.id]));
    expect(await orgsSeen(table, B.org.id)).toEqual(new Set([B.org.id]));
    expect(await orgsSeen(table, null)).toEqual(new Set());
    expect(await orgsSeen(table, uuidv7())).toEqual(new Set());
  });

  it.each(CONTENT_TABLES)("%s: a context that is not an organization id fails closed: an error, never rows", async (table) => {
    for (const value of ["not-a-uuid", "' or 1=1 --", "*"]) {
      const error = await dbError(
        withPlatform(async (tx) => {
          await tx.execute(sql`select set_config('app.org_id', ${value}, true)`);
          return tx.execute(sql`select 1 from ${sql.identifier(table)}`);
        }),
      );
      expect(error, value).toMatchObject({ code: PG.invalidTextRepresentation });
    }
  });

  it("as A, B's rows cannot be written: inserts stamped with B are refused, updates and deletes aimed at B's ids touch nothing", async () => {
    const b = siteOf(B);
    const bEntry = await newEntry(b);
    const bTerm = await newTerm(b);
    const before = await contentOf(B.org.id);
    const stampedWithB = [
      sql`insert into entries (id, organization_id, site_id, type, locale, slug, path) values (${uuidv7()}, ${b.orgId}, ${b.siteId}, 'page', 'en', 'hijack', '/hijack')`,
      sql`insert into entry_drafts (entry_id, organization_id, site_id, slug) values (${bEntry.id}, ${b.orgId}, ${b.siteId}, 'hijack')`,
      sql`insert into entry_revisions (id, organization_id, site_id, entry_id, number, kind, title, slug, content, content_hash, source_draft_version)
          values (${uuidv7()}, ${b.orgId}, ${b.siteId}, ${bEntry.id}, 7, 'save', 't', 't', '{}', 'h', 1)`,
      sql`insert into terms (id, organization_id, site_id, taxonomy, name, slug) values (${uuidv7()}, ${b.orgId}, ${b.siteId}, 'tag', 'H', 'hijack')`,
      sql`insert into entry_terms (organization_id, site_id, entry_id, term_id) values (${b.orgId}, ${b.siteId}, ${bEntry.id}, ${bTerm.id})`,
    ];
    for (const statement of stampedWithB) expect(await refused(siteOf(A), statement)).toMatchObject(RLS_VIOLATION);

    const aimedAtB = [
      sql`update entries set title = 'pwned' where id = ${bEntry.id}`,
      sql`update entry_drafts set title = 'pwned' where entry_id = ${B.entry.id}`,
      sql`update terms set name = 'pwned' where id = ${bTerm.id}`,
      sql`delete from entry_terms where entry_id = ${B.entry.id}`,
      sql`delete from entry_revisions where entry_id = ${B.entry.id}`,
      sql`delete from entry_drafts where entry_id = ${B.entry.id}`,
      sql`delete from terms where id = ${bTerm.id}`,
      sql`delete from entries where id = ${bEntry.id}`,
    ];
    const affected = await asTenant(siteOf(A), async (tx) => {
      const counts: (number | null)[] = [];
      for (const statement of aimedAtB) counts.push((await tx.execute(statement)).rowCount);
      return counts;
    });
    expect(affected).toEqual(aimedAtB.map(() => 0));
    expect(await contentOf(B.org.id)).toEqual(before);
  });

  it("an own row cannot be moved into another organization", async () => {
    const entry = await newEntry(siteOf(A));
    const term = await newTerm(siteOf(A));
    expect(await refused(siteOf(A), sql`update entries set organization_id = ${B.org.id} where id = ${entry.id}`)).toMatchObject(RLS_VIOLATION);
    expect(await refused(siteOf(A), sql`update terms set organization_id = ${B.org.id}, site_id = ${B.site.id} where id = ${term.id}`)).toMatchObject(RLS_VIOLATION);
  });
});

/** Every content row of the organization, as text: any change to any of them changes it. */
const contentOf = (orgId: string) =>
  withTenant({ orgId }, async (tx) => {
    const out: Record<string, string[]> = {};
    for (const table of CONTENT_TABLES) {
      out[table] = (await tx.execute<{ row: string }>(sql`select row_to_json(x)::text as row from ${sql.identifier(table)} x order by 1`)).rows.map((row) => row.row);
    }
    return out;
  });

describe("two sites of one organization", () => {
  it("RLS is per organization (plan §4.3): the organization's context reads both sites, and a site's own rows are those with its site_id", async () => {
    const one = await newEntry(siteOf(A));
    const two = await newEntry(A2);
    const ids = (siteId?: string) =>
      asTenant(siteOf(A), async (tx) =>
        (await tx.select({ id: t.entries.id }).from(t.entries).where(siteId ? and(eq(t.entries.organizationId, A.org.id), eq(t.entries.siteId, siteId)) : undefined)).map((row) => row.id),
      );
    expect(await ids()).toEqual(expect.arrayContaining([one.id, two.id]));
    expect(await ids(A.site.id)).toContain(one.id);
    expect(await ids(A.site.id)).not.toContain(two.id);
    expect(await ids(A2.siteId)).toEqual(expect.arrayContaining([two.id]));
    expect(await ids(A2.siteId)).not.toContain(one.id);
  });
});

describe("sites and organizations changing state", () => {
  it("a site in the trash, suspended or live keeps its content exactly as it was (sites are soft-deleted, ADR 0011)", async () => {
    const graph = await createTenantGraph();
    const before = await contentOf(graph.org.id);
    for (const change of [{ status: "suspended" as const }, { status: "live" as const }, { deletedAt: new Date() }]) {
      await withTenant({ orgId: graph.org.id }, (tx) => tx.update(t.sites).set(change).where(eq(t.sites.id, graph.site.id)));
      expect(await contentOf(graph.org.id), JSON.stringify(change)).toEqual(before);
    }
  });

  it("a site removed for good takes all its content with it, and nothing of the organization's other site", async () => {
    const graph = await createTenantGraph();
    const other = await createSite(graph.org.id, graph.user.id);
    const kept = await createPublishedEntry({ orgId: graph.org.id, siteId: other.id, userId: graph.user.id });
    await withTenant({ orgId: graph.org.id }, (tx) => tx.delete(t.sites).where(eq(t.sites.id, graph.site.id)));
    const left = await contentOf(graph.org.id);
    for (const table of CONTENT_TABLES) {
      for (const row of left[table]!) expect(JSON.parse(row).site_id, table).toBe(other.id);
      expect(left[table]!.length, table).toBeGreaterThan(0);
    }
    expect(left.entries!.map((row) => JSON.parse(row).id)).toEqual([kept.entry.id]);
  });

  it("an organization removed for good takes its sites and their content; another organization's content is untouched", async () => {
    const graph = await createTenantGraph();
    const beforeB = await contentOf(B.org.id);
    await withTenant({ orgId: graph.org.id, userId: graph.user.id }, (tx) => tx.delete(t.organizations).where(eq(t.organizations.id, graph.org.id)));
    // The organization's own context sees every row that names it: none is left.
    expect(await contentOf(graph.org.id)).toEqual(Object.fromEntries(CONTENT_TABLES.map((table) => [table, []])));
    expect(await contentOf(B.org.id)).toEqual(beforeB);
  });
});
