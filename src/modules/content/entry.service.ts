import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { record } from "@/modules/audit";
import { inTenant, type OrgContext, type SiteContext } from "@/modules/tenancy";
import type { CacheEvent } from "@/platform/cache";
import { pgErrorOf, type TenantTx } from "@/platform/db";
import { conflict, forbidden, notFound, validationError } from "@/platform/errors";
import { canonicalJson, documentProblem, emptyDocument, parseDocument } from "./document/parse";
import type { StoredDocument } from "./document/schema";
import { DRAFT_CHANGED } from "./messages";
import { HOME_PATH, parentDir, pathUnder, postPath, reservedPathReason } from "./paths";
import { canAssignTerms, canChangeAuthor, canCreateEntry, canCreditOthers, canUpdateEntry, type EntryRef } from "./policies";
import { assertNewReferences } from "./references";
import {
  findDraft, findEntry, insertDraft, insertEntry, isMember, memberName, setHomepageEntry, siteFacts, termsOfSite, updateDraftIfVersion, updateEntry, type EntryRow,
} from "./repository";
import { slugFromTitle } from "./slugs";
import type { ContentTypeDefinition, ContentTypeKey } from "./types/definition";
import { contentType } from "./types/registry";
import { insertWithUniqueSlug } from "./unique-slug";
import { createEntrySchema, draftSchema, parseInput, versionSchema, type CreateEntryInput, type DraftInput } from "./validation";

/**
 * Entries (M5-3; plan §5, §6.3; cms-architecture §9.1): creating one, and
 * saving its draft. Publishing is ./publishing.service.ts; the homepage
 * ./homepage.service.ts.
 *
 * Every function takes a `SiteContext`: who is asking, in which organization
 * and which site, all resolved from the session and the URL. An entry id is a
 * name, never an authority: it is looked up in the context's site, and an id
 * of another site, even of the same organization, is not found.
 */

export type EntrySummary = {
  id: string;
  type: ContentTypeKey;
  title: string;
  slug: string;
  path: string;
  status: string;
  parentId: string | null;
  authorId: string | null;
  locale: string;
};

export const summaryOf = (row: EntryRow): EntrySummary => ({
  id: row.id, type: row.type, title: row.title, slug: row.slug, path: row.path, status: row.status, parentId: row.parentId, authorId: row.authorId, locale: row.locale,
});

export const refOf = (row: EntryRow): EntryRef => ({ type: row.type, organizationId: row.organizationId, authorId: row.authorId });

/** The content hash stored with a draft and a revision: equal documents hash equally (canonical JSON). */
export const contentHashOf = (document: StoredDocument): string => createHash("sha256").update(canonicalJson(document)).digest("hex");

/** How an entry with no title is named in the activity log. */
export const titleForLog = (title: string): string => title.trim() || "Untitled";

const NOT_A_TYPE = "Choose a page or a post.";

/** The type of an entry as stored. The CHECK allows only registry keys, so a miss is a broken row. */
export function definitionOf(row: Pick<EntryRow, "type">): ContentTypeDefinition {
  const definition = contentType(row.type);
  if (!definition) throw new Error(`Entry type "${row.type}" is not in the registry`);
  return definition;
}

/**
 * Creates an entry and its first draft (plan §5; cms-architecture §9.1): a
 * slug from the title, made unique where the entry will live (`base`,
 * `base-2`, …), a path from the type's routing, draft version 1 with an empty
 * document, and an `entry.created` record, in one transaction. The entry is a
 * draft: nothing public changes, so there is nothing to flush.
 */
export async function createEntry(ctx: SiteContext, input: CreateEntryInput): Promise<{ entry: EntrySummary; events: CacheEvent[] }> {
  const definition = contentType((input as { type?: unknown } | null)?.type);
  if (!definition) throw validationError({ type: [NOT_A_TYPE] });
  if (!canCreateEntry(ctx, definition.key)) throw forbidden();
  const values = parseInput(createEntrySchema, input);
  const crediting = values.authorId !== null && values.authorId !== ctx.actor.userId;
  if (crediting && !canCreditOthers(ctx, definition.key)) throw forbidden();
  if (values.parentId && !definition.hierarchical) throw validationError({ parentId: ["Posts have no parent page."] });
  if (values.template && !definition.supports.templates) throw validationError({ template: ["Posts have no template."] });

  return inTenant(ctx, async (tx) => {
    const site = await siteFacts(tx, ctx.org.id, ctx.site.id);
    if (!site) throw notFound();
    let dir = "";
    if (definition.key === "post") dir = `/${site.blogPath}`;
    else if (values.parentId) {
      // A page of this site, not in the trash. Another site's page, even of this organization, is not one.
      const parent = await findEntry(tx, ctx.org.id, ctx.site.id, values.parentId);
      if (!parent || parent.type !== "page" || parent.locale !== site.locale) throw validationError({ parentId: ["Choose a page of this site."] });
      dir = parent.path;
    }
    const authorId = values.authorId ?? ctx.actor.userId;
    if (crediting && !(await isMember(tx, ctx.org.id, authorId))) throw validationError({ authorId: ["Choose a member of this organization."] });

    const document = emptyDocument();
    const { result: entry } = await insertWithUniqueSlug(
      tx,
      ctx,
      { type: definition.key, locale: site.locale, dir, base: slugFromTitle(values.title), blogPath: site.blogPath },
      (savepoint, slug, path) =>
        insertEntry(savepoint, {
          organizationId: ctx.org.id, siteId: ctx.site.id, type: definition.key, locale: site.locale, parentId: values.parentId, authorId,
          title: values.title, slug, path, createdBy: ctx.actor.userId, updatedBy: ctx.actor.userId,
        }),
    );
    await insertDraft(tx, {
      entryId: entry.id, organizationId: ctx.org.id, siteId: ctx.site.id, title: values.title, slug: entry.slug, template: values.template,
      content: document, contentHash: contentHashOf(document), updatedBy: ctx.actor.userId,
    });
    await record(
      tx,
      { action: "entry.created", resourceType: "entry", resourceId: entry.id, siteId: ctx.site.id, metadata: { type: definition.key, title: titleForLog(values.title), path: entry.path } },
      ctx,
    );
    return { entry: summaryOf(entry), events: [] };
  });
}

