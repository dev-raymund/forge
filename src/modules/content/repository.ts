import "server-only";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PlatformTx, TenantTx } from "@/platform/db";
import * as t from "@/platform/db/schema";
import { readReading } from "@/modules/sites/shared";
import { entries, entryDrafts, entryRevisions, entryTerms, terms } from "./schema";

/**
 * The content module's queries (M5-3). Every function takes the organization
 * and the site from the caller's context and names both: RLS separates
 * organizations, and only these filters keep one site's content from
 * another's within an organization.
 *
 * Two tables of other modules are read or written here, through the schema
 * barrel, as the sites module reads `entries` for its checklist: `sites` and
 * `site_settings` (the site's language, its blog path, and the homepage
 * reference, which only the content services set), and `organization_members`
 * (is an author a member?).
 */

export type EntryRow = typeof entries.$inferSelect;
export type DraftRow = typeof entryDrafts.$inferSelect;

const ofSite = (organizationId: string, siteId: string) => and(eq(entries.organizationId, organizationId), eq(entries.siteId, siteId));

/** The site is not deleted (sites are soft-deleted, ADR 0011): a context resolved just before the deletion reaches nothing of it. */
const siteIsLive = sql`exists (select 1 from ${t.sites} s where s.id = ${entries.siteId} and s.organization_id = ${entries.organizationId} and s.deleted_at is null)`;

/**
 * An entry of the site that is not in the trash, of a site that is not deleted; locked until the transaction ends when
 * asked (`lock`), or share-locked (`share`: it cannot be trashed or changed under the caller, M7-1).
 */
export async function findEntry(tx: TenantTx, organizationId: string, siteId: string, entryId: string, options: { lock?: boolean; share?: boolean } = {}): Promise<EntryRow | null> {
  const query = tx.select().from(entries).where(and(ofSite(organizationId, siteId), eq(entries.id, entryId), isNull(entries.deletedAt), siteIsLive));
  const [row] = options.lock ? await query.for("update") : options.share ? await query.for("share") : await query;
  return row ?? null;
}

/** The entry at a path in the site and locale (not in the trash), locked. */
export async function entryAtPath(tx: TenantTx, organizationId: string, siteId: string, locale: string, path: string): Promise<EntryRow | null> {
  const [row] = await tx
    .select()
    .from(entries)
    .where(and(ofSite(organizationId, siteId), eq(entries.locale, locale), eq(entries.path, path), isNull(entries.deletedAt)))
    .for("update");
  return row ?? null;
}

export async function findDraft(tx: TenantTx, organizationId: string, siteId: string, entryId: string, options: { lock?: boolean } = {}): Promise<DraftRow | null> {
  const query = tx
    .select()
    .from(entryDrafts)
    .where(and(eq(entryDrafts.organizationId, organizationId), eq(entryDrafts.siteId, siteId), eq(entryDrafts.entryId, entryId)));
  const [row] = options.lock ? await query.for("update") : await query;
  return row ?? null;
}

/** What the entry services need of the site: its language (new entries') and its blog path (posts', and the path pages may not take). */
export async function siteFacts(tx: TenantTx, organizationId: string, siteId: string): Promise<{ name: string; locale: string; blogPath: string } | null> {
  const [row] = await tx
    .select({ name: t.sites.name, locale: t.sites.defaultLocale, reading: t.siteSettings.reading })
    .from(t.sites)
    .innerJoin(t.siteSettings, and(eq(t.siteSettings.organizationId, t.sites.organizationId), eq(t.siteSettings.siteId, t.sites.id)))
    .where(and(eq(t.sites.organizationId, organizationId), eq(t.sites.id, siteId), isNull(t.sites.deletedAt)));
  return row ? { name: row.name, locale: row.locale, blogPath: readReading(row.reading).blogPath } : null;
}

