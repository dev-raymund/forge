import "server-only";
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { imagePreviews, type ImagePreview } from "@/modules/media";
import { inTenant, requirePermission, type SiteContext } from "@/modules/tenancy";
import * as t from "@/platform/db/schema";
import { forbidden, notFound } from "@/platform/errors";
import { entryListPath } from "./admin-paths";
import { refOf } from "./entry.service";
import { POSTS_PAGE_SIZE, type PageListQuery, type PostListQuery } from "./list-query";
import { referencesOf } from "./document/references";
import { HOME_PATH } from "./paths";
import { ENTRY_TRASH_DAYS } from "./lifecycle";
import {
  canArrangePage, canChangeAuthor, canCreateTerm, canPublishEntry, canPurgeEntry, canSeeEntry, canSeePages, canSetHomepage, canTrashEntry, canUpdateEntry, ownPostsOnly,
} from "./policies";
import {
  descendantsOf, draftHead, findDraft, findEntry, latestScheduledRevision, memberName, revisionById, revisionHistory, scheduledOfSite, siteFacts,
} from "./repository";
import type { RevisionKind } from "./revisions";
import { entries, entryDrafts, entryRevisions, terms } from "./schema";
import type { ContentTypeKey } from "./types/definition";

/**
 * What the admin reads of entries (M5-4, M5-7): one entry for its editor, the
 * search behind the editor's link picker, the pages tree, the posts list and
 * the site's terms. Every read names the context's organization and site;
 * reading takes `entries.{type}.read`, which every member holds (plan §13),
 * and an Author sees only their own posts and no pages (`ownPostsOnly`).
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
  /**
   * The images the draft holds (its image blocks and its featured image) that are still usable, as the editor shows
   * them (M6-4): a thumbnail variant and a name. An id that is not here (trashed, removed) is shown as unavailable.
   */
  images: Record<string, ImagePreview>;
  /** What the caller may do: the same policies the services ask (ADR 0016). For the screen only. */
  canEdit: boolean;
  /**
   * The lifecycle (M7-1), for the screen: whether the caller may unpublish it and move it to the trash, and, for a
   * page, the pages below it that would go with it (and those that keep it out of the trash: published ones, the Home
   * page). The services check all of it again.
   */
  lifecycle: { canUnpublish: boolean; canTrash: boolean; below: number; liveBelow: string[]; homeBelow: boolean; trashPath: string };
  /**
   * Scheduling (M7-2): when it is scheduled for (an instant), the site's time zone it is typed and shown in, and why the
   * last schedule could not be published (until it is scheduled or published again).
   */
  schedule: { at: string | null; timeZone: string; failure: { reason: string; at: string } | null };
  canPublish: boolean;
  /** M5-7's sidebar: the draft's other fields, the entry's place and author, and what else the caller may do. */
  settings: {
    slug: string;
    template: string | null;
    excerpt: string;
    termIds: string[];
    featuredMediaId: string | null;
    parentId: string | null;
    authorId: string | null;
    /** The author's name while they are a member; null otherwise. */
    authorName: string | null;
    /** Where the entry's slug sits: the parent's path for a page, the blog's for a post (for checking a slug before it is saved). */
    blogPath: string;
    canArrange: boolean;
    canChangeAuthor: boolean;
    canSetHomepage: boolean;
    /** Add a category or a tag from the sidebar (M5-8): categories Owner–Editor, tags Owner–Author. */
    canCreateTerms: { category: boolean; tag: boolean };
  };
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
    // Another Author's post, or a page, to an Author: not found, as an entry of another site is (M5-7).
    if (!entry || entry.type !== type || !canSeeEntry(ctx, refOf(entry))) throw notFound();
    const draft = await findDraft(tx, ctx.org.id, ctx.site.id, entry.id);
    const site = await siteFacts(tx, ctx.org.id, ctx.site.id);
    if (!draft || !site) throw notFound();
    const live = entry.publishedRevisionId ? await revisionById(tx, ctx.org.id, ctx.site.id, entry.id, entry.publishedRevisionId) : null;
    const imageIds = [...referencesOf(draft.content).mediaIds, ...(draft.featuredMediaId ? [draft.featuredMediaId] : [])];
    const images = await imagePreviews(tx, ctx.org.id, ctx.site.id, imageIds);
    const below = entry.type === "page" ? await descendantsOf(tx, ctx.org.id, ctx.site.id, entry.id) : [];
    return {
      id: entry.id,
      type: entry.type,
      status: entry.status,
      path: entry.path,
      isHome: entry.path === HOME_PATH,
      draft: { title: draft.title, slug: draft.slug, content: draft.content, version: draft.version },
      publishedDraftVersion: live?.sourceDraftVersion ?? null,
      images,
      canEdit: canUpdateEntry(ctx, refOf(entry)),
      canPublish: canPublishEntry(ctx, refOf(entry)),
      lifecycle: {
        canUnpublish: canPublishEntry(ctx, refOf(entry)),
        canTrash: canTrashEntry(ctx, refOf(entry)),
        below: below.length,
        liveBelow: below.filter((row) => row.status !== "draft").map((row) => row.title || "Untitled"),
        homeBelow: below.some((row) => row.path === HOME_PATH),
        trashPath: `${entryListPath(ctx.org.slug, ctx.site.slug, entry.type)}?status=trash`,
      },
      schedule: {
        at: entry.scheduledAt?.toISOString() ?? null,
        timeZone: site.timeZone,
        failure: entry.scheduleFailure && entry.scheduleFailedAt ? { reason: entry.scheduleFailure, at: entry.scheduleFailedAt.toISOString() } : null,
      },
      settings: {
        slug: draft.slug,
        template: draft.template,
        excerpt: draft.excerpt,
        termIds: draft.termIds,
        featuredMediaId: draft.featuredMediaId,
        parentId: entry.parentId,
        authorId: entry.authorId,
        authorName: entry.authorId ? await memberName(tx, ctx.org.id, entry.authorId) : null,
        blogPath: site.blogPath,
        canArrange: canArrangePage(ctx, refOf(entry)),
        canChangeAuthor: canChangeAuthor(ctx, refOf(entry)),
        canSetHomepage: entry.type === "page" && canSetHomepage(ctx),
        canCreateTerms: { category: entry.type === "post" && canCreateTerm(ctx, "category"), tag: entry.type === "post" && canCreateTerm(ctx, "tag") },
      },
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
          // An Author finds what is public and their own posts, never another's draft or an unpublished page (M5-7).
          ownPostsOnly(ctx) ? or(eq(entries.status, "published"), and(eq(entries.type, "post"), eq(entries.authorId, ctx.actor.userId))) : undefined,
        ),
      )
      .orderBy(desc(entries.updatedAt), desc(entries.id))
      .limit(ENTRY_SEARCH_LIMIT);
    return rows.map((row) => ({ id: row.id, type: row.type, title: row.title || row.liveTitle, path: row.path, status: row.status }));
  });
}

