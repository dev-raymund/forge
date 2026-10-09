import { Suspense } from "react";
import { SectionNav } from "@/components/admin/section-nav";
import { siteAppearancePath, siteNavItems, sitePath, siteSettingsPath } from "@/modules/sites";
import { requireSitePage } from "@/modules/tenancy";

/**
 * Every page of one site (`/{orgSlug}/sites/{siteSlug}/…`): the site's own
 * links under the organization's. Rendered only for a member of the
 * organization, and only for a site of THAT organization: anything else is
 * the 404 page, before anything about the site is read.
 */
export default function SiteLayout({ children, params }: LayoutProps<"/[orgSlug]/sites/[siteSlug]">) {
  return (
    <>
      <Suspense fallback={<div className="h-11 border-b" aria-hidden="true" />}>
        <SiteLinks params={params} />
      </Suspense>
      {children}
    </>
  );
}

async function SiteLinks({ params }: Pick<LayoutProps<"/[orgSlug]/sites/[siteSlug]">, "params">) {
  const { orgSlug, siteSlug } = await params;
  const access = await requireSitePage(orgSlug, siteSlug, sitePath);
  if (access.status !== "ok") return null;
  const { ctx } = access;
  const [org, site] = [ctx.org.slug, ctx.site.slug];
  const items = siteNavItems({ overview: sitePath(org, site), appearance: siteAppearancePath(org, site), settings: siteSettingsPath(org, site) }, ctx);
  return <SectionNav label={`Site: ${ctx.site.name}`} items={items} />;
}