/** Is the user a member of the organization? (V1 memberships are organization-wide: plan §13.) */
export async function isMember(tx: TenantTx, organizationId: string, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: t.organizationMembers.id })
    .from(t.organizationMembers)
    .where(and(eq(t.organizationMembers.organizationId, organizationId), eq(t.organizationMembers.userId, userId)));
  return Boolean(row);
}

/**
 * The terms of the site among these ids (anything of another site, or that does not exist, is simply not returned),
 * share-locked until the transaction ends (M5-8): a term being deleted is waited for, then not found, and a term
 * found here cannot be deleted before the draft or the publish that names it has committed. The caller has locked
 * the draft first (the order of term.repository.ts).
 */
export async function termsOfSite(tx: TenantTx, organizationId: string, siteId: string, ids: readonly string[]): Promise<{ id: string; taxonomy: string }[]> {
  if (ids.length === 0) return [];
  return tx
    .select({ id: terms.id, taxonomy: terms.taxonomy })
    .from(terms)
    .where(and(eq(terms.organizationId, organizationId), eq(terms.siteId, siteId), inArray(terms.id, [...ids])))
    .for("share");
}

/** How deep a chain of pages is followed before it is called a loop. */
const MAX_DEPTH = 200;

export type TreeRow = { id: string; parentId: string | null; slug: string; path: string; type: string; status: string; title: string; depth: number };

/** A page and every page above it in the site (in no order; parentChain orders them and finds loops). Trashed pages are included: a trashed parent must be noticed. */
export async function ancestorsOf(tx: TenantTx, organizationId: string, siteId: string, entryId: string): Promise<(TreeRow & { deleted: boolean })[]> {
  const { rows } = await tx.execute<{ id: string; parent_id: string | null; slug: string; path: string; type: string; status: string; title: string; depth: number; deleted: boolean }>(sql`
    with recursive chain (id, parent_id, slug, path, type, status, title, deleted, depth) as (
      select id, parent_id, slug, path, type, status, title, deleted_at is not null, 1
        from entries where organization_id = ${organizationId} and site_id = ${siteId} and id = ${entryId}
      union all
      select e.id, e.parent_id, e.slug, e.path, e.type, e.status, e.title, e.deleted_at is not null, c.depth + 1
        from entries e join chain c on e.id = c.parent_id
       where e.organization_id = ${organizationId} and e.site_id = ${siteId} and c.depth < ${MAX_DEPTH}
    )
    select * from chain`);
  return rows.map((row) => ({ id: row.id, parentId: row.parent_id, slug: row.slug, path: row.path, type: row.type, status: row.status, title: row.title, deleted: row.deleted, depth: row.depth }));
}

/** Every page below one (not in the trash), shallowest first, each once. */
export async function descendantsOf(tx: TenantTx, organizationId: string, siteId: string, rootId: string): Promise<TreeRow[]> {
  const { rows } = await tx.execute<{ id: string; parent_id: string | null; slug: string; path: string; type: string; status: string; title: string; depth: number }>(sql`
    with recursive tree (id, parent_id, slug, path, type, status, title, depth) as (
      select id, parent_id, slug, path, type, status, title, 1
        from entries where organization_id = ${organizationId} and site_id = ${siteId} and parent_id = ${rootId} and deleted_at is null
      union all
      select e.id, e.parent_id, e.slug, e.path, e.type, e.status, e.title, t.depth + 1
        from entries e join tree t on e.parent_id = t.id
       where e.organization_id = ${organizationId} and e.site_id = ${siteId} and e.deleted_at is null and t.depth < ${MAX_DEPTH}
    )
    select distinct on (id) * from tree where id <> ${rootId} order by id, depth`);
  return rows
    .map((row) => ({ id: row.id, parentId: row.parent_id, slug: row.slug, path: row.path, type: row.type, status: row.status, title: row.title, depth: row.depth }))
    .sort((a, b) => a.depth - b.depth);
}

export async function insertEntry(tx: TenantTx, values: typeof entries.$inferInsert): Promise<EntryRow> {
  const [row] = await tx.insert(entries).values(values).returning();
  if (!row) throw new Error("The entry was not inserted");
  return row;
}

