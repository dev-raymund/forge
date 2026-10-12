import "server-only";
import { and, count, desc, eq, exists, inArray, isNull } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import { parseDocument } from "@/modules/content/shared";
import { CMS_CACHE_PROFILE, tags } from "@/platform/cache";
import { withTenant } from "@/platform/db";
import { entries, entryRevisions, entryTerms, terms } from "@/platform/db/schema";
import { logger } from "@/platform/observability";
import { renderDocument } from "./document";
import { routeFor } from "./routes";

/**
 * What a live site publishes (M5-6, plan §10, §20): the public read path for
 * content, next to the site's (./queries.ts). Each function is `'use cache'`,
 * keyed by the tenant it is given (organization, site, locale) and tagged so
 * the changes that alter its answer flush it (platform/cache/events.ts):
 *
 *   resolveRoute     path → entry, blog index or archive     site:{id}, site:{id}:routes
 *   loadEntry        one entry's published revision          site:{id}, site:{id}:entry:{eid}
 *   loadPostList     the blog index and the archives          site:{id}, site:{id}:list:post
 *   livePaths        where `entry:{id}` links go               site:{id}, site:{id}:routes
 *
 * Only published entries, never in the trash, of this site and this locale:
 * every query names the organization and the site (RLS holds as well), and
 * content comes from the revision the entry's `published_revision_id` names,
 * never from the draft. Nothing reads a cookie, a header or a session.
 */

const live = (orgId: string, siteId: string, locale: string) =>
  and(eq(entries.organizationId, orgId), eq(entries.siteId, siteId), eq(entries.locale, locale), eq(entries.status, "published"), isNull(entries.deletedAt));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type Taxonomy = "category" | "tag";
export type PublicTerm = { name: string; slug: string; description: string };

export type RouteMatch =
  | { kind: "entry"; entryId: string; type: "page" | "post" }
  /** `/` of a live site whose Home page is not published, or that has none (sites made before M5-3): its name and tagline, as in M4-3. */
  | { kind: "site-home" }
  | { kind: "blog-index"; page: number }
  | { kind: "term-archive"; taxonomy: Taxonomy; termId: string; term: PublicTerm; page: number };

/** What a public path names on a site, or null. `blogPath` is the site's current one (reading settings): part of the key. */
export async function resolveRoute(orgId: string, siteId: string, locale: string, blogPath: string, segments: readonly string[]): Promise<RouteMatch | null> {
  "use cache";
  cacheLife(CMS_CACHE_PROFILE);
  cacheTag(tags.site(siteId), tags.routes(siteId));
  const candidate = routeFor(segments, blogPath);
  if (!candidate) return null;
  if (candidate.kind === "blog-index") return candidate;
  return withTenant({ orgId }, async (tx) => {
    if (candidate.kind === "term-archive") {
      const [term] = await tx
        .select({ id: terms.id, name: terms.name, slug: terms.slug, description: terms.description })
        .from(terms)
        .where(and(eq(terms.organizationId, orgId), eq(terms.siteId, siteId), eq(terms.taxonomy, candidate.taxonomy), eq(terms.slug, candidate.slug)));
      if (!term) return null;
      return { kind: "term-archive", taxonomy: candidate.taxonomy, termId: term.id, term: { name: term.name, slug: term.slug, description: term.description }, page: candidate.page };
    }
    const [entry] = await tx
      .select({ id: entries.id, type: entries.type })
      .from(entries)
      .where(and(live(orgId, siteId, locale), eq(entries.path, candidate.path)));
    if (entry) return { kind: "entry", entryId: entry.id, type: entry.type };
    return candidate.path === "/" ? { kind: "site-home" } : null;
  });
}

export type PublishedEntry = {
  type: "page" | "post";
  title: string;
  path: string;
  /** The page template chosen for it (`default`, `full-width`, `landing`); null for the theme's default. */
  template: string | null;
  /** The published revision's document: migrated and checked when it passes (`parseDocument`), otherwise as stored (the renderer checks every node again). */
  content: unknown;
  publishedAt: string | null;
  terms: (PublicTerm & { taxonomy: Taxonomy })[];
};

