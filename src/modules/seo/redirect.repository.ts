import "server-only";
import { and, asc, count, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { readReading } from "@/modules/sites/shared";
import type { TenantTx } from "@/platform/db";
import { domains, entries, redirects, sites, siteSettings, terms } from "@/platform/db/schema";
import { archivePath, blogRouteOf, type RedirectStatus } from "./redirects";

/**
 * The redirects' rows, and what the site serves now (M8-5). Every query names the organization and the site (RLS keeps
 * organizations apart, not two sites of one); the caller's transaction is the tenant's. The site's pages, posts and
 * terms are read here as the media library reads them for its usage warning: by their tables, read-only.
 */

export type RedirectRow = {
  id: string;
  sourcePath: string;
  destination: string;
  statusCode: RedirectStatus;
  origin: "manual" | "auto";
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const COLUMNS = {
  id: redirects.id, sourcePath: redirects.sourcePath, destination: redirects.destination, statusCode: redirects.statusCode, origin: redirects.origin,
  isActive: redirects.isActive, createdAt: redirects.createdAt, updatedAt: redirects.updatedAt,
};
const ofSite = (organizationId: string, siteId: string) => and(eq(redirects.organizationId, organizationId), eq(redirects.siteId, siteId));
const asRow = (row: Omit<RedirectRow, "statusCode"> & { statusCode: number }): RedirectRow => ({ ...row, statusCode: row.statusCode as RedirectStatus });

/**
 * Every write to a site's redirects takes this first, after any lock the change itself holds (an entry, the site's
 * settings row, a term): writes that read the map to flatten it or to look for a loop then take turns, so two at the
 * same moment cannot make a chain or a loop that neither saw. Released at the end of the transaction.
 */
export async function lockRedirects(tx: TenantTx, siteId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`forge:redirects:${siteId}`}, 0))`);
}

/** The site's active redirects, source → destination (the rows to flatten and to follow for loops). */
export async function activeMap(tx: TenantTx, organizationId: string, siteId: string): Promise<Map<string, string>> {
  const rows = await tx
    .select({ source: redirects.sourcePath, destination: redirects.destination })
    .from(redirects)
    .where(and(ofSite(organizationId, siteId), eq(redirects.isActive, true)));
  return new Map(rows.map((row) => [row.source, row.destination]));
}

export async function findRedirect(tx: TenantTx, organizationId: string, siteId: string, id: string, options: { lock?: boolean } = {}): Promise<RedirectRow | null> {
  const query = tx.select(COLUMNS).from(redirects).where(and(ofSite(organizationId, siteId), eq(redirects.id, id)));
  const [row] = options.lock ? await query.for("update") : await query;
  return row ? asRow(row) : null;
}

export async function findBySource(tx: TenantTx, organizationId: string, siteId: string, sourcePath: string): Promise<RedirectRow | null> {
  const [row] = await tx.select(COLUMNS).from(redirects).where(and(ofSite(organizationId, siteId), eq(redirects.sourcePath, sourcePath)));
  return row ? asRow(row) : null;
}

export async function countRedirects(tx: TenantTx, organizationId: string, siteId: string): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(redirects).where(ofSite(organizationId, siteId));
  return row?.n ?? 0;
}

type Write = { sourcePath: string; destination: string; statusCode: RedirectStatus; origin: "manual" | "auto"; isActive: boolean; createdBy: string | null };

export async function insertRedirect(tx: TenantTx, organizationId: string, siteId: string, write: Write): Promise<RedirectRow> {
  const [row] = await tx.insert(redirects).values({ organizationId, siteId, ...write }).returning(COLUMNS);
  return asRow(row!);
}

/**
 * The redirect from `sourcePath`, made or replaced: a path that changed (or an unpublished page sent elsewhere) takes
 * its old address over from whatever redirect was left there, turned off when content took the address.
 */
export async function upsertRedirect(tx: TenantTx, organizationId: string, siteId: string, write: Write): Promise<RedirectRow> {
  const [row] = await tx
    .insert(redirects)
    .values({ organizationId, siteId, ...write })
    .onConflictDoUpdate({
      target: [redirects.siteId, redirects.sourcePath],
      set: { destination: write.destination, statusCode: write.statusCode, origin: write.origin, isActive: write.isActive, createdBy: write.createdBy, updatedAt: sql`now()` },
    })
    .returning(COLUMNS);
  return asRow(row!);
}

export async function updateRedirectRow(
  tx: TenantTx, organizationId: string, siteId: string, id: string, change: Partial<Pick<RedirectRow, "destination" | "statusCode" | "isActive">>,
): Promise<RedirectRow | null> {
  const [row] = await tx.update(redirects).set({ ...change, updatedAt: sql`now()` }).where(and(ofSite(organizationId, siteId), eq(redirects.id, id))).returning(COLUMNS);
  return row ? asRow(row) : null;
}

export async function deleteRedirectRow(tx: TenantTx, organizationId: string, siteId: string, id: string): Promise<boolean> {
  const rows = await tx.delete(redirects).where(and(ofSite(organizationId, siteId), eq(redirects.id, id))).returning({ id: redirects.id });
  return rows.length > 0;
}

/** Turns off the active redirects from these addresses (content now lives there). Returns what they were. */
export async function deactivateSources(tx: TenantTx, organizationId: string, siteId: string, paths: readonly string[]): Promise<{ source: string; destination: string }[]> {
  if (!paths.length) return [];
  return tx
    .update(redirects)
    .set({ isActive: false, updatedAt: sql`now()` })
    .where(and(ofSite(organizationId, siteId), eq(redirects.isActive, true), inArray(redirects.sourcePath, [...new Set(paths)])))
    .returning({ source: redirects.sourcePath, destination: redirects.destination });
}

/** Points the active redirects that end at `from` at `to` instead (a chain flattened: at most one hop). */
export async function redirectDestinations(tx: TenantTx, organizationId: string, siteId: string, from: string, to: string): Promise<number> {
  const rows = await tx
    .update(redirects)
    .set({ destination: to, updatedAt: sql`now()` })
    .where(and(ofSite(organizationId, siteId), eq(redirects.isActive, true), eq(redirects.destination, from), sql`${redirects.sourcePath} <> ${to}`))
    .returning({ id: redirects.id });
  return rows.length;
}

/** A page of the site's redirects, newest first, matching `query` in either address when given. */
export async function redirectsPage(
  tx: TenantTx, organizationId: string, siteId: string, options: { query: string; offset: number; limit: number },
): Promise<{ rows: RedirectRow[]; total: number }> {
  const like = options.query ? `%${options.query.replace(/[\\%_]/g, (char) => `\\${char}`)}%` : null;
  const where = and(ofSite(organizationId, siteId), like ? or(ilike(redirects.sourcePath, like), ilike(redirects.destination, like)) : undefined);
  const [rows, [total]] = await Promise.all([
    tx.select(COLUMNS).from(redirects).where(where).orderBy(sql`${redirects.updatedAt} desc`, asc(redirects.sourcePath)).limit(options.limit).offset(options.offset),
    tx.select({ n: count() }).from(redirects).where(where),
  ]);
  return { rows: rows.map(asRow), total: total?.n ?? 0 };
}

// ── What the site serves now ─────────────────────────────────────────────────

export type SiteRouting = { name: string; locale: string; blogPath: string; notFoundEntryId: string | null };

/** The site's name, language and blog path (what its routes depend on), and its not-found page. */
export async function siteRouting(tx: TenantTx, organizationId: string, siteId: string): Promise<SiteRouting | null> {
  const [row] = await tx
    .select({ name: sites.name, locale: sites.defaultLocale, reading: siteSettings.reading, notFoundEntryId: siteSettings.notFoundEntryId })
    .from(sites)
    .leftJoin(siteSettings, and(eq(siteSettings.siteId, sites.id), eq(siteSettings.organizationId, sites.organizationId)))
    .where(and(eq(sites.organizationId, organizationId), eq(sites.id, siteId), isNull(sites.deletedAt)));
  return row ? { name: row.name, locale: row.locale, blogPath: readReading(row.reading).blogPath, notFoundEntryId: row.notFoundEntryId } : null;
}

export type Served = "home" | "entry" | "blog" | "archive" | "list-page";

/**
 * Which of these paths the site answers now, and as what (the public routes' rules, rendering/routes.ts): `/` always
 * (its Home page, or its name and tagline); a published entry's exact path, in the site's language; the blog's index;
 * an existing category's or tag's archive; and any later page of a list, whether or not it has posts yet (its
 * address belongs to the blog). Every other path is free.
 */
export async function servedPaths(tx: TenantTx, organizationId: string, siteId: string, routing: SiteRouting, paths: readonly string[]): Promise<Map<string, Served>> {
  const served = new Map<string, Served>();
  const wanted = [...new Set(paths)];
  const archives: { path: string; taxonomy: "category" | "tag"; slug: string }[] = [];
  for (const path of wanted) {
    if (path === "/") {
      served.set(path, "home");
      continue;
    }
    const route = blogRouteOf(path, routing.blogPath);
    if (route?.kind === "index") served.set(path, "blog");
    else if (route?.kind === "list-page") served.set(path, "list-page");
    else if (route?.kind === "archive") archives.push({ path, taxonomy: route.taxonomy, slug: route.slug });
  }
  const rest = wanted.filter((path) => !served.has(path) && !archives.some((one) => one.path === path));
  if (rest.length) {
    const rows = await tx
      .select({ path: entries.path })
      .from(entries)
      .where(
        and(
          eq(entries.organizationId, organizationId), eq(entries.siteId, siteId), eq(entries.locale, routing.locale), eq(entries.status, "published"),
          isNull(entries.deletedAt), inArray(entries.path, rest),
        ),
      );
    for (const row of rows) served.set(row.path, "entry");
  }
  if (archives.length) {
    const rows = await tx
      .select({ taxonomy: terms.taxonomy, slug: terms.slug })
      .from(terms)
      .where(and(eq(terms.organizationId, organizationId), eq(terms.siteId, siteId), inArray(terms.slug, [...new Set(archives.map((one) => one.slug))])));
    for (const row of rows) served.set(archivePath(routing.blogPath, row.taxonomy, row.slug), "archive");
  }
  return served;
}

/** Every category's and tag's slug (a new blog path moves all their archives). */
export async function termSlugsOfSite(tx: TenantTx, organizationId: string, siteId: string): Promise<{ taxonomy: "category" | "tag"; slug: string }[]> {
  return tx.select({ taxonomy: terms.taxonomy, slug: terms.slug }).from(terms).where(and(eq(terms.organizationId, organizationId), eq(terms.siteId, siteId)));
}

/** The site's platform address (`/s/{address}` in V1), for the page's hints. */
export async function siteAddress(tx: TenantTx, organizationId: string, siteId: string): Promise<string | null> {
  const [row] = await tx
    .select({ hostname: domains.hostname })
    .from(domains)
    .where(and(eq(domains.organizationId, organizationId), eq(domains.siteId, siteId), eq(domains.kind, "subdomain"), eq(domains.status, "active")))
    .limit(1);
  return row?.hostname ?? null;
}

// ── The not-found page ───────────────────────────────────────────────────────

export type PageChoice = { id: string; title: string; path: string; type: string; status: string; deleted: boolean };

export async function entryChoice(tx: TenantTx, organizationId: string, siteId: string, id: string): Promise<PageChoice | null> {
  const [row] = await tx
    .select({ id: entries.id, title: entries.title, path: entries.path, type: entries.type, status: entries.status, deletedAt: entries.deletedAt })
    .from(entries)
    .where(and(eq(entries.organizationId, organizationId), eq(entries.siteId, siteId), eq(entries.id, id)));
  return row ? { id: row.id, title: row.title, path: row.path, type: row.type, status: row.status, deleted: row.deletedAt !== null } : null;
}

/** Names the site's not-found page (null: the theme's). Returns false if the site has no settings row. */
export async function setNotFoundEntry(tx: TenantTx, organizationId: string, siteId: string, entryId: string | null, by: string): Promise<boolean> {
  const rows = await tx
    .update(siteSettings)
    .set({ notFoundEntryId: entryId, updatedBy: by, updatedAt: sql`now()` })
    .where(and(eq(siteSettings.organizationId, organizationId), eq(siteSettings.siteId, siteId)))
    .returning({ siteId: siteSettings.siteId });
  return rows.length > 0;
}