export async function insertDraft(tx: TenantTx, values: typeof entryDrafts.$inferInsert): Promise<void> {
  await tx.insert(entryDrafts).values(values);
}

/** Writes the draft only if it is still at `expectedVersion`, and moves it to the next one. Null when it was not. */
export async function updateDraftIfVersion(
  tx: TenantTx,
  organizationId: string,
  siteId: string,
  entryId: string,
  expectedVersion: number,
  values: Partial<Omit<typeof entryDrafts.$inferInsert, "entryId" | "organizationId" | "siteId" | "version">>,
): Promise<number | null> {
  const [row] = await tx
    .update(entryDrafts)
    .set({ ...values, version: sql`${entryDrafts.version} + 1`, updatedAt: new Date() })
    .where(
      and(
        eq(entryDrafts.organizationId, organizationId),
        eq(entryDrafts.siteId, siteId),
        eq(entryDrafts.entryId, entryId),
        eq(entryDrafts.version, expectedVersion),
      ),
    )
    .returning({ version: entryDrafts.version });
  return row?.version ?? null;
}

/** The draft's slug, where it still equals `previous` (a page moved off `/` that had to take a suffix). */
export async function renameDraftSlug(tx: TenantTx, organizationId: string, siteId: string, entryId: string, previous: string, slug: string): Promise<void> {
  await tx
    .update(entryDrafts)
    .set({ slug })
    .where(and(eq(entryDrafts.organizationId, organizationId), eq(entryDrafts.siteId, siteId), eq(entryDrafts.entryId, entryId), eq(entryDrafts.slug, previous)));
}

export async function revisionById(tx: TenantTx, organizationId: string, siteId: string, entryId: string, revisionId: string) {
  const [row] = await tx
    .select({ id: entryRevisions.id, number: entryRevisions.number, sourceDraftVersion: entryRevisions.sourceDraftVersion })
    .from(entryRevisions)
    .where(
      and(eq(entryRevisions.organizationId, organizationId), eq(entryRevisions.siteId, siteId), eq(entryRevisions.entryId, entryId), eq(entryRevisions.id, revisionId)),
    );
  return row ?? null;
}

/** The entry's next revision number. Called under the entry's lock, so two publishes cannot take the same one. */
export async function nextRevisionNumber(tx: TenantTx, organizationId: string, siteId: string, entryId: string): Promise<number> {
  const [row] = await tx
    .select({ number: entryRevisions.number })
    .from(entryRevisions)
    .where(and(eq(entryRevisions.organizationId, organizationId), eq(entryRevisions.siteId, siteId), eq(entryRevisions.entryId, entryId)))
    .orderBy(desc(entryRevisions.number))
    .limit(1);
  return (row?.number ?? 0) + 1;
}

export async function insertRevision(tx: TenantTx, values: typeof entryRevisions.$inferInsert) {
  const [row] = await tx.insert(entryRevisions).values(values).returning({ id: entryRevisions.id, number: entryRevisions.number });
  if (!row) throw new Error("The revision was not inserted");
  return row;
}

export async function updateEntry(
  tx: TenantTx,
  organizationId: string,
  siteId: string,
  entryId: string,
  values: Partial<Omit<typeof entries.$inferInsert, "id" | "organizationId" | "siteId">>,
): Promise<void> {
  await tx
    .update(entries)
    .set({ ...values, updatedAt: new Date() })
    .where(and(ofSite(organizationId, siteId), eq(entries.id, entryId)));
}

/** The published term assignments become exactly these (plan §5: drafts keep theirs in `entry_drafts.term_ids`). */
export async function replaceEntryTerms(tx: TenantTx, organizationId: string, siteId: string, entryId: string, termIds: readonly string[]): Promise<void> {
  await tx.delete(entryTerms).where(and(eq(entryTerms.organizationId, organizationId), eq(entryTerms.siteId, siteId), eq(entryTerms.entryId, entryId)));
  if (termIds.length) await tx.insert(entryTerms).values(termIds.map((termId) => ({ organizationId, siteId, entryId, termId })));
}

