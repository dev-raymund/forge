import type { Metadata } from "next";
import { Suspense } from "react";
import { NoAccess, OrganizationSuspended } from "@/components/admin/page-notice";
import { PageSkeleton } from "@/components/admin/page-skeleton";
import { canManageTerms, entryListPath, listTermsWithUsage, termListPath, TermsView } from "@/modules/content";
import { getSiteSettings } from "@/modules/sites";
import { requireSitePage } from "@/modules/tenancy";

export const metadata: Metadata = { title: "Tags" };

/**
 * A site's tags (plan §19 `/…/posts/tags`; M5-8): for those who manage terms (Owner–Editor). The services
 * check for themselves; an Author adds tags from a post's settings instead.
 */
export default function TagsPage({ params }: PageProps<"/[orgSlug]/sites/[siteSlug]/posts/tags">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Terms params={params} />
    </Suspense>
  );
}

async function Terms({ params }: Pick<PageProps<"/[orgSlug]/sites/[siteSlug]/posts/tags">, "params">) {
  const { orgSlug, siteSlug } = await params;
  const access = await requireSitePage(orgSlug, siteSlug, (org, site) => termListPath(org, site, "tag"));
  if (access.status === "suspended") return <OrganizationSuspended message={access.message} />;
  const { ctx } = access;
  if (!canManageTerms(ctx)) {
    return (
      <NoAccess>
        <p>The tags of {ctx.site.name} are managed by its Owners, Admins and Editors.</p>
      </NoAccess>
    );
  }
  const [terms, settings] = await Promise.all([listTermsWithUsage(ctx, "tag"), getSiteSettings(ctx)]);
  return (
    <TermsView
      orgSlug={ctx.org.slug}
      siteSlug={ctx.site.slug}
      taxonomy="tag"
      terms={terms.map((term) => ({ id: term.id, name: term.name, slug: term.slug, description: term.description, parentId: term.parentId, posts: term.posts, drafts: term.drafts }))}
      archiveBase={`/${settings.reading.blogPath}/tag`}
      postsHref={entryListPath(ctx.org.slug, ctx.site.slug, "post")}
    />
  );
}
