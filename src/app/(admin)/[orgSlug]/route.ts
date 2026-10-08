import { looksLikeOrgSlug, orgSitesPath } from "@/modules/tenancy";

/**
 * `/{orgSlug}` is not a page (plan §19): it redirects to the organization's
 * sites, `/{orgSlug}/sites` (M4-1). Until then it was the organization's home.
 *
 * Nothing is looked up. The answer is the same for an organization that exists
 * and one that does not, for a member and for anyone else, so it tells nobody
 * anything; the sites page decides who may see what, and answers 404 the same
 * way for both. In-app links go straight to `/{orgSlug}/sites`: this is for
 * addresses people type, and links from before M4-1.
 */
export async function GET(_request: Request, { params }: RouteContext<"/[orgSlug]">) {
  const { orgSlug } = await params;
  if (!looksLikeOrgSlug(orgSlug)) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response(null, { status: 307, headers: { location: orgSitesPath(orgSlug) } });
}