/** The site's settings row, locked: two homepage changes of one site take turns. */
export async function lockSiteSettings(tx: TenantTx, organizationId: string, siteId: string): Promise<{ homepageEntryId: string | null } | null> {
  const [row] = await tx
    .select({ homepageEntryId: t.siteSettings.homepageEntryId })
    .from(t.siteSettings)
    .where(and(eq(t.siteSettings.organizationId, organizationId), eq(t.siteSettings.siteId, siteId)))
    .for("update");
  return row ?? null;
}

/** `site_settings.homepage_entry_id`. Not the settings' `version`: no settings form holds the homepage, so none should be told it is stale. */
export async function setHomepageEntry(tx: TenantTx, organizationId: string, siteId: string, entryId: string): Promise<void> {
  await tx
    .update(t.siteSettings)
    .set({ homepageEntryId: entryId })
    .where(and(eq(t.siteSettings.organizationId, organizationId), eq(t.siteSettings.siteId, siteId)));
}

// ── M5-7: the page tree's order, and authors ─────────────────────────────────

/** The name of a member of the organization, or null when the user is not one (V1 memberships are organization-wide). */
export async function memberName(tx: TenantTx, organizationId: string, userId: string): Promise<string | null> {
  const [row] = await tx
    .select({ name: t.users.name })
    .from(t.organizationMembers)
    .innerJoin(t.users, eq(t.users.id, t.organizationMembers.userId))
    .where(and(eq(t.organizationMembers.organizationId, organizationId), eq(t.organizationMembers.userId, userId)));
  return row ? row.name : null;
}

/** The pages under one parent (null: the top level), not in the trash, in their order. */
export async function siblingsOf(tx: TenantTx, organizationId: string, siteId: string, parentId: string | null): Promise<{ id: string; sortOrder: number }[]> {
  return tx
    .select({ id: entries.id, sortOrder: entries.sortOrder })
    .from(entries)
    .where(
      and(ofSite(organizationId, siteId), eq(entries.type, "page"), isNull(entries.deletedAt), parentId ? eq(entries.parentId, parentId) : isNull(entries.parentId)),
    )
    .orderBy(entries.sortOrder, entries.title, entries.id);
}

/** Puts pages in this order under their parent: 0, 1, 2, … Only the rows whose place changes are written. */
export async function setSortOrders(tx: TenantTx, organizationId: string, siteId: string, ordered: readonly { id: string; sortOrder: number }[]): Promise<void> {
  for (const [index, page] of ordered.entries()) {
    if (page.sortOrder === index) continue;
    await tx.update(entries).set({ sortOrder: index }).where(and(ofSite(organizationId, siteId), eq(entries.id, page.id)));
  }
}


// ── M7-1: unpublish, the trash, restore, purge ───────────────────────────────

/**
 * An entry of the site that is in the trash (of a site that is not deleted), locked, with whether it has been there
 * longer than `days` by the database's clock: past that it is `trash.purge`'s, and is not restored.
 */
export async function findTrashedEntry(tx: TenantTx, organizationId: string, siteId: string, entryId: string, days: number): Promise<(EntryRow & { expired: boolean }) | null> {
  const [row] = await tx
    .select({ entry: entries, expired: sql<boolean>`${entries.deletedAt} < now() - make_interval(days => ${days})` })
    .from(entries)
    .where(and(ofSite(organizationId, siteId), eq(entries.id, entryId), sql`${entries.deletedAt} is not null`, siteIsLive))
    .for("update");
  return row ? { ...row.entry, expired: row.expired } : null;
}

/** Locks these entries of the site (in the trash or not) and returns them: the caller then reads them as they now are. */
export async function lockEntries(tx: TenantTx, organizationId: string, siteId: string, ids: readonly string[]): Promise<EntryRow[]> {
  if (!ids.length) return [];
  return tx.select().from(entries).where(and(ofSite(organizationId, siteId), inArray(entries.id, [...ids]))).orderBy(entries.id).for("update");
}

