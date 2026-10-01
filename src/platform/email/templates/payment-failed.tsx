import { ActionLink, EmailLayout, Paragraph } from "./layout";

export type PaymentFailedProps = { organizationName: string; url: string };

export const paymentFailedSubject = (p: Pick<PaymentFailedProps, "organizationName">) =>
  `Payment failed for ${p.organizationName}`;

export function PaymentFailed({ organizationName, url }: PaymentFailedProps) {
  return (
    <EmailLayout preview="Update your payment method to avoid interruption." heading="We couldn't process your payment">
      <Paragraph>
        The latest payment for the Forge subscription of {organizationName} didn&apos;t go through. Update your payment
        method to avoid an interruption.
      </Paragraph>
      <ActionLink href={url} label="Update payment method" />
    </EmailLayout>
  );
}