// ── M5-7: the lists ───────────────────────────────────────────────────────────

/** The site's entries: those not in the trash, or (M7-1) only those in it. */
const ofSite = (ctx: SiteContext, inTrash = false) =>
  and(
    eq(entries.organizationId, ctx.org.id),
    eq(entries.siteId, ctx.site.id),
    inTrash ? sql`${entries.deletedAt} is not null` : isNull(entries.deletedAt),
    sql`exists (select 1 from ${t.sites} s where s.id = ${entries.siteId} and s.deleted_at is null)`,
  );
/** A list's status filter: the trash is not a status (it is `deleted_at`, M7-1). */
const statusFilter = (status: PageListQuery["status"]) => (status && status !== "trash" ? eq(entries.status, status) : undefined);

/**
 * An entry in the trash, as the trash lists show it (M7-1): when it went, when `trash.purge` deletes it, how many
 * pages went with it, whether it sits under a page in the trash (restore that one first), and what the caller may do.
 */
export type TrashInfo = { trashedAt: Date; purgeAt: Date; below: number; underTrashedPage: boolean; canRestore: boolean; canPurge: boolean };
const purgeDateOf = (trashedAt: Date) => new Date(trashedAt.getTime() + ENTRY_TRASH_DAYS * 24 * 3_600_000);
const draftOf = and(eq(entryDrafts.organizationId, entries.organizationId), eq(entryDrafts.siteId, entries.siteId), eq(entryDrafts.entryId, entries.id));
const liveRevisionOf = and(eq(entryRevisions.id, entries.publishedRevisionId), eq(entryRevisions.entryId, entries.id), eq(entryRevisions.siteId, entries.siteId));
const matching = (q: string | undefined): SQL | undefined => (q ? or(ilike(entryDrafts.title, `%${escapeLike(q)}%`), ilike(entries.title, `%${escapeLike(q)}%`)) : undefined);
/** Published, and the draft has been saved since: what the editor calls "unpublished changes". */
const changedSincePublished = sql<boolean>`coalesce(${entryRevisions.sourceDraftVersion} <> ${entryDrafts.version}, false)`;

