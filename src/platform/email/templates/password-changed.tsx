import { ActionLink, EmailLayout, Paragraph, SmallPrint } from "./layout";

export type PasswordChangedProps = { name: string; email: string; changedAt: Date; url: string };

export const passwordChangedSubject = () => "Your Forge password was changed";

const formatDateTime = (date: Date) =>
  `${new Intl.DateTimeFormat("en", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }).format(date)} UTC`;

/**
 * Sent after a password change (M2-3). A notice, not a link to act on: it
 * carries no token and nothing about the old or the new password. `url` is the
 * app's own "forgot password" page, for the case that the change was not made
 * by the account's owner.
 */
export function PasswordChanged({ name, email, changedAt, url }: PasswordChangedProps) {
  return (
    <EmailLayout preview="The password for your Forge account was changed." heading="Your password was changed">
      <Paragraph>Hi {name || "there"},</Paragraph>
      <Paragraph>
        The password for the Forge account {email} was changed on {formatDateTime(changedAt)}.
      </Paragraph>
      <Paragraph>If you made this change, there is nothing more to do.</Paragraph>
      <Paragraph>If you didn&apos;t, someone else may have access to your account. Choose a new password now:</Paragraph>
      <ActionLink href={url} label="Reset your password" />
      <SmallPrint>For your security, this email never includes your password.</SmallPrint>
    </EmailLayout>
  );
}
