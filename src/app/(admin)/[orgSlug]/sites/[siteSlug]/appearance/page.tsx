import type { Metadata } from "next";
import { Suspense } from "react";
import { NoAccess, OrganizationSuspended } from "@/components/admin/page-notice";
import { PageSkeleton } from "@/components/admin/page-skeleton";
import { SettingsSection } from "@/components/admin/settings-section";
import { canManageAppearance, getAppearance, siteAppearancePath, ThemePicker } from "@/modules/sites";
import { requireSitePage } from "@/modules/tenancy";

export const metadata: Metadata = { title: "Appearance" };

/**
 * A site's appearance (plan §19: `/…/appearance`, Admin). In M4-4: choosing its
 * theme. Customising the theme (colours, fonts, header, footer, layout, with a
 * live preview) is M8-1's.
 *
 *   open the page, choose the theme    Owner, Admin    canManageAppearance (`site.settings.manage`)
 */
export default function AppearancePage({ params }: PageProps<"/[orgSlug]/sites/[siteSlug]/appearance">) {
  return (
    <Suspense fallback={<PageSkeleton narrow />}>
      <Appearance params={params} />
    </Suspense>
  );
}

async function Appearance({ params }: Pick<PageProps<"/[orgSlug]/sites/[siteSlug]/appearance">, "params">) {
  const { orgSlug, siteSlug } = await params;
  const access = await requireSitePage(orgSlug, siteSlug, siteAppearancePath);
  if (access.status === "suspended") return <OrganizationSuspended message={access.message} />;

  const { ctx } = access;
  if (!canManageAppearance(ctx)) {
    return (
      <NoAccess>
        <p>A site&rsquo;s appearance is for Owners and Admins of {ctx.org.name}.</p>
      </NoAccess>
    );
  }
  const appearance = await getAppearance(ctx);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="mb-8 text-2xl font-semibold tracking-tight">Appearance</h1>
      <SettingsSection
        title="Theme"
        description={`How ${ctx.site.name} looks to its visitors. Switching themes keeps the site's content, and the colours, fonts and layout it has chosen.`}
      >
        <ThemePicker orgSlug={ctx.org.slug} siteSlug={ctx.site.slug} themes={appearance.themes} active={appearance.theme} />
      </SettingsSection>
    </main>
  );
}
