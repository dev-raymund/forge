import type { Metadata } from "next";
import { Suspense } from "react";
import { OrganizationSuspended } from "@/components/admin/page-notice";
import { PageSkeleton } from "@/components/admin/page-skeleton";
import { listInvitations, listMembers, MembersPage, membersViewFor, orgMembersPath, requireOrgPage } from "@/modules/tenancy";

export const metadata: Metadata = { title: "Members" };

/**
 * The people of an organization (plan §19): every member may see the list;
 * inviting, changing roles and removing take `org.members.manage` (Owner and
 * Admin), and the invitations waiting for an answer are shown to them only.
 *
 * What each row offers is worked out on the server from the same rules the
 * actions apply (modules/tenancy/members-view.ts). The actions decide again.
 */
export default function OrganizationMembersPage({ params }: PageProps<"/[orgSlug]/members">) {
  return (
    <Suspense fallback={<PageSkeleton narrow />}>
      <OrganizationMembers params={params} />
    </Suspense>
  );
}

async function OrganizationMembers({ params }: Pick<PageProps<"/[orgSlug]/members">, "params">) {
  const { orgSlug } = await params;
  const access = await requireOrgPage(orgSlug, orgMembersPath);
  if (access.status === "suspended") return <OrganizationSuspended message={access.message} />;

  const { ctx } = access;
  const view = membersViewFor(ctx, await listMembers(ctx));
  // Who has been invited is for those who manage members. Not read at all for anyone else.
  const invitations = view.canManage ? await listInvitations(ctx) : [];
  return <MembersPage organization={{ name: ctx.org.name, slug: ctx.org.slug }} view={view} invitations={invitations} />;
}
