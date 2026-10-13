import type { Metadata } from "next";
import { Suspense } from "react";
import { OrganizationSuspended } from "@/components/admin/page-notice";
import { PageSkeleton } from "@/components/admin/page-skeleton";
import { canCreateEntry, entryListPath, listPosts, listTerms, newEntryPath, parsePostQuery, PostsView } from "@/modules/content";
import { listMembers, requireSitePage } from "@/modules/tenancy";

export const metadata: Metadata = { title: "Posts" };

/**
 * A site's posts (plan §19 `/…/posts`; M5-7), for every member: an Author sees their own only (the query decides,
 * not this page). Filters and the page number come from the query string and only narrow what is shown.
 */
export default function PostsPage({ params, searchParams }: PageProps<"/[orgSlug]/sites/[siteSlug]/posts">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Posts params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Posts({ params, searchParams }: PageProps<"/[orgSlug]/sites/[siteSlug]/posts">) {
  const { orgSlug, siteSlug } = await params;
  const access = await requireSitePage(orgSlug, siteSlug, (org, site) => entryListPath(org, site, "post"));
  if (access.status === "suspended") return <OrganizationSuspended message={access.message} />;
  const { ctx } = access;
  const query = parsePostQuery(await searchParams);
  const [list, terms] = await Promise.all([listPosts(ctx, query), listTerms(ctx)]);
  const members = list.onlyOwn ? [] : await listMembers(ctx);
  const [org, site] = [ctx.org.slug, ctx.site.slug];
  return (
    <PostsView
      orgSlug={org}
      siteSlug={site}
      basePath={entryListPath(org, site, "post")}
      query={query}
      list={list}
      categories={terms.filter((term) => term.taxonomy === "category")}
      authors={members.map((member) => ({ userId: member.userId, name: member.name }))}
      newHref={canCreateEntry(ctx, "post") ? newEntryPath(org, site, "post") : null}
    />
  );
}
