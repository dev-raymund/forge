import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { record } from "@/modules/audit";
import { manualRevisionsKept } from "@/modules/billing";
import { inTenant, type SiteContext } from "@/modules/tenancy";
import type { CacheEvent } from "@/platform/cache";
import { pgErrorOf, type TenantTx } from "@/platform/db";
import { conflict, forbidden, notFound, validationError } from "@/platform/errors";
import { canonicalJson, documentProblem, parseDocument } from "./document/parse";
import type { StoredDocument } from "./document/schema";
import { contentHashOf, definitionOf, refOf, titleForLog, writeDraft } from "./entry.service";
import { CHANGED_AGAIN, NOT_THE_LATEST } from "./messages";
import { HOME_PATH, parentDir, pathUnder, postPath, reservedPathReason } from "./paths";
import { canSeeEntry, canUpdateEntry } from "./policies";
import { assertOwnReferences, featuredImageState, missingReferences } from "./references";
import {
  findDraft, findEntry, fullRevision, holdersOf, insertRevision, latestRevision, nextRevisionNumber, pruneManualRevisions, siteFacts, termsOfSite, updateDraftIfVersion,
  type DraftRow, type EntryRow,
} from "./repository";
import { REVISION_LABEL_MAX, type RestoreNotes } from "./revisions";
import { draftSchema, versionSchema, parseInput } from "./validation";

/**
 * Revisions (M7-3; plan §6.3 "Save" and "Conflict", §9 "Revision restore"; cms-architecture §15; ADR 0026). Each one
 * runs in one transaction, under the entry's lock and then the draft's (the order Publish and scheduling take), so the
 * revision numbers, the draft's version and the record move together, and a failure anywhere leaves all three as they
 * were:
 *
 *   saveRevision     "Save": the draft as it is, at the version the editor saved, kept as a `save` revision (optionally
 *                    labelled). Not when the latest revision already holds exactly it (and has the same label).
 *   restoreRevision  an earlier revision copied into the draft (a new version), checked as a draft is now: the draft as
 *                    it was is kept first; terms that no longer exist are left out; images, links and the featured
 *                    image that are gone are flagged. Then a `restore` revision. Never published.
 *   overwriteDraft   the editor's conflict dialog (plan §6.3's third choice): the newer version someone else saved,
 *                    exactly the one the dialog named, kept as a `save` revision; then what this editor holds written
 *                    through `saveDraft`'s own checks.
 *
 * None of them touches the entry's projection, its published revision, its terms or its schedule: what visitors see,
 * and the frozen revision a schedule publishes (M7-2), change only by publishing. So nothing is flushed. Manual
 * revisions beyond the plan's number (plan §14) are pruned, oldest first, in the same transaction.
 */

/** A label, or none: trimmed, at most `REVISION_LABEL_MAX` characters. */
const labelSchema = z
  .string()
  .trim()
  .max(REVISION_LABEL_MAX, `Use at most ${REVISION_LABEL_MAX} characters.`)
  .transform((value) => value || null);

type Versioned = Pick<DraftRow, "title" | "slug" | "excerpt" | "featuredMediaId" | "template" | "content" | "fields" | "seo" | "termIds">;

/** Everything a person can change in a draft, so that two equal versions are seen as one. */
const fingerprint = (version: Versioned): string =>
  createHash("sha256")
    .update(
      canonicalJson({
        title: version.title, slug: version.slug, excerpt: version.excerpt, featuredMediaId: version.featuredMediaId, template: version.template,
        content: version.content, fields: version.fields, seo: version.seo, termIds: [...version.termIds].sort(),
      }),
    )
    .digest("hex");

