import "server-only";
import { can, type OrgContext } from "@/modules/tenancy";

/**
 * What a member may do with sites (plan §13, ADR 0009). Asked of the
 * permissions in the context, never of a role. For pages, to decide what to
 * render; every service asks again with `requirePermission`.
 *
 *   see the sites            every member (membership is enough)
 *   create a site            Owner, Admin      `sites.create`
 *   change a site's address  Owner, Admin      `site.settings.manage`
 *   choose a site's theme    Owner, Admin      `site.settings.manage` (plan §13: "settings, appearance, …")
 *   delete a site            Owner             `sites.delete`
 */
export const canCreateSite = (ctx: OrgContext): boolean => can(ctx, "sites.create");

export const canManageSiteSettings = (ctx: OrgContext): boolean => can(ctx, "site.settings.manage");

export const canDeleteSite = (ctx: OrgContext): boolean => can(ctx, "sites.delete");

/** The appearance page: choosing the theme (M4-4), and customising it (M8-1). */
export const canManageAppearance = (ctx: OrgContext): boolean => canManageSiteSettings(ctx);

/**
 * The links of a site's own nav, for what this member may open. Which pages a
 * member may see is still decided by each page; this only leaves out links to
 * pages that would say "no access".
 */
export function siteNavItems(paths: { overview: string; appearance: string; settings: string }, ctx: OrgContext): { href: string; label: string }[] {
  return [
    { href: paths.overview, label: "Overview" },
    ...(canManageAppearance(ctx) ? [{ href: paths.appearance, label: "Appearance" }] : []),
    ...(canOpenSiteSettings(ctx) ? [{ href: paths.settings, label: "Settings" }] : []),
  ];
}

/** The site's settings page: for anyone who may change something on it. */
export const canOpenSiteSettings = (ctx: OrgContext): boolean => canManageSiteSettings(ctx) || canDeleteSite(ctx);