export type PageListItem = {
  id: string;
  title: string;
  path: string;
  status: string;
  parentId: string | null;
  isHome: boolean;
  /** Published, with changes saved since. */
  changed: boolean;
  updatedAt: Date;
  /** In the trash (the trash filter, M7-1). */
  trash?: TrashInfo;
};

/** The most pages the tree shows at once. V1 sites are far below it; past it the list says so. */
export const PAGE_TREE_LIMIT = 1_000;

/**
 * The site's pages, in their tree order (parent, then `sort_order`, then title), not in the trash. Filtered by
 * status and by title (as drafted or as published). An Author is refused (pages are hidden from them): the screen
 * says "no access", and the query checks for itself.
 */
export async function listPages(ctx: SiteContext, query: PageListQuery = {}): Promise<{ items: PageListItem[]; truncated: boolean }> {
  requirePermission(ctx, "entries.page.read");
  if (!canSeePages(ctx)) throw forbidden();
  if (query.status === "trash") return trashedPages(ctx, query);
  return inTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: entries.id, title: entryDrafts.title, liveTitle: entries.title, path: entries.path, status: entries.status, parentId: entries.parentId,
        changed: changedSincePublished, updatedAt: entryDrafts.updatedAt,
      })
      .from(entries)
      .innerJoin(entryDrafts, draftOf)
      .leftJoin(entryRevisions, liveRevisionOf)
      .where(and(ofSite(ctx), eq(entries.type, "page"), statusFilter(query.status), matching(query.q)))
      .orderBy(asc(entries.sortOrder), asc(sql`lower(${entryDrafts.title})`), asc(entries.id))
      .limit(PAGE_TREE_LIMIT + 1);
    return {
      items: rows.slice(0, PAGE_TREE_LIMIT).map((row) => ({
        id: row.id, title: row.title || row.liveTitle, path: row.path, status: row.status, parentId: row.parentId, isHome: row.path === HOME_PATH,
        changed: row.changed, updatedAt: row.updatedAt,
      })),
      truncated: rows.length > PAGE_TREE_LIMIT,
    };
  });
}

/**
 * The site's pages in the trash (M7-1): one row for each trash of a page, with how many pages went with it (they come
 * back with it, and are not listed on their own), most recent first. A page trashed on its own under a page that was
 * trashed later is listed too, marked: it waits for that page to be restored.
 */
