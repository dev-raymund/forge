/**
 * Client-safe exports of the sites module: the address rules, the schemas,
 * the URLs and the shapes the screens use. No database access from here.
 */
import type { SITE_STATUSES } from "./schema";

export {
  checkSiteAddress, isReservedSiteAddress, RESERVED_SITE_ADDRESSES, RESERVED_SITE_SLUGS, SITE_ADDRESS_MAX, siteSlugFor, suggestSiteAddress,
} from "./address";
export type { AddressCheck } from "./address";
export {
  DEFAULT_SITE_LANGUAGE, DEFAULT_SITE_TIME_ZONE, isSiteTimeZone, languageLabel, SITE_LANGUAGE_CODES, SITE_LANGUAGES, siteTimeZones,
} from "./locale";
export type { SiteLanguage } from "./locale";
export { newSitePath, publicSitePath, siteAppearancePath, sitePath, siteSettingsPath } from "./paths";
export { changeSiteAddressSchema, chooseThemeSchema, createSiteSchema } from "./validation";
export type { ChangeSiteAddressInput, ChooseThemeInput, CreateSiteInput } from "./validation";

export type SiteStatus = (typeof SITE_STATUSES)[number];

/** What a status is called on screen. */
export const SITE_STATUS_LABELS: Readonly<Record<SiteStatus, string>> = { coming_soon: "Coming soon", live: "Live", suspended: "Suspended" };

/** A site as the members of its organization see it. */
export type SiteSummary = {
  id: string;
  slug: string;
  name: string;
  status: SiteStatus;
  /** Its public address (`/s/{address}`). Null only for a site that has none, which `createSite` never makes. */
  address: string | null;
  language: string;
  timezone: string;
  /** `sites.theme_key` as stored (M4-4). Drawn with the default theme if it is not one the registry knows. */
  theme: string;
  createdAt: Date;
};
