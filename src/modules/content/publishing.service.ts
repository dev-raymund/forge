import "server-only";
import { record } from "@/modules/audit";
import { inTenant, type SiteContext } from "@/modules/tenancy";
import type { CacheEvent } from "@/platform/cache";
import type { TenantTx } from "@/platform/db";
import { conflict, forbidden, notFound, validationError } from "@/platform/errors";
import { documentProblem, parseDocument } from "./document/parse";
import type { StoredDocument } from "./document/schema";
import { assertTermsOfSite, contentHashOf, definitionOf, refOf, summaryOf, titleForLog, type EntrySummary } from "./entry.service";
import { stateOf, transition } from "./lifecycle";
import { NEWER_SAVE } from "./messages";
import { HOME_PATH, ParentChainError, parentChain, pathUnder, postPath, reservedPathReason, type PageNode } from "./paths";
import { canPublishEntry } from "./policies";
import { ancestorsOf, findDraft, findEntry, insertRevision, nextRevisionNumber, replaceEntryTerms, revisionById, siteFacts, updateEntry, type DraftRow, type EntryRow } from "./repository";
import type { SiteScope } from "./scope";
import type { ContentTypeDefinition } from "./types/definition";
import { isEntrySlug } from "./slugs";
import { assertOwnReferences } from "./references";
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

export type Published = { entry: EntrySummary; revision: number; changed: boolean; moved: MovedEntry[]; events: CacheEvent[] };

/**
 * What is published (M7-2): the draft, when someone presses Publish or schedules it, or the frozen `scheduled`
 * revision, when the job publishes it at its time. Both go through the same checks and the same projection.
 */
export type Snapshot = {
  title: string; slug: string; excerpt: string; featuredMediaId: string | null; template: string | null; content: unknown;
  fields: Record<string, unknown>; seo: Record<string, unknown>; termIds: readonly string[]; sourceDraftVersion: number;
};

export const snapshotOfDraft = (draft: DraftRow): Snapshot => ({
  title: draft.title, slug: draft.slug, excerpt: draft.excerpt, featuredMediaId: draft.featuredMediaId, template: draft.template, content: draft.content,
  fields: draft.fields, seo: draft.seo, termIds: draft.termIds, sourceDraftVersion: draft.version,
});

export type Prepared = {
  definition: ContentTypeDefinition; document: StoredDocument; path: string; termIds: string[]; excerpt: string; featuredMediaId: string | null; template: string | null;
};

/**
 * A snapshot checked as it would be published now, whatever was stored before (M5-3's rules, run by Publish, by
 * scheduling, and again by the job at the scheduled time, when the site may have changed): a valid document pointing
 * at nothing of another site, a valid slug, fields the type has, an address it may have (parent chain, reserved
 * paths), and terms of this site.
 */
export async function prepareForPublish(tx: TenantTx, scope: SiteScope, entry: EntryRow, snapshot: Snapshot): Promise<Prepared> {
  const definition = definitionOf(entry);
  const document = parseDocument(snapshot.content);
  if (!document.ok) throw validationError({ content: [documentProblem(document)] });
  // Nothing in it may point at another site's images or entries (M5-5).
  await assertOwnReferences(tx, scope, document.document);
  if (!isEntrySlug(snapshot.slug)) throw validationError({ slug: ["Use lowercase letters, numbers and single hyphens, like about-us."] });
  if (!definition.fields.safeParse(snapshot.fields).success) throw validationError({ fields: [`${definition.label.plural} have no such fields.`] });
  const site = await siteFacts(tx, scope.org.id, scope.site.id);
  if (!site) throw notFound();

  const path = await pathFor(tx, scope, entry, snapshot.slug, site.blogPath);
  if (path !== HOME_PATH) {
    const reserved = reservedPathReason(path, { type: definition.key, blogPath: site.blogPath });
    if (reserved) throw validationError({ slug: [reserved] });
  }
  const termIds = definition.supports.taxonomies.length ? [...snapshot.termIds] : [];
  await assertTermsOfSite(tx, scope, definition, termIds);
  return {
    definition, document: document.document, path, termIds,
    excerpt: definition.supports.excerpt ? snapshot.excerpt : "",
    featuredMediaId: definition.supports.featuredImage ? snapshot.featuredMediaId : null,
    template: definition.supports.templates ? snapshot.template : null,
  };
}

