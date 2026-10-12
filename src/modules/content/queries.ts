import "server-only";
import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { inTenant, requirePermission, type SiteContext } from "@/modules/tenancy";
import * as t from "@/platform/db/schema";
import { notFound } from "@/platform/errors";
import { HOME_PATH } from "./paths";
import { canPublishEntry, canUpdateEntry } from "./policies";
import { findDraft, findEntry, revisionById } from "./repository";
import { entries, entryDrafts } from "./schema";
import type { ContentTypeKey } from "./types/definition";
import { refOf } from "./entry.service";

/**
 * What the admin reads of entries (M5-4): one entry for its editor, and the
 * search behind the editor's link picker. Every read names the context's
 * organization and site; reading takes `entries.{type}.read`, which every
 * member holds (plan §13). The lists are M5-7's.
 */

export type EditorEntry = {
  id: string;
  type: ContentTypeKey;
  status: string;
  /** The live path (published) or the path the entry will have (draft); `/` for the Home page. */
  path: string;
  isHome: boolean;
  draft: { title: string; slug: string; content: unknown; version: number };
  /** The draft version that is live, if the entry is published. */
  publishedDraftVersion: number | null;
  /** What the caller may do: the same policies the services ask (ADR 0016). For the screen only. */
  canEdit: boolean;
  canPublish: boolean;
};

/**
 * The entry and its draft, for its editor. An id of another site (even of the
 * same organization), of another type than the URL says, or of an entry in
 * the trash, is not found.
 */
export async function getEntryForEditor(ctx: SiteContext, entryId: string, type: ContentTypeKey): Promise<EditorEntry> {
  requirePermission(ctx, type === "page" ? "entries.page.read" : "entries.post.read");
  return inTenant(ctx, async (tx) => {
    const entry = await findEntry(tx, ctx.org.id, ctx.site.id, entryId);
    if (!entry || entry.type !== type) throw notFound();
    const draft = await findDraft(tx, ctx.org.id, ctx.site.id, entry.id);
    if (!draft) throw notFound();
    const live = entry.publishedRevisionId ? await revisionById(tx, ctx.org.id, ctx.site.id, entry.id, entry.publishedRevisionId) : null;
    return {
      id: entry.id,
      type: entry.type,
      status: entry.status,
      path: entry.path,
      isHome: entry.path === HOME_PATH,
      draft: { title: draft.title, slug: draft.slug, content: draft.content, version: draft.version },
      publishedDraftVersion: live?.sourceDraftVersion ?? null,
      canEdit: canUpdateEntry(ctx, refOf(entry)),
      canPublish: canPublishEntry(ctx, refOf(entry)),
    };
  });
}

export type EntryMatch = { id: string; type: ContentTypeKey; title: string; path: string; status: string };

export const ENTRY_SEARCH_LIMIT = 10;
const QUERY_MAX = 100;

/** `%`, `_` and `\` typed by someone are letters, not patterns. */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Pages and posts of the site whose title (as drafted, or as published)
 * contains the text, most recently changed first: the link picker's list
 * (`entry:{id}` links, plan §6.1). An empty text lists the latest. Trashed
 * entries are left out.
 */
export async function searchEntries(ctx: SiteContext, query: string): Promise<EntryMatch[]> {
  requirePermission(ctx, "entries.page.read");
  requirePermission(ctx, "entries.post.read");
  const text = query.trim().slice(0, QUERY_MAX);
  return inTenant(ctx, async (tx) => {
    const pattern = `%${escapeLike(text)}%`;
    const rows = await tx
      .select({ id: entries.id, type: entries.type, title: entryDrafts.title, liveTitle: entries.title, path: entries.path, status: entries.status })
      .from(entries)
      .innerJoin(entryDrafts, and(eq(entryDrafts.organizationId, entries.organizationId), eq(entryDrafts.siteId, entries.siteId), eq(entryDrafts.entryId, entries.id)))
      .where(
        and(
          eq(entries.organizationId, ctx.org.id),
          eq(entries.siteId, ctx.site.id),
          isNull(entries.deletedAt),
          sql`exists (select 1 from ${t.sites} s where s.id = ${entries.siteId} and s.deleted_at is null)`,
          text ? or(ilike(entryDrafts.title, pattern), ilike(entries.title, pattern)) : undefined,
        ),
      )
      .orderBy(desc(entries.updatedAt), desc(entries.id))
      .limit(ENTRY_SEARCH_LIMIT);
    return rows.map((row) => ({ id: row.id, type: row.type, title: row.title || row.liveTitle, path: row.path, status: row.status }));
  });
}
