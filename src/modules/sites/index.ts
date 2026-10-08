import "server-only";

/**
 * Public server API of the sites module (M4-1, ADR 0011). M3-1 needed its read
 * side for the tenant resolver; M4-1 adds creating, listing, moving and
 * deleting sites, and their screens.
 *
 * A site has two names, and they are different things:
 *  - its **slug**, unique inside its organization, used in admin URLs
 *    (`/{orgSlug}/sites/{siteSlug}`). Taken from the address at creation;
 *    it stays when the address changes, so admin links keep working.
 *  - its **address**, unique on the whole platform, used in public URLs
 *    (`/s/{address}` in V1). It is the `domains` row of kind `subdomain`
 *    (ADR 0006), never the slug.
 */

// The read side the tenant resolver stands on (M3-1).
export { findSiteBySlug, siteAddress } from "./repository";
export type { SiteRef, SiteStatus } from "./repository";

// Sites (M4-1).
export { changeSiteAddress, createSite, deleteSite, getSite, listSites, siteAllowance } from "./sites.service";
export type { SiteChange } from "./sites.service";
export { canCreateSite, canDeleteSite, canManageSiteSettings, canOpenSiteSettings } from "./policies";
export { SITES_NOTICES, submitChangeSiteAddress, submitCreateSite, submitDeleteSite } from "./site-forms";
export type { SitesNotice } from "./site-forms";
export { newSitePath, publicSitePath, sitePath, siteSettingsPath } from "./paths";
export { languageLabel, siteTimeZones } from "./locale";
export { SITE_STATUS_LABELS } from "./shared";
export type { SiteSummary } from "./shared";

// Screens. Pages in app/(admin) compose these; the forms call ./actions.ts, the only way in.
export { CreateSiteForm } from "./ui/create-site-form";
export { DeleteSite, SiteAddressForm } from "./ui/site-settings";
export { SiteStatusBadge, SitesView } from "./ui/sites-view";
export type { SitesViewProps } from "./ui/sites-view";
