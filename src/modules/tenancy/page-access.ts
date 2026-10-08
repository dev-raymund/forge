import "server-only";
import { notFound } from "next/navigation";
import { requireAuthOrLogin, type AuthUser } from "@/modules/auth";
import { isAppError } from "@/platform/errors";
import { requireOrgContext, requireSiteContext, type OrgContext, type SiteContext } from "./context";
import { orgPath } from "./paths";
import { looksLikeOrgSlug } from "./slugs";

/**
 * How every page and layout under `/{orgSlug}` begins: who is signed in, and
 * their context in the organization the URL names. The three ways it can fail
 * each get the response that fits:
 *
 *  - not signed in → the login page, and back here afterwards;
 *  - no such organization, or not a member → the 404 page. One answer for
 *    both: someone outside an organization cannot tell that it exists;
 *  - a member of a suspended organization → `suspended`, for the page to say
 *    so. No context is returned, so there is nothing to render or change with.
 *
 * A page calls this itself even though its layout does: layouts are not
 * rendered again when the browser moves between pages. The membership query
 * behind it runs once per request (`requireOrgContext` is cached).
 */
export type OrgPageAccess = { status: "ok"; user: AuthUser; ctx: OrgContext } | { status: "suspended"; user: AuthUser; message: string };

export async function requireOrgPage(orgSlug: string, pathFor: (orgSlug: string) => string = orgPath): Promise<OrgPageAccess> {
  // `/favicon.ico`, `/robots.txt` and every other stray first segment arrive here too. What cannot be
  // a slug is not an organization: answered without looking at the session or the database.
  if (!looksLikeOrgSlug(orgSlug)) notFound();
  const { user } = await requireAuthOrLogin(pathFor(orgSlug));
  try {
    return { status: "ok", user, ctx: await requireOrgContext(orgSlug) };
  } catch (error) {
    if (isAppError(error) && error.kind === "NotFound") notFound();
    if (isAppError(error) && error.kind === "Forbidden") return { status: "suspended", user, message: error.message };
    throw error;
  }
}

/**
 * The same for every page under `/{orgSlug}/sites/{siteSlug}` (M4-1): the
 * organization first, as above, then the site. A slug that names no site of
 * THIS organization, including another organization's site, is the 404 page.
 */
export type SitePageAccess = { status: "ok"; user: AuthUser; ctx: SiteContext } | { status: "suspended"; user: AuthUser; message: string };

export async function requireSitePage(orgSlug: string, siteSlug: string, pathFor: (orgSlug: string, siteSlug: string) => string): Promise<SitePageAccess> {
  const access = await requireOrgPage(orgSlug, (slug) => pathFor(slug, siteSlug));
  if (access.status !== "ok") return access;
  try {
    return { ...access, ctx: await requireSiteContext(orgSlug, siteSlug) };
  } catch (error) {
    if (isAppError(error) && error.kind === "NotFound") notFound();
    throw error;
  }
}
