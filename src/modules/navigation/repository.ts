import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { TenantTx } from "@/platform/db";
import { entries, entryDrafts, menus, siteSettings, terms } from "@/platform/db/schema";
import type { MenuLocation } from "./shared";

/**
 * The menus' rows, and what their items point at (M8-3). Every query names the organization and the site (RLS keeps
 * organizations apart, not two sites of one); the caller's transaction is the tenant's.
 */

export type MenuRow = { id: string; location: MenuLocation; items: unknown; version: number };

const ofSite = (organizationId: string, siteId: string) => and(eq(menus.organizationId, organizationId), eq(menus.siteId, siteId));

export async function menusOfSite(tx: TenantTx, organizationId: string, siteId: string): Promise<MenuRow[]> {
  return tx.select({ id: menus.id, location: menus.location, items: menus.items, version: menus.version }).from(menus).where(ofSite(organizationId, siteId));
}

export async function findMenu(tx: TenantTx, organizationId: string, siteId: string, location: MenuLocation): Promise<MenuRow | null> {
  const [row] = await tx
    .select({ id: menus.id, location: menus.location, items: menus.items, version: menus.version })
    .from(menus)
    .where(and(ofSite(organizationId, siteId), eq(menus.location, location)));
  return row ?? null;
}

type Write = { organizationId: string; siteId: string; location: MenuLocation; items: unknown[]; updatedBy: string };

/** The site's first menu at this location (version 1), or null if one was made meanwhile (`menus_site_location_unique`). */
export async function insertMenu(tx: TenantTx, write: Write): Promise<{ id: string; version: number } | null> {
  const [row] = await tx
    .insert(menus)
    .values({ organizationId: write.organizationId, siteId: write.siteId, location: write.location, items: write.items, updatedBy: write.updatedBy })
    .onConflictDoNothing({ target: [menus.siteId, menus.location] })
    .returning({ id: menus.id, version: menus.version });
  return row ?? null;
}

/** The menu's items, if it is still at `version` (then at `version + 1`); null if it was saved meanwhile. */
export async function updateMenu(tx: TenantTx, write: Write & { version: number }): Promise<{ id: string; version: number } | null> {
  const [row] = await tx
    .update(menus)
    .set({ items: write.items, updatedBy: write.updatedBy, version: sql`${menus.version} + 1`, updatedAt: sql`now()` })
    .where(and(ofSite(write.organizationId, write.siteId), eq(menus.location, write.location), eq(menus.version, write.version)))
    .returning({ id: menus.id, version: menus.version });
  return row ?? null;
}

/**
 * The site's entries among `ids`, as the editor shows them: the published title for a live one, the draft's otherwise;
 * trashed ones too (`deletedAt`). An id that is not this site's (another site's, or purged) is simply not returned.
 */
export async function entryTargets(tx: TenantTx, organizationId: string, siteId: string, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return tx
    .select({ id: entries.id, type: entries.type, status: entries.status, deletedAt: entries.deletedAt, title: entries.title, draftTitle: entryDrafts.title, path: entries.path })
    .from(entries)
    .leftJoin(entryDrafts, and(eq(entryDrafts.organizationId, entries.organizationId), eq(entryDrafts.siteId, entries.siteId), eq(entryDrafts.entryId, entries.id)))
    .where(and(eq(entries.organizationId, organizationId), eq(entries.siteId, siteId), inArray(entries.id, [...ids])));
}

/** The site's categories and tags among `ids`. */
export async function termTargets(tx: TenantTx, organizationId: string, siteId: string, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return tx
    .select({ id: terms.id, taxonomy: terms.taxonomy, name: terms.name, slug: terms.slug })
    .from(terms)
    .where(and(eq(terms.organizationId, organizationId), eq(terms.siteId, siteId), inArray(terms.id, [...ids])));
}

/** The editor's list of categories to link (a site has few), by name. */
export const CATEGORY_CHOICES_MAX = 500;
export async function categoriesOfSite(tx: TenantTx, organizationId: string, siteId: string) {
  return tx
    .select({ id: terms.id, name: terms.name, slug: terms.slug })
    .from(terms)
    .where(and(eq(terms.organizationId, organizationId), eq(terms.siteId, siteId), eq(terms.taxonomy, "category")))
    .orderBy(asc(terms.name), asc(terms.id))
    .limit(CATEGORY_CHOICES_MAX);
}

/** The site's reading settings as stored (the blog's path). */
export async function readingOf(tx: TenantTx, organizationId: string, siteId: string): Promise<unknown> {
  const [row] = await tx
    .select({ reading: siteSettings.reading })
    .from(siteSettings)
    .where(and(eq(siteSettings.organizationId, organizationId), eq(siteSettings.siteId, siteId)));
  return row?.reading ?? null;
}
