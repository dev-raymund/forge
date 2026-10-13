import "server-only";
import { record } from "@/modules/audit";
import { inTenant, requirePermission, type SiteContext } from "@/modules/tenancy";
import type { CacheEvent } from "@/platform/cache";
import { isUniqueViolation, type TenantTx } from "@/platform/db";
import { conflict, forbidden, notFound, validationError } from "@/platform/errors";
import { canCreateTerm, canManageTerms } from "./policies";
import { lockSiteSettings, siteFacts } from "./repository";
import { TAXONOMIES } from "./schema";
import { ENTRY_SLUG_MAX, nextFreeSlug, slugFromTitle } from "./slugs";
import {
  childCount, deleteTermRow, entriesWithTerm, findTerm, insertTerm, lockDraftsWithTerm, removeTermFromDrafts, TERM_SLUG_KEY, termSlugsLike, termsWithUsage,
  updateTermRow, type Taxonomy, type TermRow, type TermWithUsage,
} from "./term.repository";
import { CONTENT_TYPES } from "./types/registry";
import { createTermSchema, parseInput, updateTermSchema, type CreateTermInput, type UpdateTermInput } from "./validation";

/**
 * Categories and tags (M5-8; plan §5, §13; ADR 0019). A term belongs to one site; its slug is unique within its
 * taxonomy there (`terms_site_taxonomy_slug_unique`), and its archive is `/{blogPath}/{category|tag}/{slug}`.
 *
 *   createTerm   a category: terms.manage; a tag: terms.manage or terms.assign (an Author adds tags while writing)
 *   updateTerm   terms.manage: name, slug, description, and a category's parent (one level of nesting)
 *   deleteTerm   terms.manage: out of every draft that holds it, off every published post, then gone, in one transaction
 *
 * Each runs in one transaction with its audit record, and returns the cache events a commit makes true: the archive's
 * address (routes), the published posts that show the term, the lists (`term.changed`). Assigning terms to an entry is
 * not here: it is the draft's (`saveDraft`) and the publish's (`publishEntry`).
 */

export type TermSummary = Pick<TermRow, "id" | "taxonomy" | "name" | "slug" | "description" | "parentId">;
const summaryOf = (row: TermRow): TermSummary => ({ id: row.id, taxonomy: row.taxonomy, name: row.name, slug: row.slug, description: row.description, parentId: row.parentId });

const NOUN: Record<Taxonomy, string> = { category: "category", tag: "tag" };
const SLUG_TAKEN = (taxonomy: Taxonomy) => `Another ${NOUN[taxonomy]} of this site already uses this slug. Choose another.`;
/** How many times a race may take the generated slug before the request gives up with a Conflict. */
const MAX_SLUG_ATTEMPTS = 10;

/** A taxonomy some content type uses (the registry), or a validation error: terms of anything else could never be assigned. */
function taxonomyOf(value: unknown): Taxonomy {
  const used = new Set(CONTENT_TYPES.flatMap((type) => type.supports.taxonomies));
  if (typeof value !== "string" || !(TAXONOMIES as readonly string[]).includes(value) || !used.has(value as Taxonomy)) {
    throw validationError({ taxonomy: ["Choose categories or tags."] });
  }
  return value as Taxonomy;
}

const changedEvent = (siteId: string, entryIds: readonly string[]): CacheEvent => ({ type: "term.changed", siteId, entryIds });

/** A category's parent must be a top-level category of the site (one level of nesting). Takes the site's lock first: two re-parentings cannot stack. */
async function assertParent(tx: TenantTx, ctx: SiteContext, parentId: string, self: string | null): Promise<TermRow> {
  if (parentId === self) throw validationError({ parentId: ["A category cannot be its own parent."] });
  const parent = await findTerm(tx, ctx.org.id, ctx.site.id, parentId);
  if (!parent || parent.taxonomy !== "category") throw validationError({ parentId: ["Choose a category of this site."] });
  if (parent.parentId !== null) throw validationError({ parentId: ["Choose a top-level category: categories nest one level deep."] });
  return parent;
}

