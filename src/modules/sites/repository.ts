import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { TenantTx } from "@/platform/db";
import { domains, entries, menus } from "@/platform/db/schema";
import { siteSettings, sites, SITE_STATUSES } from "./schema";
import type { SiteSummary } from "./shared";

/**
 * Queries of the sites module. Each takes the transaction of a tenant context
 * and names the organization in its WHERE clause as well: RLS already confines
 * them to the tenant, and they do not depend on it.
 *
 * `domains` is a platform table (no RLS: an address is looked up before any
 * tenant is known). Every query here that touches it says which organization
 * and which site, and the composite foreign key refuses a row whose site
 * belongs to another organization.
 */

export type SiteStatus = (typeof SITE_STATUSES)[number];
export type SiteRef = { id: string; organizationId: string; slug: string; name: string; status: SiteStatus };

/** A site of the transaction's organization, by its slug. A deleted site has no slug any more. */
export async function findSiteBySlug(tx: TenantTx, organizationId: string, slug: string): Promise<SiteRef | null> {
  const [row] = await tx
    .select({ id: sites.id, organizationId: sites.organizationId, slug: sites.slug, name: sites.name, status: sites.status })
    .from(sites)
    .where(and(eq(sites.organizationId, organizationId), eq(sites.slug, slug), isNull(sites.deletedAt)));
  return row ?? null;
}

/** The site's platform address (`/s/{address}`), or null while it has none. */
export async function siteAddress(tx: TenantTx, site: Pick<SiteRef, "id" | "organizationId">): Promise<string | null> {
  const [row] = await tx
    .select({ hostname: domains.hostname })
    .from(domains)
    .where(and(eq(domains.organizationId, site.organizationId), eq(domains.siteId, site.id), eq(domains.kind, "subdomain")));
  return row?.hostname ?? null;
}

const summary = {
  id: sites.id,
  slug: sites.slug,
  name: sites.name,
  status: sites.status,
  address: domains.hostname,
  language: sites.defaultLocale,
  timezone: sites.timezone,
  theme: sites.themeKey,
  createdAt: sites.createdAt,
};

/** The organization's sites that are not deleted, with their addresses, by name. */
export async function listSiteRows(tx: TenantTx, organizationId: string): Promise<SiteSummary[]> {
  return tx
    .select(summary)
    .from(sites)
    .leftJoin(domains, and(eq(domains.organizationId, sites.organizationId), eq(domains.siteId, sites.id), eq(domains.kind, "subdomain")))
    .where(and(eq(sites.organizationId, organizationId), isNull(sites.deletedAt)))
    .orderBy(asc(sites.name), asc(sites.createdAt));
}

/** One site of the organization, if it is still there. */
export async function findSiteRow(tx: TenantTx, organizationId: string, siteId: string): Promise<SiteSummary | null> {
  const [row] = await tx
    .select(summary)
    .from(sites)
    .leftJoin(domains, and(eq(domains.organizationId, sites.organizationId), eq(domains.siteId, sites.id), eq(domains.kind, "subdomain")))
    .where(and(eq(sites.organizationId, organizationId), eq(sites.id, siteId), isNull(sites.deletedAt)));
  return row ?? null;
}

/** The slugs the organization's sites hold now. A deleted site's slug is free again (the unique index skips it). */
export async function slugsInUse(tx: TenantTx, organizationId: string): Promise<Set<string>> {
  const rows = await tx.select({ slug: sites.slug }).from(sites).where(and(eq(sites.organizationId, organizationId), isNull(sites.deletedAt)));
  return new Set(rows.map((row) => row.slug));
}

export type NewSite = { organizationId: string; name: string; slug: string; language: string; timezone: string; createdBy: string };

/**
 * A site, its settings and its address: what a site is made of from its first
 * moment (plan §4, Phase 4). It starts `coming_soon`, with the theme the table
 * defaults to; the settings' groups start empty and their readers apply the
 * defaults (M4-2).
 */
export async function insertSite(tx: TenantTx, site: NewSite, address: string): Promise<SiteSummary> {
  const [row] = await tx
    .insert(sites)
    .values({ organizationId: site.organizationId, name: site.name, slug: site.slug, defaultLocale: site.language, timezone: site.timezone, createdBy: site.createdBy })
    .returning({
      id: sites.id, slug: sites.slug, name: sites.name, status: sites.status, language: sites.defaultLocale, timezone: sites.timezone, theme: sites.themeKey,
      createdAt: sites.createdAt,
    });
  if (!row) throw new Error("The site was not inserted");
  await tx.insert(siteSettings).values({ siteId: row.id, organizationId: site.organizationId, updatedBy: site.createdBy });
  // The platform address: a `subdomain` row whose hostname is the label (ADR 0006). Nothing to verify, so it is active at once,
  // and it is the site's primary (and, in V1, only) address. A taken address fails here, on the table's unique constraint.
  await tx.insert(domains).values({ organizationId: site.organizationId, siteId: row.id, hostname: address, kind: "subdomain", isPrimary: true, status: "active" });
  return { ...row, address };
}

