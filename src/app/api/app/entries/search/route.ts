import { getCurrentActor } from "@/modules/auth";
import { searchEntries } from "@/modules/content";
import { resolveSiteContext } from "@/modules/tenancy";
import { problemResponse } from "@/platform/errors";
import { requestIdFrom } from "@/platform/observability";

/**
 * The editor's link picker (M5-4; plan §6.1 `entry:{id}` links):
 * `GET /api/app/entries/search?org={orgSlug}&site={siteSlug}&q={text}` →
 * `{ entries: [{ id, type, title, path, status }] }`, at most ten.
 *
 * The organization and the site are named in the query, as the admin's URLs
 * name them, and grant nothing: the session's user must be a member of that
 * organization and the site one of its sites (401 without a session, 404
 * otherwise). Only that site's entries are searched.
 */
export async function GET(request: Request) {
  const requestId = requestIdFrom(request.headers);
  try {
    const params = new URL(request.url).searchParams;
    const ctx = await resolveSiteContext(await getCurrentActor(), params.get("org") ?? "", params.get("site") ?? "", { requestId });
    const entries = await searchEntries(ctx, params.get("q") ?? "");
    return Response.json({ entries }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return problemResponse(error, requestId);
  }
}