/** The entry, locked, if the caller may see it (not found otherwise, as an entry of another site), and may change it. */
async function editableEntry(tx: TenantTx, ctx: SiteContext, entryId: string): Promise<{ entry: EntryRow; draft: DraftRow }> {
  const entry = await findEntry(tx, ctx.org.id, ctx.site.id, entryId, { lock: true });
  if (!entry || !canSeeEntry(ctx, refOf(entry))) throw notFound();
  if (!canUpdateEntry(ctx, refOf(entry))) throw forbidden();
  const draft = await findDraft(tx, ctx.org.id, ctx.site.id, entry.id, { lock: true });
  if (!draft) throw notFound();
  return { entry, draft };
}

/**
 * The draft as it is, in the history: a `save` revision credited to `by`, unless the latest revision already holds
 * exactly it. A label the person typed (`named`) makes a new one all the same, unless the latest has that very label:
 * they mean to find this point again by its name. Returns the number of the revision that holds it.
 */
async function keepDraft(
  tx: TenantTx, ctx: SiteContext, entry: EntryRow, draft: DraftRow, keep: { label: string | null; named: boolean; by: string },
): Promise<{ number: number; created: boolean }> {
  const { label, by } = keep;
  const latest = await latestRevision(tx, ctx.org.id, ctx.site.id, entry.id);
  if (latest && fingerprint(latest) === fingerprint(draft) && !(keep.named && label !== null && label !== latest.label)) return { number: latest.number, created: false };
  const { number } = await insertRevision(tx, {
    organizationId: ctx.org.id, siteId: ctx.site.id, entryId: entry.id, number: (latest?.number ?? 0) + 1, kind: "save", label, title: draft.title, slug: draft.slug,
    excerpt: draft.excerpt, featuredMediaId: draft.featuredMediaId, template: draft.template, content: draft.content, fields: draft.fields, seo: draft.seo,
    termIds: draft.termIds, contentHash: contentHashOf(draft.content as StoredDocument), sourceDraftVersion: draft.version, createdBy: by,
  });
  return { number, created: true };
}

/** Manual revisions beyond the organization's plan go, oldest first (plan §14). */
async function prune(tx: TenantTx, ctx: SiteContext, entryId: string): Promise<number> {
  return pruneManualRevisions(tx, ctx.org.id, ctx.site.id, entryId, await manualRevisionsKept(tx, ctx.org.id));
}

export type RevisionSaved = { number: number; created: boolean; events: CacheEvent[] };

/** "Save": keeps the draft at `version` (the one the editor has just saved) in the history. */
export async function saveRevision(ctx: SiteContext, entryId: string, input: { version: unknown; label?: unknown }): Promise<RevisionSaved> {
  const version = parseInput(versionSchema, input.version);
  const { label } = parseInput(z.object({ label: labelSchema }), { label: input.label ?? "" });
  return inTenant(ctx, async (tx) => {
    const { entry, draft } = await editableEntry(tx, ctx, entryId);
    // A newer save (another tab, someone else) is not what this person means to keep.
    if (draft.version !== version) throw conflict(NOT_THE_LATEST);
    const kept = await keepDraft(tx, ctx, entry, draft, { label, named: true, by: ctx.actor.userId });
    if (kept.created) await prune(tx, ctx, entry.id);
    // The history is the record: like autosave, a save changes nothing public and is not added to the activity log.
    return { ...kept, events: [] };
  });
}

export type RevisionRestored = {
  /** The draft's new version. */
  version: number;
  /** The revision that was restored, the one that keeps the draft as it was, and the `restore` revision. */
  restored: number;
  kept: number;
  revision: number;
  notes: RestoreNotes;
  events: CacheEvent[];
};

