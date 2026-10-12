import { uuidv7 } from "uuidv7";
import { inTenant } from "./sites";

/** Content as the database holds it (M5-4), read inside the organization's context. */

export type DraftRecord = { title: string; slug: string; version: number; content: { v: number; doc: { type: string; content?: unknown[] } } };
export type EntryRecord = { id: string; type: string; status: string; path: string; title: string };

export async function homePageOf(orgId: string, siteId: string): Promise<string | null> {
  const { rows } = await inTenant(orgId, (c) => c.query<{ id: string | null }>("select homepage_entry_id as id from site_settings where site_id = $1", [siteId]));
  return rows[0]?.id ?? null;
}

export async function draftOf(orgId: string, entryId: string): Promise<DraftRecord> {
  const { rows } = await inTenant(orgId, (c) => c.query<DraftRecord>("select title, slug, version, content from entry_drafts where entry_id = $1", [entryId]));
  return rows[0]!;
}

export async function entryOf(orgId: string, entryId: string): Promise<EntryRecord & { revisions: number }> {
  const { rows } = await inTenant(orgId, (c) =>
    c.query<EntryRecord & { revisions: number }>(
      "select id, type, status, path, title, (select count(*)::int from entry_revisions r where r.entry_id = e.id) as revisions from entries e where id = $1",
      [entryId],
    ),
  );
  return rows[0]!;
}

/** A draft entry made behind the app's back, as M5-7's forms will make them: the row and its draft (an empty paragraph). */
export async function seedEntry(
  orgId: string,
  siteId: string,
  entry: { id: string; type: "page" | "post"; title: string; slug: string; path: string; paragraphId: string; extraBlocks?: unknown[] },
) {
  await inTenant(orgId, async (c) => {
    await c.query("insert into entries (id, organization_id, site_id, type, locale, title, slug, path) values ($1, $2, $3, $4, 'en', $5, $6, $7)", [
      entry.id, orgId, siteId, entry.type, entry.title, entry.slug, entry.path,
    ]);
    const content = { v: 1, doc: { type: "doc", content: [{ type: "paragraph", attrs: { id: entry.paragraphId } }, ...(entry.extraBlocks ?? [])] } };
    await c.query("insert into entry_drafts (entry_id, organization_id, site_id, title, slug, content) values ($1, $2, $3, $4, $5, $6)", [
      entry.id, orgId, siteId, entry.title, entry.slug, JSON.stringify(content),
    ]);
  });
}

/** Removes the site's Home page, as a site made before M5-3 is. */
export async function removeHomePage(orgId: string, siteId: string) {
  await inTenant(orgId, (c) => c.query("delete from entries where site_id = $1 and path = '/'", [siteId]));
}

// ── M5-6: published content, written as the database holds it ───────────────

export type PublishedSeed = {
  id: string;
  type: "page" | "post";
  title: string;
  slug: string;
  path: string;
  content: unknown;
  parentId?: string | null;
  template?: string | null;
  excerpt?: string;
  termIds?: string[];
  /** When it was published (lists are newest first). */
  publishedAt?: Date;
  /** Left as a draft: the row and its draft, never published. */
  draftOnly?: boolean;
};

/**
 * A published entry made behind the app's back: the entry, its draft, a `publish` revision holding `content` as it
 * is (no validation: hostile documents included), and its published terms. As `publishEntry` leaves them.
 */
export async function seedPublishedEntry(orgId: string, siteId: string, seed: PublishedSeed) {
  await inTenant(orgId, async (c) => {
    await c.query(
      "insert into entries (id, organization_id, site_id, type, locale, parent_id, title, slug, path, excerpt) values ($1, $2, $3, $4, 'en', $5, $6, $7, $8, $9)",
      [seed.id, orgId, siteId, seed.type, seed.parentId ?? null, seed.title, seed.slug, seed.path, seed.excerpt ?? ""],
    );
    await c.query("insert into entry_drafts (entry_id, organization_id, site_id, title, slug, template, content, term_ids) values ($1, $2, $3, $4, $5, $6, $7, $8)", [
      seed.id, orgId, siteId, seed.title, seed.slug, seed.template ?? null, JSON.stringify(seed.content), seed.termIds ?? [],
    ]);
    if (seed.draftOnly) return;
    const revisionId = uuidv7();
    await c.query(
      `insert into entry_revisions (id, organization_id, site_id, entry_id, number, kind, title, slug, excerpt, template, content, term_ids, content_hash, source_draft_version)
       values ($1, $2, $3, $4, 1, 'publish', $5, $6, $7, $8, $9, $10, '', 1)`,
      [revisionId, orgId, siteId, seed.id, seed.title, seed.slug, seed.excerpt ?? "", seed.template ?? null, JSON.stringify(seed.content), seed.termIds ?? []],
    );
    const at = seed.publishedAt ?? new Date();
    await c.query("update entries set status = 'published', published_revision_id = $1, published_at = $2, first_published_at = $2 where id = $3", [revisionId, at, seed.id]);
    for (const termId of seed.termIds ?? []) {
      await c.query("insert into entry_terms (organization_id, site_id, entry_id, term_id) values ($1, $2, $3, $4)", [orgId, siteId, seed.id, termId]);
    }
  });
}

export async function seedTerm(orgId: string, siteId: string, taxonomy: "category" | "tag", slug: string, name: string, description = "") {
  const id = uuidv7();
  await inTenant(orgId, (c) =>
    c.query("insert into terms (id, organization_id, site_id, taxonomy, name, slug, description) values ($1, $2, $3, $4, $5, $6, $7)", [id, orgId, siteId, taxonomy, name, slug, description]),
  );
  return id;
}

/** Reading and analytics settings, written behind the app's back (the site's cache is fresh: nothing has read it yet). */
export async function seedSiteSettings(orgId: string, siteId: string, settings: { reading?: unknown; analytics?: unknown }) {
  await inTenant(orgId, (c) =>
    c.query("update site_settings set reading = coalesce($1::jsonb, reading), analytics = coalesce($2::jsonb, analytics) where site_id = $3", [
      settings.reading ? JSON.stringify(settings.reading) : null, settings.analytics ? JSON.stringify(settings.analytics) : null, siteId,
    ]),
  );
}

/** Moves a published entry to the trash, as M7-1 will: unpublished first (CHECK `entries_trash_not_live`). */
export async function trashEntry(orgId: string, entryId: string) {
  await inTenant(orgId, (c) => c.query("update entries set status = 'draft', published_revision_id = null, deleted_at = now() where id = $1", [entryId]));
}
