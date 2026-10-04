/**
 * Organization slugs (plan §19). Pure and client-safe.
 *
 * The slug is the first segment of every admin URL (`/{orgSlug}/…`, D-08), so
 * it is globally unique, shaped like a URL segment, and never one of the words
 * the app itself uses at that position.
 */

export const ORG_SLUG_MIN = 3;
/** One DNS label: the same ceiling as a site address. */
export const ORG_SLUG_MAX = 63;

/** Lowercase letters and digits in hyphen-separated groups. The table's CHECK constraint is the same expression. */
const FORMAT = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Words that cannot be an organization's slug: each is, or is reserved to
 * become, a top-level path of the app.
 *
 * - The plan's list (§19).
 * - `dev` and `render`: top-level paths that exist in the app and were missing
 *   from that list. (`_next` and `_forge` cannot be slugs at all: the format has
 *   no underscore. They are listed so the intent is in one place.)
 *
 * `tests/unit/reserved-slugs.test.ts` fails when a top-level admin route is
 * added without reserving its name here.
 */
export const RESERVED_ORG_SLUGS: ReadonlySet<string> = new Set([
  "login", "signup", "onboarding", "account", "invite", "platform", "api", "verify-email", "forgot-password", "reset-password",
  "settings", "new", "_next", "s", "media",
  "dev", "render", "_forge",
]);

export const isReservedOrgSlug = (slug: string) => RESERVED_ORG_SLUGS.has(slug);

export type SlugCheck = { ok: true; slug: string } | { ok: false; message: string };

/**
 * Checks a slug someone typed. Input is trimmed and lowercased first (a slug
 * has one spelling), then held to the format, the length and the reserved list.
 * Whether it is still free is the database's answer (the unique constraint).
 */
export function checkOrgSlug(input: string): SlugCheck {
  const slug = input.trim().toLowerCase();
  if (!slug) return { ok: false, message: "Enter a URL for the organization." };
  if (!FORMAT.test(slug)) return { ok: false, message: "Use lowercase letters, numbers and single hyphens, e.g. acme-studio." };
  if (slug.length < ORG_SLUG_MIN) return { ok: false, message: `Use at least ${ORG_SLUG_MIN} characters.` };
  if (slug.length > ORG_SLUG_MAX) return { ok: false, message: `Use at most ${ORG_SLUG_MAX} characters.` };
  if (isReservedOrgSlug(slug)) return { ok: false, message: "That URL is reserved. Choose another." };
  return { ok: true, slug };
}

/** True for a string that has the shape of a slug (used to refuse garbage before asking the database). */
export const looksLikeOrgSlug = (value: string) => value.length <= ORG_SLUG_MAX && FORMAT.test(value);

/**
 * A slug suggestion from an organization's name ("Acme Studio, Inc." →
 * "acme-studio-inc"). A suggestion only: it may be empty, too short or
 * reserved, and the user can change it; `checkOrgSlug` decides.
 */
export function suggestOrgSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // accents
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ORG_SLUG_MAX)
    .replace(/-+$/g, "");
}
