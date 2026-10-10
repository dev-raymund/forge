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
export { canCreateSite, canDeleteSite, canManageAppearance, canManageSiteSettings, canOpenSiteSettings, siteNavItems } from "./policies";
export {
  SITES_NOTICES, submitChangeSiteAddress, submitChooseTheme, submitCreateSite, submitDeleteSite, submitSetSiteStatus, submitUpdateSiteSettings,
} from "./site-forms";
export type { SitesNotice } from "./site-forms";
export { newSitePath, onboardingThemePath, publicSitePath, siteAppearancePath, sitePath, siteSettingsPath } from "./paths";
export { ONBOARDING_STEPS, onboardingNext } from "./onboarding";
export type { OnboardingNext, OnboardingState } from "./onboarding";

// The overview (M4-2, ADR 0014).
export { getSiteOverview } from "./overview.service";
export type { SiteOverview } from "./overview.service";
export { STATUS_EXPLANATIONS } from "./overview";
export type { ChecklistItem } from "./overview";
export { SiteOverviewView } from "./ui/site-overview";

// Settings (M4-2, ADR 0014): general, reading, analytics.
export { getSiteSettings, isSettingsGroup, SETTINGS_GROUPS, updateSiteSettings } from "./settings.service";
export type { SettingsChange, SettingsGroup, SiteSettingsView } from "./settings.service";
export { AnalyticsSettingsForm, GeneralSettingsForm, ReadingSettingsForm } from "./ui/site-settings-forms";

// Publishing (M4-5, ADR 0015): Coming soon ↔ live.
export { setSiteStatus } from "./publishing.service";
export { SETTABLE_STATUSES, statusTransition } from "./publishing";
export type { SettableStatus } from "./publishing";

// Appearance (M4-4, ADR 0012): the theme a site is drawn with.
export { chooseTheme, getAppearance } from "./appearance.service";
export type { Appearance, ThemeChoice } from "./appearance.service";
export { ThemePicker } from "./ui/theme-picker";
export { languageLabel, siteTimeZones } from "./locale";
export { SITE_STATUS_LABELS } from "./shared";
export type { SiteSummary } from "./shared";

// Screens. Pages in app/(admin) compose these; the forms call ./actions.ts, the only way in.
export { CreateSiteForm } from "./ui/create-site-form";
export { DeleteSite, SiteAddressForm } from "./ui/site-settings";
export { SiteStatusBadge, SitesView } from "./ui/sites-view";
export type { SitesViewProps } from "./ui/sites-view";