/**
 * The site's Home page, made with the site (M5-3 criterion 1; ADR 0011
 * hand-off): a draft page at `/` (plan §5, migration 0005) with the slug
 * `home`, and `site_settings.homepage_entry_id` pointing at it. Called by
 * `createSite` inside its transaction, with the site it has just inserted:
 * the ids come from that row, never from a request. The site's own
 * `site.created` record covers it; it adds none of its own.
 */
export async function createHomePage(tx: TenantTx, ctx: OrgContext, site: { id: string; locale: string }): Promise<string> {
  const document = emptyDocument();
  const entry = await insertEntry(tx, {
    organizationId: ctx.org.id, siteId: site.id, type: "page", locale: site.locale, authorId: ctx.actor.userId, title: "Home", slug: "home", path: HOME_PATH,
    createdBy: ctx.actor.userId, updatedBy: ctx.actor.userId,
  });
  await insertDraft(tx, {
    entryId: entry.id, organizationId: ctx.org.id, siteId: site.id, title: "Home", slug: "home", content: document, contentHash: contentHashOf(document),
    updatedBy: ctx.actor.userId,
  });
  await setHomepageEntry(tx, ctx.org.id, site.id, entry.id);
  return entry.id;
}

/**
 * Saves the draft (plan §6.3 autosave; cms-architecture §9.1): only the fields
 * sent, only if the draft is still at `expectedVersion`, and the version moves
 * on by one. Two tabs saving from the same version: one wins, the other gets
 * a Conflict and nothing it sent is written. Nothing public changes, nothing
 * is recorded (autosave runs every few seconds) and nothing is flushed.
 *
 * What is checked, besides who may: the document (closed schema, 1 MB, 2,000
 * nodes); a slug someone typed (used as typed, or refused: never suffixed;
 * not a reserved path); fields the type does not have; terms (each one a term
 * of this site, of a taxonomy the type uses); the featured image (of this site:
 * the composite key).
 */
