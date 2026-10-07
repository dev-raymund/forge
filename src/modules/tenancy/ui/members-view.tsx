import Link from "next/link";
import { FormAlert } from "@/components/admin/form";
import { Day } from "@/components/admin/local-day";
import { SettingsSection } from "@/components/admin/settings-section";
import { ASSIGNABLE_ROLES } from "../invitation-rules";
import type { InvitationSummary } from "../invitations.service";
import type { MembersView as Members } from "../members-view";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "../shared";
import { InvitationActions, InviteMember, LeaveOrganization, MemberActions, MembersBoard, type RoleOption } from "./members";

/**
 * The members page: who is in the organization, and for those who manage
 * members, who has been invited (M3-4).
 *
 * Rendered from what the server worked out for this viewer (../members-view.ts):
 * booleans per row and for the page. Roles appear here as words to read, never
 * as something a component compares.
 */

/** The roles that can be chosen on this page. Owner is not one: ownership is handed over in the settings. */
const ROLE_OPTIONS: RoleOption[] = ASSIGNABLE_ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role], description: ROLE_DESCRIPTIONS[role] }));

const BADGE = "rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground";

export type MembersPageProps = {
  organization: { name: string; slug: string };
  view: Members;
  /** Open invitations. Passed only to a viewer who manages members. */
  invitations: InvitationSummary[];
};

export function MembersPage({ organization, view, invitations }: MembersPageProps) {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
        {view.canInvite ? <InviteMember orgSlug={organization.slug} roles={ROLE_OPTIONS} /> : null}
      </div>

      {view.mustVerifyEmail ? (
        <FormAlert tone="info" className="mb-8">
          Verify your email address to invite people. <Link href="/verify-email">Verify email</Link>
        </FormAlert>
      ) : null}

      <MembersBoard orgSlug={organization.slug}>
        <SettingsSection title="People" description={`Everyone who can open ${organization.name} in Forge, and what they can do there.`}>
          <div className="overflow-hidden rounded-lg border">
            <table className="w-full text-sm" data-testid="members">
              <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium sm:px-4">
                    Member
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium sm:px-4">
                    Role
                  </th>
                  <th scope="col" className="hidden px-4 py-2 font-medium sm:table-cell">
                    Joined
                  </th>
                  <th scope="col" className="w-px px-3 py-2 sm:px-4">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {view.members.map((member) => (
                  <tr key={member.id} data-testid="member" data-self={member.isSelf || undefined}>
                    <th scope="row" className="max-w-0 px-3 py-3 text-left font-normal sm:px-4">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="truncate font-medium">{member.name}</span>
                        {member.isSelf ? <span className={BADGE}>You</span> : null}
                      </span>
                      <span className="block truncate text-muted-foreground">{member.email}</span>
                    </th>
                    <td className="px-3 py-3 align-top sm:px-4" data-testid="role">
                      {ROLE_LABELS[member.role]}
                    </td>
                    <td className="hidden px-4 py-3 align-top text-muted-foreground sm:table-cell">
                      <Day iso={member.joinedAt.toISOString()} />
                    </td>
                    <td className="px-3 py-2 text-right align-top sm:px-4">
                      {member.isSelf ? (
                        <LeaveOrganization orgSlug={organization.slug} orgName={organization.name} blocked={view.leaveBlocked !== null} />
                      ) : (
                        <MemberActions
                          orgName={organization.name}
                          member={{ id: member.id, name: member.name }}
                          currentRole={member.isOwner ? undefined : member.role}
                          canChangeRole={member.canChangeRole}
                          canRemove={member.canRemove}
                          roles={ROLE_OPTIONS}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {view.canManage ? (
            <p className="max-w-prose text-sm text-muted-foreground">
              An organization has an Owner, and ownership is not a role to pick from a list: an Owner hands it to another member in{" "}
              <Link href={`/${organization.slug}/settings`} className="font-medium text-foreground underline underline-offset-4">
                Settings
              </Link>
              .
            </p>
          ) : null}
        </SettingsSection>

        {view.canManage ? (
          <SettingsSection title="Invitations" description="People who have been invited and have not joined yet. A link works for 7 days.">
            {invitations.length > 0 ? (
              <ul className="divide-y rounded-lg border" data-testid="invitations">
                {invitations.map((invitation) => (
                  <li key={invitation.id} data-testid="invitation" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 p-3 sm:p-4">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                        <span className="truncate font-medium">{invitation.email}</span>
                        <span className={BADGE}>{ROLE_LABELS[invitation.role]}</span>
                        {invitation.expired ? <span className={`${BADGE} border-destructive/40 text-destructive`}>Expired</span> : null}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {invitation.invitedByName ? `Invited by ${invitation.invitedByName}. ` : null}
                        {invitation.expired ? "Expired on " : "Expires on "}
                        <Day iso={invitation.expiresAt.toISOString()} />.
                      </p>
                    </div>
                    <InvitationActions invitationId={invitation.id} email={invitation.email} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground" data-testid="no-invitations">
                Nobody is waiting on an invitation.
              </p>
            )}
          </SettingsSection>
        ) : null}
      </MembersBoard>
    </main>
  );
}