/**
 * Copies an earlier revision of the entry into its draft (plan §9 "Revision restore"), if the draft is still at
 * `version`. The revision is checked as a draft would be now, and nothing in it is trusted because it was valid once:
 *   document   the closed schema and its limits, block versions migrated; nothing of another site
 *   fields     the draft's rules (title, slug, excerpt, template), the type's fields
 *   address    a slug other than the draft's must give an address the entry may have where it is now (its parent and
 *              the blog's path are today's), and that no other entry holds: never suffixed, refused with the address
 *   terms      those no longer terms of the site (deleted since), or of a taxonomy the type uses, are left out (M5-8)
 *   gone       images and links that point at nothing usable are kept as written, and flagged; a featured image in
 *              the media trash is kept (not shown, as one trashed after it was chosen), one deleted for good is removed
 * Its parent and its author are the entry's, not the revision's: neither changes. The status, the live revision, the
 * published terms and a schedule's frozen revision do not change either: only publishing changes what visitors see.
 */
export async function restoreRevision(ctx: SiteContext, entryId: string, input: { revisionId: unknown; version: unknown }): Promise<RevisionRestored> {
  const version = parseInput(versionSchema, input.version);
  const revisionId = z.uuid().safeParse(input.revisionId);
  if (!revisionId.success) throw notFound();
  return inTenant(ctx, async (tx) => {
    const { entry, draft } = await editableEntry(tx, ctx, entryId);
    if (draft.version !== version) throw conflict(NOT_THE_LATEST);
    // A revision of this entry: another entry's, another site's or one pruned since the history was listed is not found.
    const revision = await fullRevision(tx, ctx.org.id, ctx.site.id, entry.id, revisionId.data);
    if (!revision) throw notFound();
    const definition = definitionOf(entry);
    const refused = (problem: string) => `Revision ${revision.number} cannot be restored: ${problem}`;

    const parsed = parseDocument(revision.content);
    if (!parsed.ok) throw validationError({ content: [refused(documentProblem(parsed))] });
    await assertOwnReferences(tx, ctx, parsed.document);
    const scalars = draftSchema.safeParse({ title: revision.title, slug: revision.slug, excerpt: revision.excerpt, template: revision.template });
    if (!scalars.success) throw validationError({ revision: [refused(scalars.error.issues[0]?.message ?? "it is no longer valid.")] });
    if (!definition.fields.safeParse(revision.fields).success) throw validationError({ fields: [refused(`${definition.label.plural} have no such fields.`)] });

    if (entry.path !== HOME_PATH && revision.slug !== draft.slug) {
      const site = await siteFacts(tx, ctx.org.id, ctx.site.id);
      if (!site) throw notFound();
      const path = definition.key === "post" ? postPath(revision.slug, site.blogPath) : pathUnder(parentDir(entry.path), revision.slug);
      const reserved = reservedPathReason(path, { type: definition.key, blogPath: site.blogPath });
      if (reserved) throw validationError({ slug: [refused(reserved)] });
      const holder = (await holdersOf(tx, ctx.org.id, ctx.site.id, entry.locale, [path])).find((row) => row.id !== entry.id);
      if (holder) {
        throw conflict(`Revision ${revision.number} used the address ${path}, which “${titleForLog(holder.title)}” has now. Change that address first, or restore another revision.`);
      }
    }

    // Terms: share-locked by `termsOfSite`, after the draft (the order a term's deletion takes).
    let termIds: string[] = [];
    if (definition.supports.taxonomies.length && revision.termIds.length) {
      const allowed = new Set<string>(definition.supports.taxonomies);
      const found = new Set((await termsOfSite(tx, ctx.org.id, ctx.site.id, revision.termIds)).filter((term) => allowed.has(term.taxonomy)).map((term) => term.id));
      termIds = revision.termIds.filter((id) => found.has(id));
    }
    const missing = await missingReferences(tx, ctx, parsed.document);
    let featuredMediaId = definition.supports.featuredImage ? revision.featuredMediaId : null;
    const featuredImage = featuredMediaId ? await featuredImageState(tx, ctx, featuredMediaId) : "ok";
    if (featuredImage === "removed") featuredMediaId = null;
    const notes: RestoreNotes = {
      droppedTerms: definition.supports.taxonomies.length ? revision.termIds.length - termIds.length : 0,
      missingImages: missing.images, missingLinks: missing.links, featuredImage,
    };

    // Nothing the draft holds now is lost: it goes into the history first.
    const kept = await keepDraft(tx, ctx, entry, draft, { label: `Kept before revision ${revision.number} was restored`, named: false, by: draft.updatedBy ?? ctx.actor.userId });
    const values = {
      title: revision.title, slug: revision.slug, excerpt: definition.supports.excerpt ? revision.excerpt : "", featuredMediaId,
      template: definition.supports.templates ? revision.template : null, content: parsed.document, fields: revision.fields, seo: revision.seo, termIds,
    };
    let next: number | null;
    try {
      next = await updateDraftIfVersion(tx, ctx.org.id, ctx.site.id, entry.id, version, { ...values, contentHash: contentHashOf(parsed.document), updatedBy: ctx.actor.userId });
    } catch (error) {
      // Its featured image deleted for good between the check and the write: the composite key refuses it.
      if (pgErrorOf(error)?.constraint === "entry_drafts_featured_media_fk") throw conflict(refused("its featured image was deleted just now. Try again."));
      throw error;
    }
    if (next === null) throw conflict(NOT_THE_LATEST);

    const number = await nextRevisionNumber(tx, ctx.org.id, ctx.site.id, entry.id);
    await insertRevision(tx, {
      organizationId: ctx.org.id, siteId: ctx.site.id, entryId: entry.id, number, kind: "restore", label: `Restored from revision ${revision.number}`, ...values,
      contentHash: contentHashOf(parsed.document), sourceDraftVersion: next, createdBy: ctx.actor.userId,
    });
    await prune(tx, ctx, entry.id);
    await record(
      tx,
      {
        action: "entry.revision_restored", resourceType: "entry", resourceId: entry.id, siteId: ctx.site.id,
        metadata: { type: entry.type, title: titleForLog(revision.title), path: entry.path, revision: revision.number },
      },
      ctx,
    );
    return { version: next, restored: revision.number, kept: kept.number, revision: number, notes, events: [] };
  });
}

