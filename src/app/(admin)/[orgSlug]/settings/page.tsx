import type { Metadata } from "next";
import { Suspense } from "react";
import { NoAccess, OrganizationSuspended } from "@/components/admin/page-notice";
import { PageSkeleton } from "@/components/admin/page-skeleton";
import {
  canTransferOwnership, canUpdateOrganization, canViewOrganizationSettings, listMembers, OrganizationSettingsView, orgSettingsPath, requireOrgPage,
  ROLE_LABELS, SETTINGS_NOTICES,
} from "@/modules/tenancy";

export const metadata: Metadata = { title: "Organization settings" };

/**
 * An organization's settings (plan §19): its name, its URL, and handing it to
 * another member.
 *
 * Who sees what is decided here, on the server, from the member's permissions
 * (ADR 0009), and only as what to render: each form's action checks again.
 *
 *   open the page          Owner, Admin        canViewOrganizationSettings
 *   change name or URL     Owner               canUpdateOrganization   (`org.manage`)
 *   transfer ownership     Owner               canTransferOwnership    (`org.manage`, and the membership rules)
 */
export default function OrganizationSettingsPage({ params, searchParams }: PageProps<"/[orgSlug]/settings">) {
  return (
    <Suspense fallback={<PageSkeleton narrow />}>
      <OrganizationSettings params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function OrganizationSettings({ params, searchParams }: PageProps<"/[orgSlug]/settings">) {
  const [{ orgSlug }, query] = await Promise.all([params, searchParams]);
  const access = await requireOrgPage(orgSlug, orgSettingsPath);
  if (access.status === "suspended") return <OrganizationSuspended message={access.message} />;

  const { ctx } = access;
  if (!canViewOrganizationSettings(ctx)) {
    return (
      <NoAccess>
        <p>Organization settings are for Owners and Admins of {ctx.org.name}. Ask one of them if something needs changing.</p>
      </NoAccess>
    );
  }

  const canTransfer = canTransferOwnership(ctx);
  // The other members, for the Owner to choose from. Not read at all for anyone else.
  const candidates = canTransfer
    ? (await listMembers(ctx))
        .filter((member) => member.id !== ctx.membership.id)
        .map((member) => ({ memberId: member.id, name: member.name, email: member.email, role: ROLE_LABELS[member.role] }))
    : [];
  const notice = SETTINGS_NOTICES.find((value) => value === query.changed);

  return (
    <OrganizationSettingsView
      organization={{ name: ctx.org.name, slug: ctx.org.slug }}
      canUpdate={canUpdateOrganization(ctx)}
      canTransfer={canTransfer}
      candidates={candidates}
      notice={notice}
    />
  );
}
