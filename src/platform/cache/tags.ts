/**
 * V1 cache tag taxonomy (plan §20 "V1 cache tags", D-27). Every public
 * `'use cache'` function tags its result with these builders only. Tags are
 * ≤ 256 characters; ids are UUIDs and hostnames are ≤ 253, so they fit.
 */

const MAX_TAG = 256;

/** 32-bit FNV-1a, hex. Only disambiguates the rare over-long hostname. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export const tags = {
  /** Domain → site resolution. A 253-character hostname would overflow the limit, so it is shortened. */
  host: (hostname: string) => {
    const tag = `host:${hostname}`;
    return tag.length <= MAX_TAG ? tag : `host:${hostname.slice(0, 200)}~${fnv1a(hostname)}`;
  },
  /** Umbrella: site status, theme switch, "purge site cache". */
  site: (siteId: string) => `site:${siteId}`,
  /** Settings, theme customisation, menus, redirects. */
  config: (siteId: string) => `site:${siteId}:config`,
  /** Path → entry resolution. */
  routes: (siteId: string) => `site:${siteId}:routes`,
  /** One entry's render data. */
  entry: (siteId: string, entryId: string) => `site:${siteId}:entry:${entryId}`,
  /** Blog index, archives, sitemap for a content type. */
  list: (siteId: string, type: string) => `site:${siteId}:list:${type}`,
  /** Media metadata used in renders. */
  media: (mediaId: string) => `media:${mediaId}`,
} as const;
