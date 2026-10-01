import { ActionLink, EmailLayout, formatDate, Paragraph, SmallPrint } from "./layout";

export type OrganizationInvitationProps = {
  inviterName: string;
  organizationName: string;
  roleName: string;
  url: string;
  expiresAt: Date;
};

export const organizationInvitationSubject = (p: Pick<OrganizationInvitationProps, "inviterName" | "organizationName">) =>
  `${p.inviterName} invited you to ${p.organizationName} on Forge`;

export function OrganizationInvitation({ inviterName, organizationName, roleName, url, expiresAt }: OrganizationInvitationProps) {
  return (
    <EmailLayout preview={`Join ${organizationName} on Forge.`} heading={`Join ${organizationName} on Forge`}>
      <Paragraph>
        {inviterName} invited you to join {organizationName} as {roleName}.
      </Paragraph>
      <ActionLink href={url} label="Accept invitation" />
      <SmallPrint>This invitation expires on {formatDate(expiresAt)}.</SmallPrint>
      <SmallPrint>If you weren&apos;t expecting it, you can ignore this email.</SmallPrint>
    </EmailLayout>
  );
}
