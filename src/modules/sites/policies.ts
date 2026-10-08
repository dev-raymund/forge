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
 *   delete a site            Owner             `sites.delete`
 */
export const canCreateSite = (ctx: OrgContext): boolean => can(ctx, "sites.create");

export const canManageSiteSettings = (ctx: OrgContext): boolean => can(ctx, "site.settings.manage");

export const canDeleteSite = (ctx: OrgContext): boolean => can(ctx, "sites.delete");

/** The site's settings page: for anyone who may change something on it. */
export const canOpenSiteSettings = (ctx: OrgContext): boolean => canManageSiteSettings(ctx) || canDeleteSite(ctx);
