import { ActionLink, EmailLayout, formatDate, Paragraph } from "./layout";

export type TrialEndingProps = { organizationName: string; trialEndsAt: Date; url: string };

export const trialEndingSubject = (p: Pick<TrialEndingProps, "organizationName" | "trialEndsAt">) =>
  `Your Forge trial for ${p.organizationName} ends ${formatDate(p.trialEndsAt)}`;

export function TrialEnding({ organizationName, trialEndsAt, url }: TrialEndingProps) {
  return (
    <EmailLayout preview="Choose a plan to keep your Pro features." heading="Your trial is ending">
      <Paragraph>
        The Forge trial for {organizationName} ends on {formatDate(trialEndsAt)}. Choose a plan to keep your Pro
        features. Nothing is deleted if you don&apos;t.
      </Paragraph>
      <ActionLink href={url} label="Choose a plan" />
    </EmailLayout>
  );
}
