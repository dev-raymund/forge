import type { Metadata } from "next";
import { Suspense } from "react";
import { NoAccess, OrganizationSuspended } from "@/components/admin/page-notice";
import { PageSkeleton } from "@/components/admin/page-skeleton";
import { canSeeLibrary, listLibrary, mediaLibraryPath, MediaLibrary, parseLibraryQuery } from "@/modules/media";
import { requireSitePage } from "@/modules/tenancy";

export const metadata: Metadata = { title: "Media" };

/**
 * Completing an upload runs in this page's function (its Server Actions) and processes the image (M6-2): typically
 * 1–3 s. A minute leaves room. It bounds how long the function may run; it says nothing about memory, which Vercel
 * Hobby fixes (ADR 0021), and nothing has been measured on Vercel yet.
 */
export const maxDuration = 60;

/**
 * A site's media library (plan §19 `/…/media`; M6-3): for those who upload or manage media (Owner–Author). An Author
 * sees the site's files and changes only their own; the services decide, every time. The query string only narrows
 * what is shown.
 */
export default function MediaPage({ params, searchParams }: PageProps<"/[orgSlug]/sites/[siteSlug]/media">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Media params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Media({ params, searchParams }: PageProps<"/[orgSlug]/sites/[siteSlug]/media">) {
  const { orgSlug, siteSlug } = await params;
  const access = await requireSitePage(orgSlug, siteSlug, mediaLibraryPath);
  if (access.status === "suspended") return <OrganizationSuspended message={access.message} />;
  const { ctx } = access;
  if (!canSeeLibrary(ctx)) {
    return (
      <NoAccess>
        <p>The media of {ctx.site.name} is managed by its Owners, Admins, Editors and Authors.</p>
      </NoAccess>
    );
  }
  const query = parseLibraryQuery(await searchParams);
  const library = await listLibrary(ctx, query);
  return (
    <MediaLibrary
      orgSlug={ctx.org.slug}
      siteSlug={ctx.site.slug}
      basePath={mediaLibraryPath(ctx.org.slug, ctx.site.slug)}
      query={query}
      items={library.items}
      hasMore={library.hasMore}
      folders={library.folders}
      storage={library.storage}
      canManageFolders={library.canManageFolders}
      canUpload={library.canUpload}
    />
  );
}
