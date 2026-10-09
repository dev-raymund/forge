import type { Metadata } from "next";
import { Suspense } from "react";
import { NoAccess, OrganizationSuspended } from "@/components/admin/page-notice";
import { PageSkeleton } from "@/components/admin/page-skeleton";
import { SettingsSection } from "@/components/admin/settings-section";
import {
  AnalyticsSettingsForm, canDeleteSite, canManageSiteSettings, canOpenSiteSettings, DeleteSite, GeneralSettingsForm, getSite, getSiteSettings, publicSitePath,
  ReadingSettingsForm, SiteAddressForm, siteSettingsPath, siteTimeZones,
} from "@/modules/sites";
import { requireSitePage } from "@/modules/tenancy";

export const metadata: Metadata = { title: "Site settings" };

/**
 * A site's settings (plan §19: `/…/settings`, Admin): general, reading and
 * analytics (M4-2), its public address (M4-1; plan §19: "in site settings
 * until M9"), and deleting it.
 *
 *   open the page                         Owner, Admin    canOpenSiteSettings
 *   general, reading, analytics, address  Owner, Admin    canManageSiteSettings   (`site.settings.manage`)
 *   delete the site                       Owner           canDeleteSite           (`sites.delete`)
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
  const manage = canManageSiteSettings(ctx);
  const [site, settings] = await Promise.all([getSite(ctx), manage ? getSiteSettings(ctx) : null]);
  const address = site.address ?? site.slug;
  const bound = settings ? { orgSlug: ctx.org.slug, siteSlug: ctx.site.slug, version: settings.version } : null;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="mb-8 text-2xl font-semibold tracking-tight">Site settings</h1>
      {settings && bound ? (
        <>
          <SettingsSection title="General" description="The site’s name, tagline, language, time zone and social links.">
            <GeneralSettingsForm
              {...bound}
              timeZones={siteTimeZones()}
              values={{
                name: settings.general.name,
                tagline: settings.general.tagline,
                language: settings.general.language,
                timezone: settings.general.timezone,
                ...settings.general.social,
              }}
            />
          </SettingsSection>
          <SettingsSection title="Reading" description="Where the blog lives, and how many posts each page lists.">
            <ReadingSettingsForm {...bound} address={address} values={settings.reading} />
          </SettingsSection>
          <SettingsSection title="Analytics" description="Google Analytics 4 and Plausible. Both optional.">
            <AnalyticsSettingsForm
              {...bound}
              values={{ ga4MeasurementId: settings.analytics.ga4MeasurementId ?? "", plausibleDomain: settings.analytics.plausibleDomain ?? "" }}
            />
          </SettingsSection>
        </>
      ) : null}
      {manage && site.address ? (
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
