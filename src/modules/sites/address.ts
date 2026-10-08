import { isSiteAddress } from "@/platform/routing/hosts";

/**
 * Site addresses and site slugs (M4-1, ADR 0011). Pure and client-safe.
 *
 * A site has two names (see ./index.ts):
 *  - its **address**: the public one, `/s/{address}` in V1 and
 *    `{address}.<sites domain>` later (ADR 0006). Unique on the whole platform,
 *    stored as the `hostname` of the site's `domains` row of kind `subdomain`.
 *  - its **slug**: the admin one, `/{orgSlug}/sites/{siteSlug}`. Unique inside
 *    its organization. Taken from the address when the site is created, and
 *    not changed when the address is.
 */

/** One DNS label. */
export const SITE_ADDRESS_MAX = 63;

/**
 * Addresses no site can have. In V1 an address only ever appears after `/s/`,
 * where it cannot shadow a page of the app: `/s/login` is a site, `/login` is
 * still the login page (the proxy routes `/s/…` before anything else). These
 * are the labels the platform keeps for itself under the sites domain, where
 * addresses become hostnames (plan §11, the issue's list).
 */
export const RESERVED_SITE_ADDRESSES: ReadonlySet<string> = new Set(["www", "app", "api", "admin", "media"]);

export const isReservedSiteAddress = (address: string) => RESERVED_SITE_ADDRESSES.has(address);

export type AddressCheck = { ok: true; address: string } | { ok: false; message: string };

/**
 * Checks an address someone typed. It is trimmed and lowercased (an address
 * has one spelling, so `Acme` and `acme` are the same address), then held to
 * the shape of a DNS label: 1 to 63 lowercase ASCII letters, digits and single
 * hyphens, not at either end. That shape is `isSiteAddress`, the rule the
 * router already applies to `/s/{address}`.
 *
 * Nothing else is converted. Letters outside ASCII are refused rather than
 * turned into punycode, and so are double hyphens, which rules out punycode
 * (`xn--…`) typed in directly: no address can be made to look like another.
 *
 * Whether the address is still free is the database's answer: its unique
 * constraint, at the moment of writing.
 */
export function checkSiteAddress(input: string): AddressCheck {
  const address = input.trim().toLowerCase();
  if (!address) return { ok: false, message: "Enter an address for the site." };
  if (address.length > SITE_ADDRESS_MAX) return { ok: false, message: `Use at most ${SITE_ADDRESS_MAX} characters.` };
  if (!isSiteAddress(address)) {
    return { ok: false, message: "Use lowercase letters, numbers and single hyphens, not at the start or end, e.g. acme-studio." };
  }
  if (isReservedSiteAddress(address)) return { ok: false, message: "That address is reserved. Choose another." };
  return { ok: true, address };
}

/**
 * An address suggestion from a site's name ("Café Acme & Co." → "cafe-acme-and-co").
 * A suggestion only: it may be empty or reserved, and `checkSiteAddress` decides.
 * Runs of anything else become one hyphen, so it never holds a double hyphen.
 */
export function suggestSiteAddress(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // accents
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SITE_ADDRESS_MAX)
    .replace(/-+$/g, "");
}

/**
 * Slugs no site can have: the literal segments under `/{orgSlug}/sites/`.
 * `tests/unit/site-addresses.test.ts` fails when a page is added there without
 * being listed.
 */
export const RESERVED_SITE_SLUGS: ReadonlySet<string> = new Set(["new"]);

/**
 * The slug of a new site: its address, which already has the shape of a slug.
 * If an older site of the organization holds that slug (its address has
 * changed since), or the address is a reserved slug, a number is added:
 * `acme-2`, `acme-3`, …
 */
export function siteSlugFor(address: string, taken: ReadonlySet<string>): string {
  const free = (slug: string) => !taken.has(slug) && !RESERVED_SITE_SLUGS.has(slug);
  if (free(address)) return address;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const slug = `${address.slice(0, SITE_ADDRESS_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (free(slug)) return slug;
  }
}