/** One published entry, from its published revision. Null if it is not published (anymore), or not this site's. */
export async function loadEntry(orgId: string, siteId: string, entryId: string): Promise<PublishedEntry | null> {
  "use cache";
  cacheLife(CMS_CACHE_PROFILE);
  cacheTag(tags.site(siteId), tags.entry(siteId, entryId));
  if (!UUID.test(entryId)) return null;
  return withTenant({ orgId }, async (tx) => {
    const [row] = await tx
      .select({
        type: entries.type, path: entries.path, publishedAt: entries.publishedAt,
        title: entryRevisions.title, template: entryRevisions.template, content: entryRevisions.content,
      })
      .from(entries)
      .innerJoin(entryRevisions, and(eq(entryRevisions.id, entries.publishedRevisionId), eq(entryRevisions.entryId, entries.id), eq(entryRevisions.siteId, entries.siteId)))
      .where(and(eq(entries.organizationId, orgId), eq(entries.siteId, siteId), eq(entries.id, entryId), eq(entries.status, "published"), isNull(entries.deletedAt)));
    if (!row) return null;
    const assigned = await tx
      .select({ taxonomy: terms.taxonomy, name: terms.name, slug: terms.slug, description: terms.description })
      .from(entryTerms)
      .innerJoin(terms, and(eq(terms.id, entryTerms.termId), eq(terms.siteId, entryTerms.siteId)))
      .where(and(eq(entryTerms.organizationId, orgId), eq(entryTerms.siteId, siteId), eq(entryTerms.entryId, entryId)))
      .orderBy(terms.taxonomy, terms.name);
    const parsed = parseDocument(row.content);
    const content = parsed.ok ? parsed.document : row.content;
    reportUndrawable(siteId, row.path, content);
    return {
      type: row.type,
      title: row.title,
      path: row.path,
      template: row.template,
      content,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      terms: assigned,
    };
  });
}

/**
 * What of a published document a visitor will not see, logged once each time the entry is read into the cache
 * (not on every request): an image (its renderer is M6-4's), or a node that is unknown, invalid or out of place (a
 * damaged or legacy document). A button whose page is not live is not a fault of the document and is not reported.
 */
function reportUndrawable(siteId: string, path: string, content: unknown): void {
  const skipped = new Set<string>();
  renderDocument(content, { resolveEntryHref: () => "/", onSkip: (type, reason) => void (reason !== "not drawn" && skipped.add(`${type}: ${reason}`)) });
  if (skipped.size) logger.child({ module: "rendering", siteId }).warn("published content has blocks that are not drawn", { path, skipped: [...skipped] });
}

export type PostSummary = { title: string; path: string; excerpt: string; publishedAt: string | null };

/** A page of the site's published posts, newest first; only a term's when `termId` is given. `total` counts them all. */
export async function loadPostList(
  orgId: string, siteId: string, locale: string, page: number, perPage: number, termId: string | null,
): Promise<{ posts: PostSummary[]; total: number }> {
  "use cache";
  cacheLife(CMS_CACHE_PROFILE);
  cacheTag(tags.site(siteId), tags.list(siteId, "post"));
  if (termId !== null && !UUID.test(termId)) return { posts: [], total: 0 };
  return withTenant({ orgId }, async (tx) => {
    const tagged = termId
      ? exists(
          tx
            .select({ entryId: entryTerms.entryId })
            .from(entryTerms)
            .where(and(eq(entryTerms.siteId, siteId), eq(entryTerms.entryId, entries.id), eq(entryTerms.termId, termId))),
        )
      : undefined;
    const where = and(live(orgId, siteId, locale), eq(entries.type, "post"), tagged);
    const [{ total }] = (await tx.select({ total: count() }).from(entries).where(where)) as [{ total: number }];
    const rows = await tx
      .select({ title: entries.title, path: entries.path, excerpt: entries.excerpt, publishedAt: entries.publishedAt })
      .from(entries)
      .where(where)
      .orderBy(desc(entries.publishedAt), desc(entries.id))
      .limit(perPage)
      .offset((page - 1) * perPage);
    return { posts: rows.map((row) => ({ ...row, publishedAt: row.publishedAt?.toISOString() ?? null })), total };
  });
}

/** The live paths of the given entries of this site (`entry:{id}` links). An id that is not live here is left out. */
export async function livePaths(orgId: string, siteId: string, locale: string, entryIds: readonly string[]): Promise<Record<string, string>> {
  "use cache";
  cacheLife(CMS_CACHE_PROFILE);
  cacheTag(tags.site(siteId), tags.routes(siteId));
  const ids = entryIds.filter((id) => UUID.test(id));
  if (ids.length === 0) return {};
  const rows = await withTenant({ orgId }, (tx) =>
    tx.select({ id: entries.id, path: entries.path }).from(entries).where(and(live(orgId, siteId, locale), inArray(entries.id, ids))),
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.path]));
}