/** The site's theme (M4-4). Only the key changes: the site's settings, content and address stay exactly as they are. */
export async function updateThemeKey(tx: TenantTx, organizationId: string, siteId: string, themeKey: string): Promise<boolean> {
  const updated = await tx
    .update(sites)
    .set({ themeKey })
    .where(and(eq(sites.organizationId, organizationId), eq(sites.id, siteId), isNull(sites.deletedAt)))
    .returning({ id: sites.id });
  return updated.length === 1;
}

/** `site_settings.theme` as stored, for the theme's settings to be read through its schema. */
export async function storedThemeSettings(tx: TenantTx, organizationId: string, siteId: string): Promise<unknown> {
  const [row] = await tx
    .select({ theme: siteSettings.theme })
    .from(siteSettings)
    .where(and(eq(siteSettings.organizationId, organizationId), eq(siteSettings.siteId, siteId)));
  return row?.theme ?? {};
}

/** The site's settings groups as stored, and their version (M4-2). Null if the site has no settings row. */
export async function readSettingsRow(tx: TenantTx, organizationId: string, siteId: string) {
  const [row] = await tx
    .select({ general: siteSettings.general, reading: siteSettings.reading, analytics: siteSettings.analytics, seo: siteSettings.seo, version: siteSettings.version })
    .from(siteSettings)
    .where(and(eq(siteSettings.organizationId, organizationId), eq(siteSettings.siteId, siteId)));
  return row ?? null;
}

export type SettingsPatch = { general?: Record<string, unknown>; reading?: Record<string, unknown>; analytics?: Record<string, unknown> };

/**
 * Writes settings groups, if the row is still at the version the person
 * loaded (optimistic concurrency, plan §4). Returns the new version, or null
 * when someone else saved in between.
 */
export async function saveSettings(tx: TenantTx, organizationId: string, siteId: string, expectedVersion: number, patch: SettingsPatch, updatedBy: string): Promise<number | null> {
  const [row] = await tx
    .update(siteSettings)
    .set({ ...patch, version: sql`${siteSettings.version} + 1`, updatedBy })
    .where(and(eq(siteSettings.organizationId, organizationId), eq(siteSettings.siteId, siteId), eq(siteSettings.version, expectedVersion)))
    .returning({ version: siteSettings.version });
  return row?.version ?? null;
}

/**
 * What the launch checklist is made of (M4-2), counted from the tables that
 * hold it: published pages (the content module's), menus with items (the
 * navigation module's). Read in the organization's context, for this site.
 */
export async function launchCounts(tx: TenantTx, organizationId: string, siteId: string): Promise<{ publishedPages: number; menusWithItems: number }> {
  const [pages] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(entries)
    .where(and(eq(entries.organizationId, organizationId), eq(entries.siteId, siteId), eq(entries.type, "page"), eq(entries.status, "published"), isNull(entries.deletedAt)));
  const [withItems] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(menus)
    .where(and(eq(menus.organizationId, organizationId), eq(menus.siteId, siteId), sql`jsonb_array_length(${menus.items}) > 0`));
  return { publishedPages: pages?.n ?? 0, menusWithItems: withItems?.n ?? 0 };
}

/** The general settings that are columns of the site itself. */
export async function updateSiteColumns(tx: TenantTx, organizationId: string, siteId: string, values: { name: string; language: string; timezone: string }): Promise<void> {
  await tx
    .update(sites)
    .set({ name: values.name, defaultLocale: values.language, timezone: values.timezone })
    .where(and(eq(sites.organizationId, organizationId), eq(sites.id, siteId), isNull(sites.deletedAt)));
}

/** Points the site's platform address at a new label. The old one is free again the moment this commits. */
export async function updateAddress(tx: TenantTx, organizationId: string, siteId: string, address: string): Promise<void> {
  await tx
    .update(domains)
    .set({ hostname: address })
    .where(and(eq(domains.organizationId, organizationId), eq(domains.siteId, siteId), eq(domains.kind, "subdomain")));
}

/**
 * Deletes a site the soft way (plan §4: `deleted_at`). Its rows stay, out of
 * every list; its slug is free again. Its addresses are detached and deleted
 * (plan §11: a deleted site's domains go first), so nothing resolves to it
 * from the moment this commits. Returns the hostnames it had.
 */
export async function softDeleteSite(tx: TenantTx, organizationId: string, siteId: string): Promise<string[] | null> {
  const [deleted] = await tx
    .update(sites)
    .set({ deletedAt: new Date() })
    .where(and(eq(sites.organizationId, organizationId), eq(sites.id, siteId), isNull(sites.deletedAt)))
    .returning({ id: sites.id });
  if (!deleted) return null;
  const detached = await tx
    .delete(domains)
    .where(and(eq(domains.organizationId, organizationId), eq(domains.siteId, siteId)))
    .returning({ hostname: domains.hostname });
  return detached.map((row) => row.hostname);
}
