import { ActionLink, EmailLayout, Paragraph } from "./layout";

/** M7-2: a scheduled page or post could not be published at its time; it is a draft again. To the person who scheduled it. */
export type ScheduledPublishFailedProps = { name: string; title: string; siteName: string; when: string; reason: string; url: string };

export const scheduledPublishFailedSubject = (p: Pick<ScheduledPublishFailedProps, "title">) => `Not published as scheduled: ${p.title}`;

export function ScheduledPublishFailed({ name, title, siteName, when, reason, url }: ScheduledPublishFailedProps) {
  return (
    <EmailLayout preview={`${title} was not published on ${siteName}.`} heading="It was not published">
      <Paragraph>
        Hi {name}, &ldquo;{title}&rdquo; on {siteName} was scheduled for {when} and could not be published: {reason}
      </Paragraph>
      <Paragraph>It is a draft again, with nothing lost. Open it, fix what is said above, then publish or schedule it again.</Paragraph>
      <ActionLink href={url} label="Open it" />
    </EmailLayout>
  );
}
