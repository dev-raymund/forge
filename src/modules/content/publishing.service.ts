import "server-only";
import { record } from "@/modules/audit";
import { inTenant, type SiteContext } from "@/modules/tenancy";
import type { CacheEvent } from "@/platform/cache";
import type { TenantTx } from "@/platform/db";
import { conflict, forbidden, notFound, validationError } from "@/platform/errors";
import { documentProblem, parseDocument } from "./document/parse";
import { assertTermsOfSite, contentHashOf, definitionOf, refOf, summaryOf, titleForLog, type EntrySummary } from "./entry.service";
import { HOME_PATH, ParentChainError, parentChain, pathUnder, postPath, reservedPathReason, type PageNode } from "./paths";
import { canPublishEntry } from "./policies";
import { ancestorsOf, findDraft, findEntry, insertRevision, nextRevisionNumber, replaceEntryTerms, revisionById, siteFacts, updateEntry } from "./repository";
import { isEntrySlug } from "./slugs";
import { moveSubtree, withPathTaken, type MovedEntry } from "./tree";
import { versionSchema, parseInput } from "./validation";

/**
 * Publishing an entry (M5-3; plan §9 "Publish"; cms-architecture §9.1), in one
 * transaction:
 *
 *   1. lock the entry (and its draft)
 *   2. idempotency: this draft version is already the published one → done, nothing written
 *      a newer save exists → Conflict
 *   3. a `publish` revision: a snapshot of the draft, numbered after the entry's last
 *   4. the projection: status, title, slug, path, excerpt, image, the revision, the dates;
 *      the pages below it follow a path change (redirects are M8-5's)
 *   5. `entry_terms` replaced by the draft's terms (checked again: the draft's list has no foreign key)
 *   6. `entry.published` recorded
 *   7. the cache events returned, for the Server Action to flush after the commit
 *
 * The revision is written before the entry points at it, as the table requires
 * (`entries_published_has_revision`, `entries_published_revision_fk`). Any
 * failure, including the record's, leaves the entry, its revisions and its
 * terms as they were.
 *
 * `published_at` is the entry's date: set at its first publish and kept when
 * it is published again (posts are listed by it); `first_published_at` never
 * changes once set.
 */

export const NEWER_SAVE = "The draft has changed since this was opened. Reload it, check the latest version, and publish again.";

export type Published = { entry: EntrySummary; revision: number; changed: boolean; moved: MovedEntry[]; events: CacheEvent[] };