async function trashedPages(ctx: SiteContext, query: PageListQuery): Promise<{ items: PageListItem[]; truncated: boolean }> {
  return inTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: entries.id, title: entryDrafts.title, liveTitle: entries.title, path: entries.path, status: entries.status, parentId: entries.parentId,
        updatedAt: entryDrafts.updatedAt, deletedAt: entries.deletedAt, moment: sql<string>`${entries.deletedAt}::text`, authorId: entries.authorId,
        organizationId: entries.organizationId, type: entries.type,
      })
      .from(entries)
      .innerJoin(entryDrafts, draftOf)
      .where(and(ofSite(ctx, true), eq(entries.type, "page")))
      .orderBy(desc(entries.deletedAt), asc(entries.id))
      .limit(PAGE_TREE_LIMIT + 1);
    const byId = new Map(rows.map((row) => [row.id, row]));
    // Trashed together: the same moment, to the microsecond (compared as text, as stored).
    const withParent = (row: (typeof rows)[number]) => (row.parentId ? byId.get(row.parentId) : undefined);
    const isRoot = (row: (typeof rows)[number]) => withParent(row)?.moment !== row.moment;
    const below = new Map<string, number>();
    for (const row of rows) {
      if (isRoot(row)) continue;
      let up = withParent(row);
      while (up && !isRoot(up)) up = withParent(up);
      if (up) below.set(up.id, (below.get(up.id) ?? 0) + 1);
    }
    const q = query.q?.toLowerCase();
    const items = rows
      .filter((row) => isRoot(row) && (!q || (row.title || row.liveTitle).toLowerCase().includes(q)))
      .map((row) => {
        const ref = { type: row.type, organizationId: row.organizationId, authorId: row.authorId };
        return {
          id: row.id, title: row.title || row.liveTitle, path: row.path, status: row.status, parentId: row.parentId, isHome: false, changed: false, updatedAt: row.updatedAt,
          trash: {
            trashedAt: row.deletedAt!, purgeAt: purgeDateOf(row.deletedAt!), below: below.get(row.id) ?? 0, underTrashedPage: Boolean(withParent(row)),
            canRestore: canTrashEntry(ctx, ref), canPurge: canPurgeEntry(ctx, ref),
          },
        };
      });
    return { items, truncated: rows.length > PAGE_TREE_LIMIT };
  });
}

export type PostListItem = {
  id: string;
  title: string;
  path: string;
  status: string;
  authorId: string | null;
  /** The author's name while they are a member; null for someone who has left. */
  authorName: string | null;
  /** The draft's categories, by name. */
  categories: string[];
  changed: boolean;
  updatedAt: Date;
  publishedAt: Date | null;
  /** In the trash (the trash filter, M7-1). */
  trash?: TrashInfo;
  /** When it is scheduled for (M7-2). */
  scheduledAt: Date | null;
};

export type PostList = { items: PostListItem[]; total: number; page: number; pages: number; pageSize: number; onlyOwn: boolean; /** The site's, for scheduled times (M7-2). */ timeZone: string };

const POST_ORDER = {
  updated: [desc(entryDrafts.updatedAt), desc(entries.id)],
  published: [sql`${entries.publishedAt} desc nulls last`, desc(entries.id)],
  title: [asc(sql`lower(${entryDrafts.title})`), asc(entries.id)],
  oldest: [asc(entries.createdAt), asc(entries.id)],
} as const;

/**
 * A page of the site's posts, filtered by status, category (as drafted), author and title, in the order asked. An
 * Author gets their own posts only, whatever the URL asks: the filter is applied here, not in the screen.
 */
