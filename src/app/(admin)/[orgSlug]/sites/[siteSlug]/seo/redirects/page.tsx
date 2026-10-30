import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { NoAccess, OrganizationSuspended } from "@/components/admin/page-notice";
import { PageSkeleton } from "@/components/admin/page-skeleton";
import { SettingsSection } from "@/components/admin/settings-section";
import { canManageRedirects, getRedirects, NotFoundPageForm, RedirectsManager, siteRedirectsPath } from "@/modules/seo";
import { siteSeoPath } from "@/modules/sites";
import { requireSitePage } from "@/modules/tenancy";

export const metadata: Metadata = { title: "Redirects" };

/**
 * A site's redirects and its not-found page (plan §19: `/…/seo/redirects`; M8-5, ADR 0032): redirects added by hand
 * and those Forge adds when a published address changes; the page shown, with a real 404, at addresses the site does
 * not have.
 *
 *   open the page, change anything    Owner, Admin, Editor    canManageRedirects (`site.seo.manage`); every change checks again
 */
export default function RedirectsPage({ params, searchParams }: PageProps<"/[orgSlug]/sites/[siteSlug]/seo/redirects">) {
  return (
    <Suspense fallback={<PageSkeleton narrow />}>
      <Redirects params={params} searchParams={searchParams} />
    </Suspense>
  );
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

async function Redirects({ params, searchParams }: Pick<PageProps<"/[orgSlug]/sites/[siteSlug]/seo/redirects">, "params" | "searchParams">) {
  const { orgSlug, siteSlug } = await params;
  const access = await requireSitePage(orgSlug, siteSlug, siteRedirectsPath);
  if (access.status === "suspended") return <OrganizationSuspended message={access.message} />;

  const { ctx } = access;
  if (!canManageRedirects(ctx)) {
    return (
      <NoAccess>
        <p>A site&rsquo;s redirects are for Owners, Admins and Editors of {ctx.org.name}.</p>
      </NoAccess>
    );
  }
  const query = await searchParams;
  const pageNumber = Number(first(query.page));
  const view = await getRedirects(ctx, { query: first(query.q), page: Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1 });
  const listPath = siteRedirectsPath(ctx.org.slug, ctx.site.slug);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      <p className="mb-2 text-sm">
        <Link href={siteSeoPath(ctx.org.slug, ctx.site.slug)} className="text-muted-foreground underline-offset-4 hover:underline">
          SEO
        </Link>
      </p>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Redirects</h1>
      <p className="mb-8 text-muted-foreground">
        Old addresses of {ctx.site.name} that send visitors and search engines to new ones. When a published page, post, category or the blog moves, Forge adds
        a permanent redirect from its old address by itself.
      </p>
      <RedirectsManager orgSlug={ctx.org.slug} siteSlug={ctx.site.slug} siteBase={view.siteBase ?? "the site's address"} listPath={listPath} view={view} />
      <SettingsSection title="Not-found page" description="What visitors see, with a real “not found” (404), at an address the site does not have.">
        <NotFoundPageForm orgSlug={ctx.org.slug} siteSlug={ctx.site.slug} current={view.notFoundPage} />
      </SettingsSection>
    </main>
  );
}