export type DraftOverwritten = { version: number; kept: number; events: CacheEvent[] };

/**
 * The conflict dialog's overwrite (plan §6.3): the draft becomes what this editor holds, after the version it replaces
 * is kept in the history. `replaceVersion` is the version the dialog showed (who saved it, when): a draft saved again
 * since is never overwritten unseen (Conflict `CHANGED_AGAIN`; the dialog shows the newer one). What is written goes
 * through `saveDraft`'s own checks (`writeDraft`), against the draft as it is now: a refusal there writes nothing, the
 * kept revision included.
 */
export async function overwriteDraft(ctx: SiteContext, entryId: string, input: { replaceVersion: unknown; draft: unknown }): Promise<DraftOverwritten> {
  const replace = parseInput(versionSchema, input.replaceVersion);
  return inTenant(ctx, async (tx) => {
    const { entry, draft } = await editableEntry(tx, ctx, entryId);
    if (draft.version !== replace) throw conflict(CHANGED_AGAIN);
    // Credited to whoever saved it: their words, kept.
    const kept = await keepDraft(tx, ctx, entry, draft, { label: "Kept when the draft was overwritten", named: false, by: draft.updatedBy ?? ctx.actor.userId });
    const { version } = await writeDraft(tx, ctx, entry, replace, input.draft);
    if (kept.created) await prune(tx, ctx, entry.id);
    const typed = (input.draft as { title?: unknown } | null)?.title;
    await record(
      tx,
      {
        action: "entry.draft_replaced", resourceType: "entry", resourceId: entry.id, siteId: ctx.site.id,
        metadata: { type: entry.type, title: titleForLog(typeof typed === "string" ? typed : draft.title), path: entry.path, keptRevision: kept.number },
      },
      ctx,
    );
    return { version, kept: kept.number, events: [] };
  });
}