export async function listPosts(ctx: SiteContext, query: PostListQuery): Promise<PostList> {
  requirePermission(ctx, "entries.post.read");
  const onlyOwn = ownPostsOnly(ctx);
  const author = onlyOwn ? ctx.actor.userId : query.author;
  const inTrash = query.status === "trash";
  return inTenant(ctx, async (tx) => {
    const where = and(
      ofSite(ctx, inTrash),
      eq(entries.type, "post"),
      statusFilter(query.status),
      author ? eq(entries.authorId, author) : undefined,
      query.category ? sql`${entryDrafts.termIds} @> array[${query.category}]::uuid[]` : undefined,
      matching(query.q),
    );
    const [{ total }] = (await tx.select({ total: count() }).from(entries).innerJoin(entryDrafts, draftOf).where(where)) as [{ total: number }];
    const pages = Math.max(1, Math.ceil(total / POSTS_PAGE_SIZE));
    const page = Math.min(query.page, pages);
    const rows = await tx
      .select({
        id: entries.id, title: entryDrafts.title, liveTitle: entries.title, path: entries.path, status: entries.status, authorId: entries.authorId,
        authorName: t.users.name, termIds: entryDrafts.termIds, changed: changedSincePublished, updatedAt: entryDrafts.updatedAt, publishedAt: entries.publishedAt,
        deletedAt: entries.deletedAt, organizationId: entries.organizationId, scheduledAt: entries.scheduledAt,
      })
      .from(entries)
      .innerJoin(entryDrafts, draftOf)
      .leftJoin(entryRevisions, liveRevisionOf)
      .leftJoin(t.organizationMembers, and(eq(t.organizationMembers.organizationId, entries.organizationId), eq(t.organizationMembers.userId, entries.authorId)))
      .leftJoin(t.users, eq(t.users.id, t.organizationMembers.userId))
      .where(where)
      // The trash: most recently trashed first, whatever the sort (it is what will be purged last).
      .orderBy(...(inTrash ? [desc(entries.deletedAt), desc(entries.id)] : POST_ORDER[query.sort]))
      .limit(POSTS_PAGE_SIZE)
      .offset((page - 1) * POSTS_PAGE_SIZE);
    const termIds = [...new Set(rows.flatMap((row) => row.termIds))];
    const categories = termIds.length
      ? await tx
          .select({ id: terms.id, name: terms.name })
          .from(terms)
          .where(and(eq(terms.organizationId, ctx.org.id), eq(terms.siteId, ctx.site.id), eq(terms.taxonomy, "category"), inArray(terms.id, termIds)))
      : [];
    const nameOf = new Map(categories.map((term) => [term.id, term.name]));
    const site = await siteFacts(tx, ctx.org.id, ctx.site.id);
    return {
      timeZone: site?.timeZone ?? "UTC",
      items: rows.map((row) => ({
        id: row.id, title: row.title || row.liveTitle, path: row.path, status: row.status, authorId: row.authorId, authorName: row.authorName,
        categories: row.termIds.flatMap((id) => (nameOf.has(id) ? [nameOf.get(id)!] : [])).sort((a, b) => a.localeCompare(b)),
        changed: row.changed, updatedAt: row.updatedAt, publishedAt: row.publishedAt, scheduledAt: row.scheduledAt,
        ...(row.deletedAt
          ? {
              trash: (() => {
                const ref = { type: "post" as const, organizationId: row.organizationId, authorId: row.authorId };
                return { trashedAt: row.deletedAt, purgeAt: purgeDateOf(row.deletedAt), below: 0, underTrashedPage: false, canRestore: canTrashEntry(ctx, ref), canPurge: canPurgeEntry(ctx, ref) };
              })(),
            }
          : {}),
      })),
      total,
      page,
      pages,
      pageSize: POSTS_PAGE_SIZE,
      onlyOwn,
    };
  });
}

export type TermOption = { id: string; taxonomy: "category" | "tag"; name: string; slug: string };

/** The site's categories and tags, for the posts filter and the editor's sidebar. Managing them is M5-8's. */
export async function listTerms(ctx: SiteContext): Promise<TermOption[]> {
  requirePermission(ctx, "entries.post.read");
  return inTenant(ctx, (tx) =>
    tx
      .select({ id: terms.id, taxonomy: terms.taxonomy, name: terms.name, slug: terms.slug })
      .from(terms)
      .where(and(eq(terms.organizationId, ctx.org.id), eq(terms.siteId, ctx.site.id)))
      .orderBy(terms.taxonomy, asc(sql`lower(${terms.name})`), terms.id),
  );
}

// ── M7-2: what is scheduled ──────────────────────────────────────────────────

export type ScheduledItem = {
  id: string; type: ContentTypeKey; title: string; path: string;
  /** Scheduled for this instant; or null, when this is a schedule that failed lately. */
  scheduledAt: string | null;
  failure: { reason: string; at: string } | null;
};

/** Failures stay on the overview this long, unless the entry is scheduled or published again first. */
const FAILURES_SHOWN_DAYS = 14;

/**
 * The site's scheduled pages and posts, soonest first, and those whose schedule failed in the last two weeks (M7-2: the
 * site's overview). Only what the member may see (an Author: their own posts). Times are instants; the screen shows
 * them in the site's time zone, which comes with them.
 */
