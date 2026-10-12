import { slugify } from "@/lib/slugify";

/**
 * Entry slugs (M5-2; plan §5). Pure and client-safe.
 *
 * A slug is one path segment: lowercase letters and digits in hyphen-separated
 * groups. The `entries` and `terms` tables refuse anything else (CHECK
 * `entries_slug_format`, `terms_slug_format`); this is the same expression, so
 * nothing made here is refused there.
 */

const FORMAT = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The longest slug made from a title. Long enough for a headline, short enough for a URL. */
export const ENTRY_SLUG_MAX = 100;

/** What a new entry, or a title with no letters or digits in a Latin spelling, is called (cms-architecture §9.1: `uniqueSlug(site, 'untitled')`). */
export const FALLBACK_SLUG = "untitled";

/** Has the shape the database accepts, and fits. */
export const isEntrySlug = (value: string): boolean => value.length <= ENTRY_SLUG_MAX && FORMAT.test(value);

/** A slug from a title: never empty, always valid. */
export function slugFromTitle(title: string): string {
  return slugify(title, ENTRY_SLUG_MAX) || FALLBACK_SLUG;
}

/**
 * The n-th candidate for a slug: `base`, `base-2`, `base-3`, … The base is cut
 * so the suffix fits in `ENTRY_SLUG_MAX`, and the result is still a slug.
 */
export function slugWithSuffix(base: string, n: number): string {
  if (n <= 1) return base;
  const suffix = `-${n}`;
  return `${base.slice(0, ENTRY_SLUG_MAX - suffix.length).replace(/-+$/g, "")}${suffix}`;
}

/**
 * The first candidate (`base`, `base-2`, …) that is neither taken nor refused
 * by `skip`. `taken` is what the database holds now; a concurrent writer can
 * still take the answer first, which is why the insert retries (unique-slug.ts).
 */
export function nextFreeSlug(base: string, taken: Iterable<string>, skip: (slug: string) => boolean = () => false, from = 1): string {
  const used = new Set(taken);
  // Each taken slug blocks one candidate at most; a skip rule (reserved paths) blocks a few. Past that, something is wrong.
  const last = Math.max(1, from) + used.size + 1_000;
  for (let n = Math.max(1, from); n <= last; n++) {
    const candidate = slugWithSuffix(base, n);
    if (!used.has(candidate) && !skip(candidate)) return candidate;
  }
  throw new Error(`No free slug for "${base}".`);
}