export async function createTerm(ctx: SiteContext, input: CreateTermInput): Promise<{ term: TermSummary; events: CacheEvent[] }> {
  const taxonomy = taxonomyOf((input as { taxonomy?: unknown } | null)?.taxonomy);
  if (!canCreateTerm(ctx, taxonomy)) throw forbidden();
  const values = parseInput(createTermSchema, input);
  if (values.parentId && taxonomy !== "category") throw validationError({ parentId: ["Only categories have a parent."] });

  return inTenant(ctx, async (tx) => {
    if (!(await siteFacts(tx, ctx.org.id, ctx.site.id))) throw notFound();
    if (values.parentId) {
      await lockSiteSettings(tx, ctx.org.id, ctx.site.id);
      await assertParent(tx, ctx, values.parentId, null);
    }
    const row = (slug: string) => ({
      organizationId: ctx.org.id, siteId: ctx.site.id, taxonomy, name: values.name, slug, description: values.description, parentId: values.parentId,
    });
    let term: TermRow | null = null;
    if (values.slug) {
      // Typed: used as typed, or refused. Never suffixed (as entries', M5-3).
      try {
        term = await tx.transaction((savepoint) => insertTerm(savepoint as TenantTx, row(values.slug!)));
      } catch (error) {
        if (isUniqueViolation(error, TERM_SLUG_KEY)) throw validationError({ slug: [SLUG_TAKEN(taxonomy)] });
        throw error;
      }
    } else {
      // Made from the name: the first free one (`bread`, `bread-2`, …), and the next if a concurrent writer took it.
      const base = slugFromTitle(values.name);
      const taken = new Set(await termSlugsLike(tx, ctx.org.id, ctx.site.id, taxonomy, base.slice(0, ENTRY_SLUG_MAX - 12)));
      for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS && !term; attempt++) {
        const slug = nextFreeSlug(base, taken);
        try {
          term = await tx.transaction((savepoint) => insertTerm(savepoint as TenantTx, row(slug)));
        } catch (error) {
          if (!isUniqueViolation(error, TERM_SLUG_KEY)) throw error;
          taken.add(slug);
        }
      }
      if (!term) throw conflict("Another change took this slug at the same moment. Try again.");
    }
    await record(
      tx,
      { action: "term.created", resourceType: "term", resourceId: term.id, siteId: ctx.site.id, metadata: { taxonomy, name: term.name, slug: term.slug } },
      ctx,
    );
    // A cached "no such archive" for its address goes: its archive exists now.
    return { term: summaryOf(term), events: [changedEvent(ctx.site.id, [])] };
  });
}