export async function listScheduled(ctx: SiteContext): Promise<{ items: ScheduledItem[]; timeZone: string }> {
  requirePermission(ctx, "entries.post.read");
  return inTenant(ctx, async (tx) => {
    const site = await siteFacts(tx, ctx.org.id, ctx.site.id);
    if (!site) throw notFound();
    const rows = await scheduledOfSite(tx, ctx.org.id, ctx.site.id, new Date(Date.now() - FAILURES_SHOWN_DAYS * 86_400_000), 50);
    return {
      timeZone: site.timeZone,
      items: rows
        .filter((row) => canSeeEntry(ctx, { type: row.type, organizationId: row.organizationId, authorId: row.authorId }))
        .slice(0, 20)
        .map((row) => ({
          id: row.id, type: row.type, title: row.draftTitle || row.title || "Untitled", path: row.path,
          scheduledAt: row.status === "scheduled" ? (row.scheduledAt?.toISOString() ?? null) : null,
          failure: row.status !== "scheduled" && row.scheduleFailure && row.scheduleFailedAt ? { reason: row.scheduleFailure, at: row.scheduleFailedAt.toISOString() } : null,
        })),
    };
  });
}

// ── M7-3: the history, and the conflict dialog ───────────────────────────────

/** How many revisions the history shows at a time ("Show older" asks for the next ones). */
export const HISTORY_PAGE_SIZE = 30;

export type RevisionItem = {
  id: string;
  number: number;
  kind: RevisionKind;
  label: string | null;
  /** The title the revision has. */
  title: string;
  createdAt: string;
  /** Who made it, while they are a member; null otherwise (shown as a former member). */
  by: string | null;
  byYou: boolean;
  /** The revision visitors see now. */
  live: boolean;
  /** The frozen revision of the schedule under way (M7-2): when it publishes. Null for every other one. */
  scheduledFor: string | null;
};

export type RevisionList = { items: RevisionItem[]; more: boolean; canRestore: boolean; timeZone: string };

/**
 * The entry's history, newest first, `HISTORY_PAGE_SIZE` at a time (before revision `before`). Who may see the entry
 * may see its history: an id of another site, a page to an Author, another Author's post, an entry in the trash, are
 * not found (M7-1: a trashed entry's history is reachable once it is restored). No content leaves here: the list shows
 * what each revision is, and restoring one is `restoreRevision`'s.
 */
export async function listRevisions(ctx: SiteContext, entryId: string, before?: number): Promise<RevisionList> {
  return inTenant(ctx, async (tx) => {
    const entry = await findEntry(tx, ctx.org.id, ctx.site.id, entryId);
    if (!entry || !canSeeEntry(ctx, refOf(entry))) throw notFound();
    const site = await siteFacts(tx, ctx.org.id, ctx.site.id);
    if (!site) throw notFound();
    const rows = await revisionHistory(tx, ctx.org.id, ctx.site.id, entry.id, { before, limit: HISTORY_PAGE_SIZE + 1 });
    const frozen = entry.status === "scheduled" && entry.scheduledAt ? await latestScheduledRevision(tx, ctx.org.id, ctx.site.id, entry.id) : null;
    return {
      items: rows.slice(0, HISTORY_PAGE_SIZE).map((row) => ({
        id: row.id,
        number: row.number,
        kind: row.kind as RevisionKind,
        label: row.label,
        title: row.title,
        createdAt: row.createdAt.toISOString(),
        by: row.createdByName,
        byYou: row.createdBy !== null && row.createdBy === ctx.actor.userId,
        live: row.id === entry.publishedRevisionId,
        scheduledFor: frozen && row.id === frozen.id ? entry.scheduledAt!.toISOString() : null,
      })),
      more: rows.length > HISTORY_PAGE_SIZE,
      canRestore: canUpdateEntry(ctx, refOf(entry)),
      timeZone: site.timeZone,
    };
  });
}

/** The draft as it is on the server, for the conflict dialog: its version, when it was saved and by whom. */
export type DraftHeadInfo = { version: number; savedAt: string; by: string | null; byYou: boolean };

export async function getDraftHead(ctx: SiteContext, entryId: string): Promise<DraftHeadInfo> {
  return inTenant(ctx, async (tx) => {
    const entry = await findEntry(tx, ctx.org.id, ctx.site.id, entryId);
    if (!entry || !canSeeEntry(ctx, refOf(entry))) throw notFound();
    const head = await draftHead(tx, ctx.org.id, ctx.site.id, entry.id);
    if (!head) throw notFound();
    return { version: head.version, savedAt: head.savedAt.toISOString(), by: head.savedByName, byYou: head.savedBy !== null && head.savedBy === ctx.actor.userId };
  });
}
