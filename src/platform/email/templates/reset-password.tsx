import { ActionLink, EmailLayout, Paragraph, SmallPrint } from "./layout";

export type ResetPasswordProps = { name: string; url: string; expiresInMinutes: number };

export const resetPasswordSubject = () => "Reset your Forge password";

export function ResetPassword({ name, url, expiresInMinutes }: ResetPasswordProps) {
  return (
    <EmailLayout preview="Use this link to choose a new password." heading="Reset your password">
      <Paragraph>Hi {name || "there"},</Paragraph>
      <Paragraph>We received a request to reset the password for your Forge account.</Paragraph>
      <ActionLink href={url} label="Choose a new password" />
      <SmallPrint>This link expires in {expiresInMinutes} minutes and works once.</SmallPrint>
      <SmallPrint>If you didn&apos;t ask to reset your password, ignore this email. Your password stays the same.</SmallPrint>
    </EmailLayout>
  );
}
