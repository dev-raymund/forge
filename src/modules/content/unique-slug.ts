import "server-only";
import { and, eq, isNull, like } from "drizzle-orm";
import type { SiteContext } from "@/modules/tenancy";
import { isUniqueViolation, type TenantTx } from "@/platform/db";
import { conflict } from "@/platform/errors";
import { isEntryPath, pathUnder, reservedPathReason } from "./paths";
import { entries } from "./schema";
import { ENTRY_SLUG_MAX, isEntrySlug, nextFreeSlug } from "./slugs";
import type { ContentTypeKey } from "./types/definition";

/**
 * Unique slugs (M5-2; plan §21, Phase 5: "slug uniqueness races"; cms-architecture §9.1,
 * §35 "Race: slug collision"). Paths are unique per site and locale while not
 * in the trash (`entries_site_locale_path_unique`); a slug is free where it
 * will live, not everywhere: `team` under About and `team` under Careers are
 * two paths.
 *
 *   1. read the slugs already used where the entry will live (this site, this
 *      locale, this directory, not in the trash) and take the first free one,
 *      skipping reserved paths: `base`, `base-2`, `base-3`, …
 *   2. insert in a savepoint. If another transaction took that path in the
 *      meantime, the unique index refuses it: roll back to the savepoint and
 *      try the next candidate. Nothing else is caught.
 *
 * A building block of the content services (M5-3 `createEntry`, restoring from
 * the trash): it runs in their transaction, after they have checked the
 * caller's permission. The site and organization are the context's, never an
 * argument, and every read names the site (RLS separates organizations only).
 */

export const ENTRY_PATH_KEY = "entries_site_locale_path_unique";

/** How many times a race may take the chosen slug before the request gives up with a Conflict. */
export const MAX_SLUG_ATTEMPTS = 10;

export type SlugPlace = {
  type: ContentTypeKey;
  locale: string;
  /** Where the slug goes: `""` for a top-level page, its parent's path, or `/{blogPath}` for a post. */
  dir: string;
  /** The slug wanted, e.g. `slugFromTitle(title)`. */
  base: string;
  /** The site's blog path (reading settings): pages may not take it. */
  blogPath: string;
};

export const SLUG_RACE_LOST = "Another change took this address at the same moment. Try again.";

export async function insertWithUniqueSlug<T>(
  tx: TenantTx,
  ctx: SiteContext,
  place: SlugPlace,
  insert: (tx: TenantTx, slug: string, path: string) => Promise<T>,
): Promise<{ slug: string; path: string; result: T }> {
  if (!isEntrySlug(place.base)) throw new Error(`Not a slug: ${JSON.stringify(place.base)}`);
  if (place.dir !== "" && !isEntryPath(place.dir)) throw new Error(`Not a path: ${JSON.stringify(place.dir)}`);

  const taken = new Set(await slugsUsedIn(tx, ctx, place));
  const reserved = (slug: string) => reservedPathReason(pathUnder(place.dir, slug), place) !== null;

  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = nextFreeSlug(place.base, taken, reserved);
    const path = pathUnder(place.dir, slug);
    try {
      // A savepoint: a refused insert leaves the rest of the caller's transaction usable.
      const result = await tx.transaction((savepoint) => insert(savepoint as TenantTx, slug, path));
      return { slug, path, result };
    } catch (error) {
      if (!isUniqueViolation(error, ENTRY_PATH_KEY)) throw error;
      taken.add(slug);
    }
  }
  throw conflict(SLUG_RACE_LOST);
}

/**
 * The last segments of the paths in use directly under `dir` that start like
 * `base` (this site, this locale, not in the trash). A long base is cut to make
 * room for its suffix (`slugWithSuffix`), so only its first characters are
 * matched: a superset, which `nextFreeSlug` narrows exactly.
 */
async function slugsUsedIn(tx: TenantTx, ctx: SiteContext, place: SlugPlace): Promise<string[]> {
  const prefix = pathUnder(place.dir, "");
  const stem = place.base.slice(0, ENTRY_SLUG_MAX - 12);
  // Slugs and paths hold only [a-z0-9/-]: nothing in the pattern is a LIKE wildcard.
  const rows = await tx
    .select({ path: entries.path })
    .from(entries)
    .where(
      and(
        eq(entries.organizationId, ctx.org.id),
        eq(entries.siteId, ctx.site.id),
        eq(entries.locale, place.locale),
        isNull(entries.deletedAt),
        like(entries.path, `${prefix}${stem}%`),
      ),
    );
  return rows.map((row) => row.path.slice(prefix.length)).filter((rest) => !rest.includes("/"));
}
