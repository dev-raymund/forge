import { ActionLink, EmailLayout, Paragraph, SmallPrint } from "./layout";

export type VerifyEmailProps = { name: string; url: string };

export const verifyEmailSubject = () => "Verify your email for Forge";

export function VerifyEmail({ name, url }: VerifyEmailProps) {
  return (
    <EmailLayout preview="Confirm your email address to finish setting up Forge." heading="Verify your email">
      <Paragraph>Hi {name || "there"},</Paragraph>
      <Paragraph>Confirm your email address to finish setting up your Forge account.</Paragraph>
      <ActionLink href={url} label="Verify email" />
      <SmallPrint>If you didn&apos;t create a Forge account, you can ignore this email.</SmallPrint>
    </EmailLayout>
  );
}