/**
 * Into the trash, all at one moment: `deleted_at` is one `clock_timestamp()` for every row (a CTE is evaluated once),
 * so the pages trashed together can be found together again (`trashedWith`). Only rows not already in the trash.
 */
export async function moveToTrash(tx: TenantTx, organizationId: string, siteId: string, ids: readonly string[], userId: string): Promise<number> {
  if (!ids.length) return 0;
  const { rows } = await tx.execute<{ id: string }>(sql`
    with moment as (select clock_timestamp() as at)
    update entries e set deleted_at = moment.at, updated_at = moment.at, updated_by = ${userId}
      from moment
     where e.organization_id = ${organizationId} and e.site_id = ${siteId} and e.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
       and e.deleted_at is null
    returning e.id`);
  return rows.length;
}

export type TrashedRow = TreeRow & { locale: string; authorId: string | null };

/**
 * A trashed entry and the pages trashed with it, below it: those whose `deleted_at` is the very same moment (one trash,
 * ./lifecycle.service.ts). A page trashed on its own before is not one of them: it stays in the trash. Shallowest first.
 */
export async function trashedWith(tx: TenantTx, organizationId: string, siteId: string, rootId: string): Promise<TrashedRow[]> {
  const { rows } = await tx.execute<{
    id: string; parent_id: string | null; slug: string; path: string; type: string; status: string; title: string; depth: number; locale: string; author_id: string | null;
  }>(sql`
    with recursive root as (
      select deleted_at from entries where organization_id = ${organizationId} and site_id = ${siteId} and id = ${rootId} and deleted_at is not null
    ), together (id, parent_id, slug, path, type, status, title, locale, author_id, depth) as (
      select id, parent_id, slug, path, type, status, title, locale, author_id, 0
        from entries where organization_id = ${organizationId} and site_id = ${siteId} and id = ${rootId} and deleted_at is not null
      union all
      select e.id, e.parent_id, e.slug, e.path, e.type, e.status, e.title, e.locale, e.author_id, t.depth + 1
        from entries e join together t on e.parent_id = t.id, root
       where e.organization_id = ${organizationId} and e.site_id = ${siteId} and e.deleted_at = root.deleted_at and t.depth < ${MAX_DEPTH}
    )
    select distinct on (id) * from together order by id, depth`);
  return rows
    .map((row) => ({
      id: row.id, parentId: row.parent_id, slug: row.slug, path: row.path, type: row.type, status: row.status, title: row.title, depth: row.depth, locale: row.locale,
      authorId: row.author_id,
    }))
    .sort((a, b) => a.depth - b.depth);
}

/** Every entry below one, in the trash or not, with whether it is: a page in the trash never has live pages below it. */
export async function everythingBelow(tx: TenantTx, organizationId: string, siteId: string, rootId: string): Promise<{ id: string; title: string; trashed: boolean }[]> {
  const { rows } = await tx.execute<{ id: string; title: string; trashed: boolean }>(sql`
    with recursive tree (id, title, trashed, depth) as (
      select id, title, deleted_at is not null, 1 from entries where organization_id = ${organizationId} and site_id = ${siteId} and parent_id = ${rootId}
      union all
      select e.id, e.title, e.deleted_at is not null, t.depth + 1
        from entries e join tree t on e.parent_id = t.id
       where e.organization_id = ${organizationId} and e.site_id = ${siteId} and t.depth < ${MAX_DEPTH}
    )
    select distinct on (id) id, title, trashed from tree where id <> ${rootId} order by id`);
  return rows;
}

/** Entries of the site and locale that are not in the trash and hold one of these paths. */
export async function holdersOf(tx: TenantTx, organizationId: string, siteId: string, locale: string, paths: readonly string[]): Promise<{ id: string; path: string; title: string }[]> {
  if (!paths.length) return [];
  return tx
    .select({ id: entries.id, path: entries.path, title: entries.title })
    .from(entries)
    .where(and(ofSite(organizationId, siteId), eq(entries.locale, locale), inArray(entries.path, [...paths]), isNull(entries.deletedAt)));
}

