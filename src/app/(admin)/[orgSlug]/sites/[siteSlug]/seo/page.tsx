import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { NoAccess, OrganizationSuspended } from "@/components/admin/page-notice";
import { PageSkeleton } from "@/components/admin/page-skeleton";
import { siteRedirectsPath } from "@/modules/seo";
import { canManageSeo, getSeoSettings, SeoSettingsForm, siteSeoPath } from "@/modules/sites";
import { requireSitePage } from "@/modules/tenancy";

export const metadata: Metadata = { title: "SEO" };

/**
 * A site's SEO defaults (plan §19: `/…/seo`; M8-4, ADR 0031): the title template, default description and social
 * image, "ask search engines not to index", the Search Console token. Each page and post has its own SEO tab in the
 * editor; these are what they inherit.
 *
 *   open the page, save    Owner, Admin, Editor    canManageSeo (`site.seo.manage`); the save checks again
 */
export default function SeoPage({ params }: PageProps<"/[orgSlug]/sites/[siteSlug]/seo">) {
  return (
    <Suspense fallback={<PageSkeleton narrow />}>
      <Seo params={params} />
    </Suspense>
  );
}

async function Seo({ params }: Pick<PageProps<"/[orgSlug]/sites/[siteSlug]/seo">, "params">) {
  const { orgSlug, siteSlug } = await params;
  const access = await requireSitePage(orgSlug, siteSlug, siteSeoPath);
  if (access.status === "suspended") return <OrganizationSuspended message={access.message} />;

  const { ctx } = access;
  if (!canManageSeo(ctx)) {
    return (
      <NoAccess>
        <p>A site&rsquo;s SEO settings are for Owners, Admins and Editors of {ctx.org.name}.</p>
      </NoAccess>
    );
  }
  const view = await getSeoSettings(ctx);
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">SEO</h1>
      <p className="mb-8 text-muted-foreground">
        How {ctx.site.name} appears in search results and when it is shared. Each page and post can say more in the SEO tab of its editor; these are what it inherits.
      </p>
      <p className="-mt-4 mb-8 text-sm">
        <Link href={siteRedirectsPath(ctx.org.slug, ctx.site.slug)} className="font-medium underline underline-offset-4">
          Redirects and the not-found page
        </Link>
        <span className="text-muted-foreground">: old addresses sent to new ones, and what visitors see at an address the site does not have.</span>
      </p>
      <SeoSettingsForm
        orgSlug={ctx.org.slug}
        siteSlug={ctx.site.slug}
        siteName={view.site.name}
        comingSoon={view.site.status !== "live"}
        version={view.version}
        seo={view.seo}
        defaultOgImage={view.defaultOgImage ? { name: view.defaultOgImage.name, thumbUrl: view.defaultOgImage.thumbUrl } : null}
      />
    </main>
  );
}
