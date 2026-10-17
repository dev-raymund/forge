import type { Metadata } from "next";
import { Suspense } from "react";
import { NoAccess, OrganizationSuspended } from "@/components/admin/page-notice";
import { PageSkeleton } from "@/components/admin/page-skeleton";
import { SettingsSection } from "@/components/admin/settings-section";
import { AppearanceEditor, canManageAppearance, getAppearance, getSiteImages, siteAppearancePath, SiteImageField, ThemePicker } from "@/modules/sites";
import { themeDefinition } from "@/themes/registry";
import { requireSitePage } from "@/modules/tenancy";

export const metadata: Metadata = { title: "Appearance" };

/**
 * A site's appearance (plan §19: `/…/appearance`, Admin): its theme (M4-4); its logo (the M6-4 control, also on the
 * settings page); and the theme's settings, colours, fonts, header, footer and layout, with a live preview (M8-1).
 *
 *   open the page, change any of it    Owner, Admin    canManageAppearance (`site.settings.manage`); every action checks again
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
  const [appearance, images] = await Promise.all([getAppearance(ctx), getSiteImages(ctx)]);
  const themeName = themeDefinition(appearance.theme)?.name ?? appearance.theme;

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="mb-8 text-2xl font-semibold tracking-tight">Appearance</h1>
      <div className="max-w-3xl">
        <SettingsSection
          title="Theme"
          description={`How ${ctx.site.name} looks to its visitors. Switching themes keeps the site's content, and the colours, fonts and layout it has chosen.`}
        >
          <ThemePicker orgSlug={ctx.org.slug} siteSlug={ctx.site.slug} themes={appearance.themes} active={appearance.theme} />
        </SettingsSection>
        <SettingsSection title="Logo" description="An image from the media library, shown in the site's header in place of its name.">
          <SiteImageField orgSlug={ctx.org.slug} siteSlug={ctx.site.slug} role="logo" {...images.logo} />
        </SettingsSection>
      </div>
      <SettingsSection
        title={`Customise ${themeName}`}
        description="Colours, fonts, header, footer and layout. The preview shows your changes before you save them; visitors see them once you save."
      >
        {/* A new theme brings its own header and footer styles: the editor starts again from what it has saved. */}
        <AppearanceEditor
          key={appearance.theme}
          orgSlug={ctx.org.slug}
          siteSlug={ctx.site.slug}
          themeName={themeName}
          settings={appearance.settings}
          version={appearance.version}
          variants={appearance.variants}
        />
      </SettingsSection>
    </main>
  );
}
