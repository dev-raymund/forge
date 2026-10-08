import { Suspense } from "react";
import { AppHeader } from "@/components/admin/app-header";
import { ShellSkeleton } from "@/components/admin/page-skeleton";
import { SectionNav } from "@/components/admin/section-nav";
import { getCurrentActor, VerifyEmailBanner } from "@/modules/auth";
import {
  canReadActivity, canViewOrganizationSettings, listOrganizations, orgActivityPath, orgMembersPath, orgSettingsPath, orgSitesPath, requireOrgPage,
} from "@/modules/tenancy";

/**
 * The shell of every page of one organization (`/{orgSlug}/…`): the header
 * with the organization switcher and the account menu, and the organization's
 * own links.
 *
 * The organization is the one in the URL, and the shell is rendered only for
 * a member of it: `requireOrgPage` sends everyone else to the login page or the
 * 404 page before anything about the organization is read.
 */
export default function OrganizationLayout({ children, params }: LayoutProps<"/[orgSlug]">) {
  return (
    <div className="flex min-h-dvh flex-col">
      <Suspense fallback={<ShellSkeleton nav />}>
        <OrganizationShell params={params} />
      </Suspense>
      {children}
    </div>
  );
}

async function OrganizationShell({ params }: Pick<LayoutProps<"/[orgSlug]">, "params">) {
  const { orgSlug } = await params;
  const access = await requireOrgPage(orgSlug);
  // The switcher's list: the organizations of the signed-in user, read for this request.
  const organizations = await listOrganizations(await getCurrentActor());

  // A suspended organization: its members still get the header, to reach their other organizations. Nothing else.
  const links =
    access.status === "ok"
      ? [
          // The organization's home since M4-1 (plan §19): `/{orgSlug}` itself redirects here.
          { href: orgSitesPath(access.ctx.org.slug), label: "Sites" },
          // Every member may see who else is here; what they may do there is the page's business.
          { href: orgMembersPath(access.ctx.org.slug), label: "Members" },
          ...(canReadActivity(access.ctx) ? [{ href: orgActivityPath(access.ctx.org.slug), label: "Activity" }] : []),
          ...(canViewOrganizationSettings(access.ctx) ? [{ href: orgSettingsPath(access.ctx.org.slug), label: "Settings" }] : []),
        ]
      : [];

  return (
    <>
      <AppHeader user={access.user} organizations={organizations} currentSlug={orgSlug} />
      {access.user.emailVerified ? null : <VerifyEmailBanner />}
      {links.length > 0 ? <SectionNav label="Organization" items={links} /> : null}
    </>
  );
}