/** Out of the trash, as a draft (it was one when it went in: published and scheduled entries are never trashed), at `path`. */
export async function restoreRow(tx: TenantTx, organizationId: string, siteId: string, entryId: string, path: string, userId: string): Promise<void> {
  await tx
    .update(entries)
    .set({ deletedAt: null, status: "draft", scheduledAt: null, path, updatedBy: userId, updatedAt: new Date() })
    .where(and(ofSite(organizationId, siteId), eq(entries.id, entryId), sql`${entries.deletedAt} is not null`));
}

/**
 * Deletes these trashed entries for good. Their drafts, revisions and published term links go with them (the foreign
 * keys cascade); media they used is not touched. Only rows still in the trash, and (when given) trashed before `before`.
 */
export async function deleteTrashed(tx: TenantTx, organizationId: string, siteId: string, ids: readonly string[], before?: Date): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await tx
    .delete(entries)
    .where(
      and(
        eq(entries.organizationId, organizationId), eq(entries.siteId, siteId), inArray(entries.id, [...ids]), sql`${entries.deletedAt} is not null`,
        before ? sql`${entries.deletedAt} < ${before.toISOString()}::timestamptz` : undefined,
      ),
    )
    .returning({ id: entries.id });
  return rows.map((row) => row.id);
}

// The daily purge (./purge.ts): which organizations, which sites, which rows.

/** Organizations with entries in the trash since before `before`: ids only, through a SECURITY DEFINER lookup (migration 0013). */
export async function organizationsWithPurgeableEntries(tx: PlatformTx, before: Date, limit: number): Promise<string[]> {
  const { rows } = await tx.execute<{ organization_id: string }>(sql`select organization_id from organizations_with_purgeable_entries(${before.toISOString()}::timestamptz, ${limit})`);
  return rows.map((row) => row.organization_id);
}

/** The organization's sites with entries due to be purged. */
export async function sitesWithPurgeableEntries(tx: TenantTx, organizationId: string, before: Date): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ siteId: entries.siteId })
    .from(entries)
    .where(and(eq(entries.organizationId, organizationId), sql`${entries.deletedAt} is not null`, sql`${entries.deletedAt} < ${before.toISOString()}::timestamptz`));
  return rows.map((row) => row.siteId);
}

/** A batch of the site's entries due to be purged, oldest in the trash first, locked. */
export async function purgeCandidates(tx: TenantTx, organizationId: string, siteId: string, before: Date, limit: number): Promise<{ id: string; parentId: string | null }[]> {
  return tx
    .select({ id: entries.id, parentId: entries.parentId })
    .from(entries)
    .where(and(eq(entries.organizationId, organizationId), eq(entries.siteId, siteId), sql`${entries.deletedAt} is not null`, sql`${entries.deletedAt} < ${before.toISOString()}::timestamptz`))
    .orderBy(entries.deletedAt, entries.id)
    .limit(limit)
    .for("update");
}

/** The entries directly below any of these, with whether each is in the trash, and in it since before `before` (due). */
export async function childrenOf(
  tx: TenantTx, organizationId: string, siteId: string, parentIds: readonly string[], before: Date,
): Promise<{ id: string; parentId: string; trashed: boolean; due: boolean }[]> {
  if (!parentIds.length) return [];
  const rows = await tx
    .select({
      id: entries.id, parentId: entries.parentId, trashed: sql<boolean>`${entries.deletedAt} is not null`,
      due: sql<boolean>`coalesce(${entries.deletedAt} < ${before.toISOString()}::timestamptz, false)`,
    })
    .from(entries)
    .where(and(eq(entries.organizationId, organizationId), eq(entries.siteId, siteId), inArray(entries.parentId, [...parentIds])));
  return rows.map((row) => ({ id: row.id, parentId: row.parentId!, trashed: row.trashed, due: row.due }));
}