export async function publishEntry(ctx: SiteContext, entryId: string, expectedDraftVersion: number): Promise<Published> {
  const expected = parseInput(versionSchema, expectedDraftVersion);
  return inTenant(ctx, async (tx) => {
    // 1. Lock. Two publishes of one entry take turns from here.
    const entry = await findEntry(tx, ctx.org.id, ctx.site.id, entryId, { lock: true });
    if (!entry) throw notFound();
    if (!canPublishEntry(ctx, refOf(entry))) throw forbidden();
    const draft = await findDraft(tx, ctx.org.id, ctx.site.id, entry.id, { lock: true });
    if (!draft) throw notFound();

    // 2. Idempotency: a retry of a publish that already happened answers as it did, and writes nothing.
    if (entry.status === "published" && entry.publishedRevisionId) {
      const live = await revisionById(tx, ctx.org.id, ctx.site.id, entry.id, entry.publishedRevisionId);
      if (live?.sourceDraftVersion === expected) return { entry: summaryOf(entry), revision: live.number, changed: false, moved: [], events: [] };
    }
    if (draft.version !== expected) throw conflict(NEWER_SAVE);

    // What is published must be valid now, whatever was stored before.
    const definition = definitionOf(entry);
    const document = parseDocument(draft.content);
    if (!document.ok) throw validationError({ content: [documentProblem(document)] });
    if (!isEntrySlug(draft.slug)) throw validationError({ slug: ["Use lowercase letters, numbers and single hyphens, like about-us."] });
    if (!definition.fields.safeParse(draft.fields).success) throw validationError({ fields: [`${definition.label.plural} have no such fields.`] });
    const site = await siteFacts(tx, ctx.org.id, ctx.site.id);
    if (!site) throw notFound();

    const path = await pathFor(tx, ctx, entry, draft.slug, site.blogPath);
    if (path !== HOME_PATH) {
      const reserved = reservedPathReason(path, { type: definition.key, blogPath: site.blogPath });
      if (reserved) throw validationError({ slug: [reserved] });
    }
    const termIds = definition.supports.taxonomies.length ? draft.termIds : [];
    await assertTermsOfSite(tx, ctx, definition, termIds);

    // 3. The revision, before anything points at it.
    const number = await nextRevisionNumber(tx, ctx.org.id, ctx.site.id, entry.id);
    const excerpt = definition.supports.excerpt ? draft.excerpt : "";
    const featuredMediaId = definition.supports.featuredImage ? draft.featuredMediaId : null;
    const template = definition.supports.templates ? draft.template : null;
    const revision = await insertRevision(tx, {
      organizationId: ctx.org.id, siteId: ctx.site.id, entryId: entry.id, number, kind: "publish", title: draft.title, slug: draft.slug, excerpt, featuredMediaId,
      template, content: document.document, fields: draft.fields, seo: draft.seo, termIds, contentHash: contentHashOf(document.document),
      sourceDraftVersion: draft.version, createdBy: ctx.actor.userId,
    });

    // 4. The projection, and the pages below it if its path changed.
    const now = new Date();
    await withPathTaken(path, () =>
      updateEntry(tx, ctx.org.id, ctx.site.id, entry.id, {
        status: "published", title: draft.title, slug: draft.slug, path, excerpt, featuredMediaId, publishedRevisionId: revision.id,
        publishedAt: entry.publishedAt ?? now, firstPublishedAt: entry.firstPublishedAt ?? now, scheduledAt: null, updatedBy: ctx.actor.userId,
      }),
    );
    const moved = path !== entry.path && definition.hierarchical ? await moveSubtree(tx, ctx, entry.id, path) : [];

    // 5. The published terms.
    await replaceEntryTerms(tx, ctx.org.id, ctx.site.id, entry.id, termIds);

    // 6. The record.
    await record(
      tx,
      {
        action: "entry.published", resourceType: "entry", resourceId: entry.id, siteId: ctx.site.id,
        metadata: { type: definition.key, title: titleForLog(draft.title), path, revision: number },
      },
      ctx,
    );

    // 7. What the public site must stop serving from cache.
    const wasLive = entry.status === "published";
    const events: CacheEvent[] = [
      { type: "entry.published", siteId: ctx.site.id, entryId: entry.id, contentType: definition.key, pathChanged: wasLive && path !== entry.path },
      ...movedEvents(ctx.site.id, moved),
    ];
    return { entry: { ...summaryOf(entry), status: "published", title: draft.title, slug: draft.slug, path }, revision: number, changed: true, moved, events };
  });
}

/** A moved page that is live changes what visitors get at two addresses. Drafts are not public. */
export function movedEvents(siteId: string, moved: readonly MovedEntry[]): CacheEvent[] {
  return moved.filter((page) => page.status === "published").map((page) => ({ type: "entry.moved", siteId, entryId: page.id, contentType: page.type }));
}

/**
 * Where the entry will live once published. The Home page stays at `/`; a
 * post is under the blog's path; a page is under its parent's path, after
 * the chain of pages above it has been checked: no loop, no missing or trashed
 * page, no post, nothing of another site (the composite key already sees to that).
 */
async function pathFor(tx: TenantTx, ctx: SiteContext, entry: { type: string; path: string; parentId: string | null }, slug: string, blogPath: string): Promise<string> {
  if (entry.path === HOME_PATH) return HOME_PATH;
  if (entry.type === "post") return postPath(slug, blogPath);
  if (!entry.parentId) return pathUnder("", slug);
  const rows = await ancestorsOf(tx, ctx.org.id, ctx.site.id, entry.parentId);
  const byId = new Map(rows.map((row) => [row.id, row]));
  let chain: PageNode[];
  try {
    chain = parentChain(entry.parentId, (id) => {
      const row = byId.get(id);
      return row ? { id: row.id, slug: row.slug, parentId: row.parentId, home: row.path === HOME_PATH } : undefined;
    });
  } catch (error) {
    if (error instanceof ParentChainError) {
      throw validationError({ parentId: [error.reason === "cycle" ? "The pages above this one form a loop. Choose another parent." : "A page above this one no longer exists."] });
    }
    throw error;
  }
  const invalid = chain.find((node) => byId.get(node.id)!.deleted || byId.get(node.id)!.type !== "page");
  if (invalid) throw validationError({ parentId: ["A page above this one is in the trash or is not a page. Choose another parent."] });
  // The parent's stored path is the address it has now: every path change goes through moveSubtree, so it is its chain's.
  return pathUnder(byId.get(entry.parentId)!.path, slug);
}
