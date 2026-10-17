import "server-only";

/**
 * What the public site reads of the media module (M8-2, ADR 0029): images resolved to their stored widths, never an
 * original. UI-free: the module's barrel (`@/modules/media`) also carries the library's screens, and whatever a site
 * page imports is shipped to its visitors, so the renderer imports this entry instead.
 */
export { publicImages, siteImagery } from "./images";
export type { PublicImage, SiteImagery } from "./images";
