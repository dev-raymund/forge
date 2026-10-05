import { FormAlert } from "@/components/admin/form";
import { SettingsSection } from "@/components/admin/settings-section";
import type { SettingsNotice } from "../organization-forms";
import { orgPath } from "../paths";
import { ChangeOrganizationSlugForm, RenameOrganizationForm, TransferOwnership, type TransferCandidate } from "./organization-settings";

/**
 * What the organization settings page shows, given what the member may do.
 *
 * It is told in booleans, worked out on the server from the member's
 * permissions (ADR 0009), and never a role. Leaving a form out here is for the
 * reader's sake only: the form's action decides for itself, every time.
 *
 *   canUpdate    the name and URL forms; otherwise the same two facts, read-only
 *   canTransfer  the transfer dialog, when there is another member to hand it to
 */
export type OrganizationSettingsViewProps = {
  organization: { name: string; slug: string };
  canUpdate: boolean;
  canTransfer: boolean;
  /** The other members. Passed only when `canTransfer`. */
  candidates: TransferCandidate[];
  /** What a redirect back to this page is confirming. */
  notice?: SettingsNotice;
};

export function OrganizationSettingsView({ organization, canUpdate, canTransfer, candidates, notice }: OrganizationSettingsViewProps) {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="mb-8 text-2xl font-semibold tracking-tight">Organization settings</h1>

      {notice === "url" ? (
        <FormAlert tone="success" className="mb-8">
          The organization&rsquo;s URL is now <span className="font-medium">{orgPath(organization.slug)}</span>.
        </FormAlert>
      ) : null}
      {/* Only for someone it is true of: after a transfer the caller is no longer an Owner. */}
      {notice === "owner" && !canTransfer ? (
        <FormAlert tone="success" className="mb-8">
          Ownership has been transferred. You are now an Admin of {organization.name}.
        </FormAlert>
      ) : null}

      {canUpdate ? (
        <>
          <SettingsSection title="Name" description="How this organization is shown to its members in Forge.">
            <RenameOrganizationForm orgSlug={organization.slug} name={organization.name} />
          </SettingsSection>
          <SettingsSection title="URL" description="The address of this organization's pages in Forge.">
            <ChangeOrganizationSlugForm orgSlug={organization.slug} />
          </SettingsSection>
        </>
      ) : (
        <SettingsSection title="General" description="Only an Owner can change the name or the URL of this organization.">
          <dl className="grid max-w-sm gap-4 text-sm" data-testid="organization-details">
            <div className="grid gap-1">
              <dt className="font-medium">Name</dt>
              <dd className="wrap-anywhere">{organization.name}</dd>
            </div>
            <div className="grid gap-1">
              <dt className="font-medium">URL</dt>
              <dd className="wrap-anywhere">{orgPath(organization.slug)}</dd>
            </div>
          </dl>
        </SettingsSection>
      )}

      <SettingsSection
        title="Ownership"
        description={
          canTransfer
            ? "Hand this organization to another member. They become an Owner, and you become an Admin."
            : "Only an Owner can transfer this organization to another member."
        }
      >
        {canTransfer ? (
          candidates.length > 0 ? (
            <TransferOwnership orgSlug={organization.slug} orgName={organization.name} candidates={candidates} />
          ) : (
            <p className="max-w-prose text-sm text-muted-foreground" data-testid="no-transfer-candidates">
              There is nobody to transfer it to yet. An organization can only be handed to someone who is already one of its members.
            </p>
          )
        ) : null}
      </SettingsSection>
    </main>
  );
}