export async function updateTerm(ctx: SiteContext, termId: string, input: UpdateTermInput): Promise<{ term: TermSummary; changed: boolean; events: CacheEvent[] }> {
  if (!canManageTerms(ctx)) throw forbidden();
  const values = parseInput(updateTermSchema, input);
  return inTenant(ctx, async (tx) => {
    // The site's lock first when the hierarchy may change (as `movePage`), then the term.
    if (values.parentId !== undefined) await lockSiteSettings(tx, ctx.org.id, ctx.site.id);
    const term = await findTerm(tx, ctx.org.id, ctx.site.id, termId, { lock: true });
    if (!term) throw notFound();

    const next: Partial<Pick<TermRow, "name" | "slug" | "description" | "parentId">> = {};
    if (values.name !== undefined && values.name !== term.name) next.name = values.name;
    if (values.slug !== undefined && values.slug !== term.slug) next.slug = values.slug;
    if (values.description !== undefined && values.description !== term.description) next.description = values.description;
    if (values.parentId !== undefined && values.parentId !== term.parentId) {
      if (term.taxonomy !== "category") throw validationError({ parentId: ["Only categories have a parent."] });
      if (values.parentId) {
        await assertParent(tx, ctx, values.parentId, term.id);
        if ((await childCount(tx, ctx.org.id, ctx.site.id, term.id)) > 0) {
          throw validationError({ parentId: ["This category has subcategories: it stays at the top level. Move them first."] });
        }
      }
      next.parentId = values.parentId;
    }
    const fields = (["name", "slug", "description", "parentId"] as const).filter((key) => key in next);
    if (fields.length === 0) return { term: summaryOf(term), changed: false, events: [] };

    try {
      await tx.transaction((savepoint) => updateTermRow(savepoint as TenantTx, ctx.org.id, ctx.site.id, term.id, next));
    } catch (error) {
      if (isUniqueViolation(error, TERM_SLUG_KEY)) throw validationError({ slug: [SLUG_TAKEN(term.taxonomy)] });
      throw error;
    }
    const updated = { ...term, ...next };
    await record(
      tx,
      {
        action: "term.updated", resourceType: "term", resourceId: term.id, siteId: ctx.site.id,
        metadata: {
          taxonomy: term.taxonomy, name: updated.name, slug: updated.slug, fields: fields.map((field) => (field === "parentId" ? "parent" : field)),
          ...(next.name ? { previousName: term.name } : {}), ...(next.slug ? { previousSlug: term.slug } : {}),
        },
      },
      ctx,
    );
    // The posts that show it (their pages list its name and link), and the archive's address. Redirects from an old slug are M8-5's.
    return { term: summaryOf(updated), changed: true, events: [changedEvent(ctx.site.id, await entriesWithTerm(tx, ctx.org.id, ctx.site.id, term.id))] };
  });
}

/**
 * Deletes the term, in one transaction: the drafts that hold it are locked and it is taken out of them; the published
 * posts lose it (`entry_terms`, CASCADE), so its archive disappears and their pages no longer show it; its
 * subcategories move to the top level (SET NULL). No entry is deleted. A failure anywhere, the audit record
 * included, leaves the term and every reference as they were.
 */
export async function deleteTerm(ctx: SiteContext, termId: string): Promise<{ term: TermSummary; posts: number; drafts: number; events: CacheEvent[] }> {
  if (!canManageTerms(ctx)) throw forbidden();
  return inTenant(ctx, async (tx) => {
    // The drafts first, then the term: the order saving and publishing take (term.repository.ts).
    await lockDraftsWithTerm(tx, ctx.org.id, ctx.site.id, termId);
    const term = await findTerm(tx, ctx.org.id, ctx.site.id, termId, { lock: true });
    if (!term) throw notFound();
    const published = await entriesWithTerm(tx, ctx.org.id, ctx.site.id, term.id);
    // Re-evaluated now that the term is locked: a draft that took it meanwhile is included.
    const drafts = await removeTermFromDrafts(tx, ctx.org.id, ctx.site.id, term.id);
    await deleteTermRow(tx, ctx.org.id, ctx.site.id, term.id);
    await record(
      tx,
      {
        action: "term.deleted", resourceType: "term", resourceId: term.id, siteId: ctx.site.id,
        metadata: { taxonomy: term.taxonomy, name: term.name, slug: term.slug, posts: published.length, drafts },
      },
      ctx,
    );
    return { term: summaryOf(term), posts: published.length, drafts, events: [changedEvent(ctx.site.id, published)] };
  });
}

/** The site's categories or tags, with how many published posts and drafts use each: the term screens. */
export async function listTermsWithUsage(ctx: SiteContext, taxonomy: string): Promise<TermWithUsage[]> {
  if (!canManageTerms(ctx)) throw forbidden();
  requirePermission(ctx, "entries.post.read");
  const which = taxonomyOf(taxonomy);
  return inTenant(ctx, (tx) => termsWithUsage(tx, ctx.org.id, ctx.site.id, which));
}
