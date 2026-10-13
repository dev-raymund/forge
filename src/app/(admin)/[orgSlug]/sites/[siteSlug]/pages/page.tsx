import type { Metadata } from "next";
import { Suspense } from "react";
import { NoAccess, OrganizationSuspended } from "@/components/admin/page-notice";
import { PageSkeleton } from "@/components/admin/page-skeleton";
import { canCreateEntry, canSeePages, canSetHomepage, canUpdateEntry, entryListPath, listPages, newEntryPath, PagesView, parsePageQuery } from "@/modules/content";
import { requireSitePage } from "@/modules/tenancy";

export const metadata: Metadata = { title: "Pages" };

/**
 * A site's pages (plan §19 `/…/pages`; M5-7): the tree, for every member who may see pages (an Author may not:
 * M5-7 criterion 5). Arranging the tree is for those who may edit pages; the actions check for themselves.
 */
export default function PagesPage({ params, searchParams }: PageProps<"/[orgSlug]/sites/[siteSlug]/pages">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Pages params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Pages({ params, searchParams }: PageProps<"/[orgSlug]/sites/[siteSlug]/pages">) {
  const { orgSlug, siteSlug } = await params;
  const access = await requireSitePage(orgSlug, siteSlug, (org, site) => entryListPath(org, site, "page"));
  if (access.status === "suspended") return <OrganizationSuspended message={access.message} />;
  const { ctx } = access;
  if (!canSeePages(ctx)) {
    return (
      <NoAccess>
        <p>The pages of {ctx.site.name} are managed by its Owners, Admins and Editors. Your posts are under Posts.</p>
      </NoAccess>
    );
  }
  const query = parsePageQuery(await searchParams);
  const filtered = Boolean(query.q || query.status);
  const [{ items, truncated }, all] = await Promise.all([listPages(ctx, query), filtered ? listPages(ctx) : null]);
  const [org, site] = [ctx.org.slug, ctx.site.slug];
  const mayCreate = canCreateEntry(ctx, "page");
  return (
    <PagesView
      orgSlug={org}
      siteSlug={site}
      basePath={entryListPath(org, site, "page")}
      query={query}
      pages={items}
      truncated={truncated}
      hasHome={(all ?? { items }).items.some((page) => page.isHome)}
      newHref={mayCreate ? newEntryPath(org, site, "page") : null}
      newHomeHref={mayCreate && canSetHomepage(ctx) ? `${newEntryPath(org, site, "page")}?home=1` : null}
      canArrange={canUpdateEntry(ctx, { type: "page", organizationId: ctx.org.id, authorId: null })}
    />
  );
}
