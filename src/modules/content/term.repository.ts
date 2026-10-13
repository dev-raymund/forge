import "server-only";
import { and, asc, eq, like, sql } from "drizzle-orm";
import type { TenantTx } from "@/platform/db";
import { entryDrafts, entryTerms, terms } from "./schema";

/**
 * The terms' queries (M5-8). Every function names the organization and the site: RLS separates organizations, and
 * only these filters keep one site's categories and tags from another's within an organization. The (site_id, id)
 * keys of `entry_terms` and the parent's composite foreign key keep references inside the site as well.
 *
 * Locks, always in this order, so that saving, publishing and deleting a term can never deadlock (ADR 0019):
 * the drafts first (`lockDraftsWithTerm`, or the draft a save or publish is writing), then the term
 * (`findTerm({ lock })` here, `termsOfSite`'s FOR SHARE in ./repository.ts).
 */

export type TermRow = typeof terms.$inferSelect;
export type Taxonomy = TermRow["taxonomy"];

export const TERM_SLUG_KEY = "terms_site_taxonomy_slug_unique";

const ofSite = (organizationId: string, siteId: string) => and(eq(terms.organizationId, organizationId), eq(terms.siteId, siteId));

export async function findTerm(tx: TenantTx, organizationId: string, siteId: string, termId: string, options: { lock?: boolean } = {}): Promise<TermRow | null> {
  const query = tx.select().from(terms).where(and(ofSite(organizationId, siteId), eq(terms.id, termId)));
  const [row] = options.lock ? await query.for("update") : await query;
  return row ?? null;
}

export async function insertTerm(tx: TenantTx, values: typeof terms.$inferInsert): Promise<TermRow> {
  const [row] = await tx.insert(terms).values(values).returning();
  if (!row) throw new Error("The term was not inserted");
  return row;
}

export async function updateTermRow(
  tx: TenantTx, organizationId: string, siteId: string, termId: string, values: Partial<Pick<TermRow, "name" | "slug" | "description" | "parentId">>,
): Promise<void> {
  await tx.update(terms).set({ ...values, updatedAt: new Date() }).where(and(ofSite(organizationId, siteId), eq(terms.id, termId)));
}

/** Deletes the term. Its `entry_terms` go with it (CASCADE), and its subcategories move to the top level (SET NULL). */
export async function deleteTermRow(tx: TenantTx, organizationId: string, siteId: string, termId: string): Promise<void> {
  await tx.delete(terms).where(and(ofSite(organizationId, siteId), eq(terms.id, termId)));
}

/** The slugs of the taxonomy that start like `stem`: a superset of those a generated slug could collide with. */
export async function termSlugsLike(tx: TenantTx, organizationId: string, siteId: string, taxonomy: Taxonomy, stem: string): Promise<string[]> {
  // Slugs hold only [a-z0-9-]: nothing in the pattern is a LIKE wildcard.
  const rows = await tx.select({ slug: terms.slug }).from(terms).where(and(ofSite(organizationId, siteId), eq(terms.taxonomy, taxonomy), like(terms.slug, `${stem}%`)));
  return rows.map((row) => row.slug);
}

/** How many subcategories the category has. */
export async function childCount(tx: TenantTx, organizationId: string, siteId: string, termId: string): Promise<number> {
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(terms).where(and(ofSite(organizationId, siteId), eq(terms.parentId, termId)));
  return row?.n ?? 0;
}

/** The published entries that carry the term (their pages show it, so a change to it flushes them). */
export async function entriesWithTerm(tx: TenantTx, organizationId: string, siteId: string, termId: string): Promise<string[]> {
  const rows = await tx
    .select({ entryId: entryTerms.entryId })
    .from(entryTerms)
    .where(and(eq(entryTerms.organizationId, organizationId), eq(entryTerms.siteId, siteId), eq(entryTerms.termId, termId)));
  return rows.map((row) => row.entryId);
}

/** The drafts whose `term_ids` hold the term, locked: nothing saves or publishes them while the term is being deleted. */
export async function lockDraftsWithTerm(tx: TenantTx, organizationId: string, siteId: string, termId: string): Promise<string[]> {
  const rows = await tx
    .select({ entryId: entryDrafts.entryId })
    .from(entryDrafts)
    .where(and(eq(entryDrafts.organizationId, organizationId), eq(entryDrafts.siteId, siteId), sql`${entryDrafts.termIds} @> array[${termId}]::uuid[]`))
    .orderBy(entryDrafts.entryId)
    .for("update");
  return rows.map((row) => row.entryId);
}

/**
 * Takes the term out of every draft of the site that holds it (`entry_drafts.term_ids` has no foreign key, ADR 0016).
 * The draft's version is not moved: this is not anyone's edit, and an editor open on the draft keeps saving; one that
 * still sends the deleted term is refused with a message, so it cannot put it back (ADR 0019).
 */
export async function removeTermFromDrafts(tx: TenantTx, organizationId: string, siteId: string, termId: string): Promise<number> {
  const rows = await tx
    .update(entryDrafts)
    .set({ termIds: sql`array_remove(${entryDrafts.termIds}, ${termId}::uuid)` })
    .where(and(eq(entryDrafts.organizationId, organizationId), eq(entryDrafts.siteId, siteId), sql`${entryDrafts.termIds} @> array[${termId}]::uuid[]`))
    .returning({ entryId: entryDrafts.entryId });
  return rows.length;
}

export type TermWithUsage = Pick<TermRow, "id" | "taxonomy" | "name" | "slug" | "description" | "parentId"> & {
  /** Published posts carrying it (`entry_terms`): what its archive lists. */
  posts: number;
  /** Drafts that hold it (`entry_drafts.term_ids`). */
  drafts: number;
};

/** The site's terms of a taxonomy, by name, with how much they are used. */
export async function termsWithUsage(tx: TenantTx, organizationId: string, siteId: string, taxonomy: Taxonomy): Promise<TermWithUsage[]> {
  return tx
    .select({
      id: terms.id, taxonomy: terms.taxonomy, name: terms.name, slug: terms.slug, description: terms.description, parentId: terms.parentId,
      posts: sql<number>`(select count(*)::int from ${entryTerms} et where et.site_id = ${terms.siteId} and et.term_id = ${terms.id})`,
      drafts: sql<number>`(select count(*)::int from ${entryDrafts} d where d.site_id = ${terms.siteId} and d.organization_id = ${terms.organizationId} and d.term_ids @> array[${terms.id}])`,
    })
    .from(terms)
    .where(and(ofSite(organizationId, siteId), eq(terms.taxonomy, taxonomy)))
    .orderBy(asc(sql`lower(${terms.name})`), asc(terms.id));
}