export async function saveDraft(ctx: SiteContext, entryId: string, expectedVersion: number, input: DraftInput): Promise<{ version: number }> {
  const version = parseInput(versionSchema, expectedVersion);
  return inTenant(ctx, async (tx) => {
    const entry = await findEntry(tx, ctx.org.id, ctx.site.id, entryId);
    if (!entry) throw notFound();
    if (!canUpdateEntry(ctx, refOf(entry))) throw forbidden();
    if (input && typeof input === "object" && "termIds" in input && !canAssignTerms(ctx)) throw forbidden();
    const draft = parseInput(draftSchema, input);
    const definition = definitionOf(entry);

    const unsupported: Record<string, string[]> = {};
    if (draft.excerpt && !definition.supports.excerpt) unsupported.excerpt = [`${definition.label.plural} have no excerpt.`];
    if (draft.featuredMediaId && !definition.supports.featuredImage) unsupported.featuredMediaId = [`${definition.label.plural} have no featured image.`];
    if (draft.template && !definition.supports.templates) unsupported.template = [`${definition.label.plural} have no template.`];
    if (draft.termIds?.length && definition.supports.taxonomies.length === 0) unsupported.termIds = [`${definition.label.plural} have no categories or tags.`];
    if (Object.keys(unsupported).length) throw validationError(unsupported);

    const values: Parameters<typeof updateDraftIfVersion>[5] = { updatedBy: ctx.actor.userId };
    if (draft.title !== undefined) values.title = draft.title;
    if (draft.excerpt !== undefined) values.excerpt = draft.excerpt;
    if (draft.template !== undefined) values.template = draft.template;
    if (draft.featuredMediaId !== undefined) values.featuredMediaId = draft.featuredMediaId;
    if (draft.content !== undefined) {
      const parsed = parseDocument(draft.content);
      if (!parsed.ok) throw validationError({ content: [documentProblem(parsed)] });
      // Images and links new in this save must be this site's (M5-5).
      await assertNewReferences(tx, ctx, parsed.document, (await findDraft(tx, ctx.org.id, ctx.site.id, entry.id))?.content);
      values.content = parsed.document;
      values.contentHash = contentHashOf(parsed.document);
    }
    if (draft.fields !== undefined) {
      const fields = definition.fields.safeParse(draft.fields);
      if (!fields.success) throw validationError({ fields: [`${definition.label.plural} have no such fields.`] });
      values.fields = fields.data;
    }
    if (draft.slug !== undefined) {
      const site = await siteFacts(tx, ctx.org.id, ctx.site.id);
      if (!site) throw notFound();
      // The Home page stays at `/` whatever its slug. Any other entry's slug must give an address it may have.
      if (entry.path !== HOME_PATH) {
        const path = definition.key === "post" ? postPath(draft.slug, site.blogPath) : pathUnder(parentDir(entry.path), draft.slug);
        const reserved = reservedPathReason(path, { type: definition.key, blogPath: site.blogPath });
        if (reserved) throw validationError({ slug: [reserved] });
      }
      values.slug = draft.slug;
    }
    if (draft.termIds !== undefined) {
      // The draft first, then the terms: the order a term's deletion takes too (term.repository.ts), so neither waits on the other forever.
      await findDraft(tx, ctx.org.id, ctx.site.id, entry.id, { lock: true });
      await assertTermsOfSite(tx, ctx, definition, draft.termIds);
      values.termIds = draft.termIds;
    }

    let saved: number | null;
    try {
      saved = await updateDraftIfVersion(tx, ctx.org.id, ctx.site.id, entry.id, version, values);
    } catch (error) {
      // The draft's featured image is a composite key: an image of another site, or none, is refused by the database.
      if (pgErrorOf(error)?.constraint === "entry_drafts_featured_media_fk") throw validationError({ featuredMediaId: ["Choose an image of this site."] });
      throw error;
    }
    if (saved === null) throw conflict(DRAFT_CHANGED);
    return { version: saved };
  });
}

/** Every id a term of this site, of a taxonomy the type uses. `entry_drafts.term_ids` has no foreign key, so this is the only check there is. */
export async function assertTermsOfSite(tx: TenantTx, ctx: SiteContext, definition: ContentTypeDefinition, termIds: readonly string[]): Promise<void> {
  if (termIds.length === 0) return;
  const found = await termsOfSite(tx, ctx.org.id, ctx.site.id, termIds);
  const allowed = new Set<string>(definition.supports.taxonomies);
  if (found.length !== new Set(termIds).size || found.some((term) => !allowed.has(term.taxonomy))) {
    // A term deleted since the editor listed it is no longer there, and is refused like any other: it is not put back (M5-8).
    throw validationError({ termIds: ["A category or tag chosen here no longer exists, or is not this site’s. Untick it, or reload the page."] });
  }
}

/**
 * Credits the entry to another member (M5-7; ADR 0016 hand-off): those who may edit it and may edit anyone's entries
 * of its type (Owner–Editor), and only to a member of the organization, as `createEntry` checks. The author is the
 * entry's, not the draft's: it changes at once, with an `entry.author_changed` record. Nothing public shows it, so
 * nothing is flushed.
 */
export async function changeAuthor(ctx: SiteContext, entryId: string, authorId: string): Promise<{ entry: EntrySummary; changed: boolean; events: CacheEvent[] }> {
  if (!z.uuid().safeParse(authorId).success) throw validationError({ authorId: ["Choose a member of this organization."] });
  return inTenant(ctx, async (tx) => {
    const entry = await findEntry(tx, ctx.org.id, ctx.site.id, entryId, { lock: true });
    if (!entry) throw notFound();
    if (!canChangeAuthor(ctx, refOf(entry))) throw forbidden();
    if (entry.authorId === authorId) return { entry: summaryOf(entry), changed: false, events: [] };
    const authorName = await memberName(tx, ctx.org.id, authorId);
    if (authorName === null) throw validationError({ authorId: ["Choose a member of this organization."] });
    const previousAuthorName = entry.authorId ? await memberName(tx, ctx.org.id, entry.authorId) : null;
    await updateEntry(tx, ctx.org.id, ctx.site.id, entry.id, { authorId, updatedBy: ctx.actor.userId });
    await record(
      tx,
      {
        action: "entry.author_changed", resourceType: "entry", resourceId: entry.id, siteId: ctx.site.id,
        metadata: {
          type: entry.type, title: titleForLog(entry.title), authorName: titleForLog(authorName),
          ...(previousAuthorName ? { previousAuthorName: titleForLog(previousAuthorName) } : {}),
        },
      },
      ctx,
    );
    return { entry: { ...summaryOf(entry), authorId }, changed: true, events: [] };
  });
}
