import type { Metadata } from "next";
import { Suspense } from "react";
import { NoAccess, OrganizationSuspended } from "@/components/admin/page-notice";
import { PageSkeleton } from "@/components/admin/page-skeleton";
import { SettingsSection } from "@/components/admin/settings-section";
import {
  canDeleteSite, canManageSiteSettings, canOpenSiteSettings, DeleteSite, getSite, publicSitePath, SiteAddressForm, siteSettingsPath,
} from "@/modules/sites";
import { requireSitePage } from "@/modules/tenancy";

export const metadata: Metadata = { title: "Site settings" };

/**
 * A site's settings (plan §19: `/…/settings`, Admin). In M4-1: its public
 * address (plan §19: "in site settings until M9") and deleting it. The
 * general, reading and analytics settings join this page in M4-2.
 *
 *   open the page        Owner, Admin    canOpenSiteSettings
 *   change the address   Owner, Admin    canManageSiteSettings   (`site.settings.manage`)
 *   delete the site      Owner           canDeleteSite           (`sites.delete`)
 */
export default function SiteSettingsPage({ params }: PageProps<"/[orgSlug]/sites/[siteSlug]/settings">) {
  return (
    <Suspense fallback={<PageSkeleton narrow />}>
      <SiteSettings params={params} />
    </Suspense>
  );
}

async function SiteSettings({ params }: Pick<PageProps<"/[orgSlug]/sites/[siteSlug]/settings">, "params">) {
  const { orgSlug, siteSlug } = await params;
  const access = await requireSitePage(orgSlug, siteSlug, siteSettingsPath);
  if (access.status === "suspended") return <OrganizationSuspended message={access.message} />;

  const { ctx } = access;
  if (!canOpenSiteSettings(ctx)) {
    return (
      <NoAccess>
        <p>A site&rsquo;s settings are for Owners and Admins of {ctx.org.name}.</p>
      </NoAccess>
    );
  }
  const site = await getSite(ctx);
  const address = site.address ?? site.slug;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="mb-8 text-2xl font-semibold tracking-tight">Site settings</h1>
      {canManageSiteSettings(ctx) && site.address ? (
        <SettingsSection title="Site address" description={`Where the public sees ${site.name}: ${publicSitePath(site.address)}.`}>
          <SiteAddressForm orgSlug={ctx.org.slug} siteSlug={ctx.site.slug} address={site.address} />
        </SettingsSection>
      ) : null}
      {canDeleteSite(ctx) ? (
        <SettingsSection title="Delete site" description="Takes the site offline and removes it from this organization. Only an Owner can do this.">
          <DeleteSite orgSlug={ctx.org.slug} siteSlug={ctx.site.slug} siteName={site.name} confirmWith={address} />
        </SettingsSection>
      ) : null}
    </main>
  );
}
