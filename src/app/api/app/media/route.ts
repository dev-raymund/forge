import { getCurrentActor } from "@/modules/auth";
import { listLibrary, parseLibraryQuery } from "@/modules/media";
import { resolveSiteContext } from "@/modules/tenancy";
import { problemResponse } from "@/platform/errors";
import { requestIdFrom } from "@/platform/observability";

/**
 * The media picker (M6-4; plan §21 Phase 6 "`/api/app/media` (picker JSON)"):
 * `GET /api/app/media?org={orgSlug}&site={siteSlug}&q=&folder=&page=` →
 * `{ items, hasMore, folders }`, images only: the picker chooses images (an image block, a featured image, the site's
 * logo and favicon). The same query as the library (`listLibrary`): only ready, untrashed files of that site.
 *
 * The organization and the site are named in the query, as the admin's URLs name them, and grant nothing: the
 * session's user must be a member who may see the library (401 without a session, 404 for another organization or
 * site, 403 for a Viewer). Nothing here changes anything.
 */
export async function GET(request: Request) {
  const requestId = requestIdFrom(request.headers);
  try {
    const params = new URL(request.url).searchParams;
    const ctx = await resolveSiteContext(await getCurrentActor(), params.get("org") ?? "", params.get("site") ?? "", { requestId });
    const query = { ...parseLibraryQuery({ q: params.get("q") ?? undefined, folder: params.get("folder") ?? undefined, page: params.get("page") ?? undefined }), kind: "image" as const };
    const library = await listLibrary(ctx, query);
    return Response.json(
      {
        items: library.items.map((item) => ({
          id: item.id, name: item.title || item.filename, filename: item.filename, altText: item.altText, thumbUrl: item.thumbUrl, width: item.width, height: item.height,
          folderId: item.folderId,
        })),
        hasMore: library.hasMore,
        folders: library.folders,
        canUpload: library.canUpload,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return problemResponse(error, requestId);
  }
}
