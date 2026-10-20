import type { Metadata } from "next";
import { Suspense } from "react";
import { NoAccess, OrganizationSuspended } from "@/components/admin/page-notice";
import { PageSkeleton } from "@/components/admin/page-skeleton";
import { SettingsSection } from "@/components/admin/settings-section";
import { canManageMenus, getMenus, MenuEditor, siteMenusPath } from "@/modules/navigation";
import { requireSitePage } from "@/modules/tenancy";

export const metadata: Metadata = { title: "Menus" };

/**
 * A site's menus (plan §19: `/…/menus`; M8-3, ADR 0030): its header menu and its footer menu, each edited and saved
 * as a whole.
 *
 *   open the page, save a menu    Owner, Admin, Editor    canManageMenus (`site.menus.manage`); every save checks again
 */
export default function MenusPage({ params }: PageProps<"/[orgSlug]/sites/[siteSlug]/menus">) {
  return (
    <Suspense fallback={<PageSkeleton narrow />}>
      <Menus params={params} />
    </Suspense>
  );
}

async function Menus({ params }: Pick<PageProps<"/[orgSlug]/sites/[siteSlug]/menus">, "params">) {
  const { orgSlug, siteSlug } = await params;
  const access = await requireSitePage(orgSlug, siteSlug, siteMenusPath);
  if (access.status === "suspended") return <OrganizationSuspended message={access.message} />;

  const { ctx } = access;
  if (!canManageMenus(ctx)) {
    return (
      <NoAccess>
        <p>A site&rsquo;s menus are for Owners, Admins and Editors of {ctx.org.name}.</p>
      </NoAccess>
    );
  }
  const { menus, categories, blogPath } = await getMenus(ctx);
  const editor = (location: "header" | "footer", title: string) => (
    <MenuEditor
      key={location}
      orgSlug={ctx.org.slug}
      siteSlug={ctx.site.slug}
      title={title}
      menu={menus[location]}
      categories={categories}
      blogPath={blogPath}
    />
  );

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Menus</h1>
      <p className="mb-8 text-muted-foreground">
        The links at the top and bottom of every page of {ctx.site.name}. Two levels: drag a link onto another to put it under it, or use its Arrange menu.
      </p>
      <SettingsSection title="Header menu" description="Shown under or beside the site's name, in its header. Links under a link open from a button beside it.">
        {editor("header", "Header menu")}
      </SettingsSection>
      <SettingsSection title="Footer menu" description="Shown at the bottom of every page. Links under a link are listed under it.">
        {editor("footer", "Footer menu")}
      </SettingsSection>
    </main>
  );
}
