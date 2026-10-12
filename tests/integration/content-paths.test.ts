import { mkdtemp, readFile, rm, writeFile, copyFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { uuidv7 } from "uuidv7";
import { beforeAll, describe, expect, it } from "vitest";
import { insertWithUniqueSlug, MAX_SLUG_ATTEMPTS, type SlugPlace } from "@/modules/content";
import { createSite } from "@/modules/sites";
import { inTenant, resolveSiteContext, type SiteContext } from "@/modules/tenancy";
import * as t from "@/platform/db/schema";
import { withTenant, type TenantTx } from "@/platform/db/tenant";
import { runMigrations } from "../../scripts/db/migrate";
import { dbError, PG } from "../fixtures/db-error";
import { newSlug, newTenant, refusalOf } from "../fixtures/tenants";
import { ownerUrl } from "../setup/db-urls";

/**
 * M5-2 against real Postgres: the Home page's path `/` (migration 0005), and
 * inserting an entry under a free slug. As forge_app through PgBouncer, except
 * the migration test, which runs migrations as forge_owner on its own database
 * like CI does.
 */

const MIGRATIONS = path.resolve(import.meta.dirname, "../../drizzle");

type Tenant = Awaited<ReturnType<typeof newTenant>>;

/**
 * A site with no entries. These tests are about the table and the slug helper, so they start from an empty site:
 * since M5-3, createSite gives every site a Home page at `/`, which is removed here (content-entries.test.ts tests it).
 */
async function siteIn(tenant: Tenant): Promise<SiteContext> {
  const { site } = await createSite(tenant.ctx, { name: "Paths", address: newSlug("paths"), language: "en", timezone: "UTC" });
  const ctx = await resolveSiteContext(tenant.actor, tenant.org.slug, site.slug);
  await inTenant(ctx, (tx) => tx.delete(t.entries).where(eq(t.entries.siteId, site.id)));
  return ctx;
}

/** A draft entry row, as M5-3's createEntry will write it (test code: M5-2 has no entry service). */
const entryRow = (ctx: SiteContext, values: Partial<typeof t.entries.$inferInsert> & { slug: string; path: string }) => ({
  organizationId: ctx.org.id, siteId: ctx.site.id, type: "page" as const, locale: "en", ...values,
});
const addEntry = (ctx: SiteContext, values: Partial<typeof t.entries.$inferInsert> & { slug: string; path: string }) =>
  inTenant(ctx, async (tx) => (await tx.insert(t.entries).values(entryRow(ctx, values)).returning())[0]!);
const pathsOf = (ctx: SiteContext) =>
  inTenant(ctx, async (tx) => (await tx.select({ path: t.entries.path }).from(t.entries).where(and(eq(t.entries.siteId, ctx.site.id), sql`deleted_at is null`))).map((row) => row.path).sort());

describe("the Home page's path is `/` (migration 0005)", () => {
  let a: Tenant;
  let ctx: SiteContext;
  beforeAll(async () => {
    a = await newTenant();
    ctx = await siteIn(a);
  });

  it("the constraint accepts `/` and keeps the old rule for every other path", async () => {
    const { rows } = await withTenant({ orgId: a.org.id }, (tx) =>
      tx.execute<{ def: string }>(sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'entries_path_format'`),
    );
    expect(rows[0]!.def).toBe("CHECK (((path = '/'::text) OR (path ~ '^(/[a-z0-9]+(-[a-z0-9]+)*)+$'::text)))");
  });

  it("a page can be stored at `/`, beside pages at ordinary paths", async () => {
    const home = await addEntry(ctx, { slug: "home", path: "/", title: "Home" });
    expect(home.path).toBe("/");
    await addEntry(ctx, { slug: "about", path: "/about" });
    await addEntry(ctx, { slug: "team", path: "/about/team" });
    expect(await pathsOf(ctx)).toEqual(["/", "/about", "/about/team"]);
  });

  it("anything else that is not `/segment`s is still refused", async () => {
    for (const bad of ["", "//", "/ ", " /", "/a/", "//a", "home", "/Home", "/a//b", "/../a", "/_forge", "/robots.txt", "/a?b"]) {
      expect(await dbError(addEntry(ctx, { slug: "x", path: bad })), JSON.stringify(bad)).toMatchObject({ code: PG.checkViolation, constraint: "entries_path_format" });
    }
  });

  it("one `/` per site and locale while in use: a second is refused; another locale, another site or another organization has its own", async () => {
    const tenant = await newTenant();
    const site = await siteIn(tenant);
    await addEntry(site, { slug: "home", path: "/" });
    expect(await dbError(addEntry(site, { slug: "start", path: "/" }))).toMatchObject({ code: PG.uniqueViolation, constraint: "entries_site_locale_path_unique" });
    await addEntry(site, { slug: "home", path: "/", locale: "fil" });
    await addEntry(await siteIn(tenant), { slug: "home", path: "/" });
    await addEntry(await siteIn(await newTenant()), { slug: "home", path: "/" });
  });

  it("the trash releases `/`; bringing the old Home back while another holds it is refused", async () => {
    const site = await siteIn(await newTenant());
    const old = await addEntry(site, { slug: "home", path: "/" });
    await inTenant(site, (tx) => tx.update(t.entries).set({ deletedAt: new Date() }).where(eq(t.entries.id, old.id)));
    await addEntry(site, { slug: "new-home", path: "/" });
    expect(await dbError(inTenant(site, (tx) => tx.update(t.entries).set({ deletedAt: null }).where(eq(t.entries.id, old.id))))).toMatchObject({
      code: PG.uniqueViolation, constraint: "entries_site_locale_path_unique",
    });
  });

  it("three transactions claiming `/` at once: exactly one wins", async () => {
    const site = await siteIn(await newTenant());
    const claim = () =>
      inTenant(site, async (tx) => {
        await tx.insert(t.entries).values(entryRow(site, { slug: "home", path: "/" }));
        await tx.execute(sql`select pg_sleep(0.3)`);
      });
    const results = await Promise.allSettled([claim(), claim(), claim()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) if (result.status === "rejected") expect(await dbError(Promise.reject(result.reason))).toMatchObject({ code: PG.uniqueViolation });
    expect(await pathsOf(site)).toEqual(["/"]);
  });
});

describe("migration 0005 on a database that already has content", () => {
  it("applies once, keeps every row, and leaves the same rules for every old path; running it again changes nothing", async () => {
    const database = `forge_test_mig_${uuidv7().slice(-12)}`;
    const admin = new pg.Client({ connectionString: ownerUrl("forge") });
    await admin.connect();
    const folder = await mkdtemp(path.join(tmpdir(), "forge-migrations-"));
    try {
      await admin.query(`create database "${database}"`);
      // The migrations as they were before M5-2 (0000–0004): the journal without its last entry.
      const journal = JSON.parse(await readFile(path.join(MIGRATIONS, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
      const before = { ...journal, entries: journal.entries.filter((entry) => entry.tag !== "0005_entries_root_path") };
      expect(before.entries).toHaveLength(journal.entries.length - 1);
      await mkdir(path.join(folder, "meta"));
      await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify(before));
      for (const entry of before.entries) await copyFile(path.join(MIGRATIONS, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));

      const db = new pg.Client({ connectionString: ownerUrl(database) });
      await db.connect();
      try {
        await migrate(drizzle({ client: db }), { migrationsFolder: folder });
        // Content written under the old rule, inside the organization's context (FORCE RLS applies to the owner too).
        const org = uuidv7();
        const site = uuidv7();
        await db.query("select set_config('app.org_id', $1, false)", [org]);
        await db.query("insert into organizations (id, name, slug) values ($1, 'Existing', $2)", [org, `existing-${org.slice(-8)}`]);
        await db.query("insert into sites (id, organization_id, name, slug) values ($1, $2, 'Existing', 'existing')", [site, org]);
        for (const [type, slug, entryPath] of [["page", "about", "/about"], ["page", "team", "/about/team"], ["post", "hello", "/blog/hello"]]) {
          await db.query("insert into entries (id, organization_id, site_id, type, locale, slug, path) values ($1, $2, $3, $4, 'en', $5, $6)", [uuidv7(), org, site, type, slug, entryPath]);
        }
        // Under the old rule `/` is refused.
        await expect(db.query("insert into entries (id, organization_id, site_id, type, locale, slug, path) values ($1, $2, $3, 'page', 'en', 'home', '/')", [uuidv7(), org, site])).rejects.toMatchObject({
          code: PG.checkViolation, constraint: "entries_path_format",
        });
        const rowsBefore = (await db.query("select row_to_json(e)::text as row from entries e order by path")).rows;

        await runMigrations(ownerUrl(database));
        const applied = async () => (await db.query("select count(*)::int as n from drizzle.__drizzle_migrations")).rows[0].n;
        expect(await applied()).toBe(journal.entries.length);
        expect((await db.query("select row_to_json(e)::text as row from entries e order by path")).rows).toEqual(rowsBefore);

        await db.query("insert into entries (id, organization_id, site_id, type, locale, slug, path) values ($1, $2, $3, 'page', 'en', 'home', '/')", [uuidv7(), org, site]);
        await expect(db.query("insert into entries (id, organization_id, site_id, type, locale, slug, path) values ($1, $2, $3, 'page', 'en', 'again', '/')", [uuidv7(), org, site])).rejects.toMatchObject({
          code: PG.uniqueViolation, constraint: "entries_site_locale_path_unique",
        });
        await expect(db.query("insert into entries (id, organization_id, site_id, type, locale, slug, path) values ($1, $2, $3, 'page', 'en', 'x', '/x/')", [uuidv7(), org, site])).rejects.toMatchObject({
          code: PG.checkViolation, constraint: "entries_path_format",
        });

        await runMigrations(ownerUrl(database));
        expect(await applied()).toBe(journal.entries.length);
      } finally {
        await db.end();
      }
    } finally {
      await admin.query(`drop database if exists "${database}" with (force)`);
      await admin.end();
      await rm(folder, { recursive: true, force: true });
    }
  });
});

describe("inserting an entry under a free slug", () => {
  const place = (over: Partial<SlugPlace> = {}): SlugPlace => ({ type: "page", locale: "en", dir: "", base: "about", blogPath: "blog", ...over });
  /** Inserts a draft page at the slug and path the helper chose. */
  const page = (ctx: SiteContext, values: Partial<typeof t.entries.$inferInsert> = {}) => (tx: TenantTx, slug: string, entryPath: string) =>
    tx.insert(t.entries).values(entryRow(ctx, { slug, path: entryPath, ...values })).returning({ id: t.entries.id });
  const insert = (ctx: SiteContext, where: SlugPlace, values: Partial<typeof t.entries.$inferInsert> = {}) =>
    inTenant(ctx, (tx) => insertWithUniqueSlug(tx, ctx, where, page(ctx, values)));

  it("the slug itself when it is free; then base-2, base-3; a gap is reused", async () => {
    const ctx = await siteIn(await newTenant());
    expect((await insert(ctx, place())).path).toBe("/about");
    expect((await insert(ctx, place())).path).toBe("/about-2");
    expect((await insert(ctx, place())).path).toBe("/about-3");
    await inTenant(ctx, (tx) => tx.delete(t.entries).where(and(eq(t.entries.siteId, ctx.site.id), eq(t.entries.path, "/about-2"))));
    expect(await insert(ctx, place())).toMatchObject({ slug: "about-2", path: "/about-2" });
  });

  it("free is where the entry will live: another directory, locale, site or organization, and the trash, do not count", async () => {
    const tenant = await newTenant();
    const ctx = await siteIn(tenant);
    await addEntry(ctx, { slug: "team", path: "/team" });
    await addEntry(ctx, { slug: "about", path: "/about" });
    await addEntry(ctx, { slug: "careers", path: "/careers" });
    await addEntry(ctx, { slug: "team", path: "/about/team" });
    expect((await insert(ctx, place({ dir: "/careers", base: "team" }))).path).toBe("/careers/team");
    expect((await insert(ctx, place({ dir: "/about", base: "team" }))).path).toBe("/about/team-2");
    expect((await insert(ctx, place({ base: "team", locale: "fil" }), { locale: "fil" })).path).toBe("/team");

    const trashed = await addEntry(ctx, { slug: "gone", path: "/gone" });
    await inTenant(ctx, (tx) => tx.update(t.entries).set({ deletedAt: new Date() }).where(eq(t.entries.id, trashed.id)));
    expect((await insert(ctx, place({ base: "gone" }))).path).toBe("/gone");

    // Another site of the same organization, and another organization, each with a /news: this site's own /news is still free.
    const sibling = await siteIn(tenant);
    const other = await siteIn(await newTenant());
    await addEntry(sibling, { slug: "news", path: "/news" });
    await addEntry(other, { slug: "news", path: "/news" });
    expect((await insert(ctx, place({ base: "news" }))).path).toBe("/news");
    expect(await pathsOf(sibling)).toEqual(["/news"]);
    expect(await pathsOf(other)).toEqual(["/news"]);
  });

  it("reserved paths are passed over: a top-level page never takes the blog's path; elsewhere the same slug is fine", async () => {
    const ctx = await siteIn(await newTenant());
    expect((await insert(ctx, place({ base: "blog" }))).path).toBe("/blog-2");
    await addEntry(ctx, { slug: "about", path: "/about" });
    expect((await insert(ctx, place({ base: "blog", dir: "/about" }))).path).toBe("/about/blog");
    expect((await insert(ctx, place({ base: "blog", blogPath: "news" }))).path).toBe("/blog");
    expect((await insert(ctx, place({ base: "news", blogPath: "news" }))).path).toBe("/news-2");
    const post = await inTenant(ctx, (tx) => insertWithUniqueSlug(tx, ctx, place({ type: "post", base: "hello", dir: "/blog" }), page(ctx, { type: "post" })));
    expect(post.path).toBe("/blog/hello");
  });

  it("six transactions creating `untitled` at once: all succeed, each with its own slug", async () => {
    const ctx = await siteIn(await newTenant());
    const create = () =>
      inTenant(ctx, async (tx) => {
        const created = await insertWithUniqueSlug(tx, ctx, place({ base: "untitled" }), page(ctx));
        await tx.execute(sql`select pg_sleep(0.2)`); // hold the transaction open, so the others collide with it
        return created.slug;
      });
    const slugs = await Promise.all(Array.from({ length: 6 }, create));
    expect([...slugs].sort()).toEqual(["untitled", "untitled-2", "untitled-3", "untitled-4", "untitled-5", "untitled-6"]);
    expect(await pathsOf(ctx)).toEqual(["/untitled", "/untitled-2", "/untitled-3", "/untitled-4", "/untitled-5", "/untitled-6"]);
  });

  it("a title at the longest slug, used many times: every copy finds a free slug at once, without spending its retries", async () => {
    const ctx = await siteIn(await newTenant());
    const long = "a".repeat(100);
    let attempts = 0;
    for (let i = 0; i < MAX_SLUG_ATTEMPTS + 3; i++) {
      await inTenant(ctx, (tx) =>
        insertWithUniqueSlug(tx, ctx, place({ base: long }), (savepoint, slug, entryPath) => {
          attempts++;
          return page(ctx)(savepoint, slug, entryPath);
        }),
      );
    }
    expect(attempts).toBe(MAX_SLUG_ATTEMPTS + 3);
    const paths = await pathsOf(ctx);
    expect(paths).toHaveLength(MAX_SLUG_ATTEMPTS + 3);
    for (const p of paths) expect(p.length, p).toBeLessThanOrEqual(101);
    expect(paths).toContain(`/${"a".repeat(97)}-13`);
  });

  it("a lost race undoes only its own attempt: the rest of the transaction stays, and the next slug is used", async () => {
    const ctx = await siteIn(await newTenant());
    await addEntry(ctx, { slug: "taken-elsewhere", path: "/taken-elsewhere" });
    let calls = 0;
    const result = await inTenant(ctx, async (tx) => {
      await tx.insert(t.entries).values(entryRow(ctx, { slug: "before", path: "/before" }));
      return insertWithUniqueSlug(tx, ctx, place({ base: "fresh" }), async (savepoint, slug, entryPath) => {
        calls++;
        await savepoint.insert(t.entries).values(entryRow(ctx, { slug, path: entryPath }));
        // The first attempt collides with a path another writer holds (here: one that exists), as if it had been taken meanwhile.
        if (calls === 1) await savepoint.insert(t.entries).values(entryRow(ctx, { slug: "taken-elsewhere", path: "/taken-elsewhere" }));
        return slug;
      });
    });
    expect(calls).toBe(2);
    expect(result).toMatchObject({ slug: "fresh-2", path: "/fresh-2", result: "fresh-2" });
    expect(await pathsOf(ctx)).toEqual(["/before", "/fresh-2", "/taken-elsewhere"]);
  });

  it("a race lost every time ends in a Conflict after a bounded number of attempts, with nothing written", async () => {
    const ctx = await siteIn(await newTenant());
    await addEntry(ctx, { slug: "occupied", path: "/occupied" });
    let calls = 0;
    const refused = await refusalOf(() =>
      inTenant(ctx, (tx) =>
        insertWithUniqueSlug(tx, ctx, place({ base: "doomed" }), async (savepoint) => {
          calls++;
          await savepoint.insert(t.entries).values(entryRow(ctx, { slug: "occupied", path: "/occupied" }));
        }),
      ),
    );
    expect(refused).toMatchObject({ kind: "Conflict", message: "Another change took this address at the same moment. Try again." });
    expect(calls).toBe(MAX_SLUG_ATTEMPTS);
    expect(await pathsOf(ctx)).toEqual(["/occupied"]);
  });

  it("any other failure is not retried: it is the caller's error, once", async () => {
    const ctx = await siteIn(await newTenant());
    let calls = 0;
    const error = await dbError(
      inTenant(ctx, (tx) =>
        insertWithUniqueSlug(tx, ctx, place({ base: "broken" }), async (savepoint, slug, entryPath) => {
          calls++;
          // Published without a revision: the CHECK refuses it.
          await savepoint.insert(t.entries).values(entryRow(ctx, { slug, path: entryPath, status: "published" }));
        }),
      ),
    );
    expect(error).toMatchObject({ code: PG.checkViolation, constraint: "entries_published_has_revision" });
    expect(calls).toBe(1);
  });

  it("refuses a base that is not a slug or a directory that is not a path, before reading or writing anything", async () => {
    const ctx = await siteIn(await newTenant());
    for (const bad of [place({ base: "Not A Slug" }), place({ base: "" }), place({ base: "a/b" }), place({ dir: "about" }), place({ dir: "/about/" })]) {
      await expect(insert(ctx, bad), JSON.stringify(bad)).rejects.toThrow(/^Not a (slug|path)/);
    }
    expect(await pathsOf(ctx)).toEqual([]);
  });

  it("only the context's site is read and written: no id from the caller says where", async () => {
    const tenant = await newTenant();
    const mine = await siteIn(tenant);
    const sibling = await siteIn(tenant);
    await addEntry(sibling, { slug: "contact", path: "/contact" });
    // The insert names the context's own site; the read before it looked at that site only.
    expect((await insert(mine, place({ base: "contact" }))).path).toBe("/contact");
    expect(await pathsOf(mine)).toEqual(["/contact"]);
    expect(await pathsOf(sibling)).toEqual(["/contact"]);
  });
});