/**
 * The entry made live at a revision (written before it, as the table requires): the projection, the pages below it if
 * its path changed, and the published terms. `published_at` is the entry's date at its first publish (now; or the
 * time it was scheduled for, `by.publishedAt`) and is kept after; `first_published_at` is when it really first went live.
 * Returns what the public site must stop serving.
 */
export async function makeLive(
  tx: TenantTx, scope: SiteScope, entry: EntryRow, prepared: Prepared, snapshot: Snapshot, revision: { id: string }, by: { userId: string | null; publishedAt?: Date },
): Promise<{ path: string; moved: MovedEntry[]; events: CacheEvent[] }> {
  const { definition, path } = prepared;
  // One reading of the clock: a first publish by hand has the same date and first date, to the millisecond.
  const now = new Date();
  await withPathTaken(path, () =>
    updateEntry(tx, scope.org.id, scope.site.id, entry.id, {
      status: "published", title: snapshot.title, slug: snapshot.slug, path, excerpt: prepared.excerpt, featuredMediaId: prepared.featuredMediaId,
      publishedRevisionId: revision.id, publishedAt: entry.publishedAt ?? by.publishedAt ?? now, firstPublishedAt: entry.firstPublishedAt ?? now, scheduledAt: null,
      scheduleFailure: null, scheduleFailedAt: null, updatedBy: by.userId,
    }),
  );
  const moved = path !== entry.path && definition.hierarchical ? await moveSubtree(tx, scope, entry.id, path) : [];
  await replaceEntryTerms(tx, scope.org.id, scope.site.id, entry.id, prepared.termIds);
  const wasLive = entry.status === "published";
  const events: CacheEvent[] = [
    { type: "entry.published", siteId: scope.site.id, entryId: entry.id, contentType: definition.key, pathChanged: wasLive && path !== entry.path },
    ...movedEvents(scope.site.id, moved),
  ];
  return { path, moved, events };
}

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
    // A scheduled entry is published by its schedule, or its schedule is canceled first (M7-2, ./lifecycle.ts).
    const step = transition(stateOf(entry), "publish");
    if (!step.ok) throw conflict(step.reason);
    if (draft.version !== expected) throw conflict(NEWER_SAVE);

    const snapshot = snapshotOfDraft(draft);
    const prepared = await prepareForPublish(tx, ctx, entry, snapshot);

    // 3. The revision, before anything points at it.
    const number = await nextRevisionNumber(tx, ctx.org.id, ctx.site.id, entry.id);
    const revision = await insertRevision(tx, revisionValues(ctx, entry, prepared, snapshot, number, "publish", ctx.actor.userId));

    // 4–5. The projection, the pages below it if its path changed, the published terms.
    const { path, moved, events } = await makeLive(tx, ctx, entry, prepared, snapshot, revision, { userId: ctx.actor.userId });

    // 6. The record.
    await record(
      tx,
      {
        action: "entry.published", resourceType: "entry", resourceId: entry.id, siteId: ctx.site.id,
        metadata: { type: prepared.definition.key, title: titleForLog(snapshot.title), path, revision: number },
      },
      ctx,
    );

    // 7. What the public site must stop serving from cache.
    return { entry: { ...summaryOf(entry), status: "published", title: snapshot.title, slug: snapshot.slug, path }, revision: number, changed: true, moved, events };
  });
}

/** A revision's row: a snapshot of what is published (or will be, for a `scheduled` one). */
export const revisionValues = (
  scope: SiteScope, entry: EntryRow, prepared: Prepared, snapshot: Snapshot, number: number, kind: "publish" | "scheduled", createdBy: string,
) => ({
  organizationId: scope.org.id, siteId: scope.site.id, entryId: entry.id, number, kind, title: snapshot.title, slug: snapshot.slug, excerpt: prepared.excerpt,
  featuredMediaId: prepared.featuredMediaId, template: prepared.template, content: prepared.document, fields: snapshot.fields, seo: snapshot.seo,
  termIds: prepared.termIds, contentHash: contentHashOf(prepared.document), sourceDraftVersion: snapshot.sourceDraftVersion, createdBy,
});

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
async function pathFor(tx: TenantTx, ctx: SiteScope, entry: { type: string; path: string; parentId: string | null }, slug: string, blogPath: string): Promise<string> {
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
