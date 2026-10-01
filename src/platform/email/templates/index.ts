import { render } from "@react-email/render";
import { createElement, type FunctionComponent } from "react";
import { OrganizationInvitation, organizationInvitationSubject, type OrganizationInvitationProps } from "./organization-invitation";
import { PaymentFailed, paymentFailedSubject, type PaymentFailedProps } from "./payment-failed";
import { ResetPassword, resetPasswordSubject, type ResetPasswordProps } from "./reset-password";
import { TrialEnding, trialEndingSubject, type TrialEndingProps } from "./trial-ending";
import { VerifyEmail, verifyEmailSubject, type VerifyEmailProps } from "./verify-email";

/** The V1 transactional templates (plan §16, M1-4). No marketing email. */
export type TemplateProps = {
  "verify-email": VerifyEmailProps;
  "reset-password": ResetPasswordProps;
  "organization-invitation": OrganizationInvitationProps;
  "trial-ending": TrialEndingProps;
  "payment-failed": PaymentFailedProps;
};
export type TemplateName = keyof TemplateProps;

const TEMPLATES: { [K in TemplateName]: { component: FunctionComponent<TemplateProps[K]>; subject: (p: TemplateProps[K]) => string } } = {
  "verify-email": { component: VerifyEmail, subject: verifyEmailSubject },
  "reset-password": { component: ResetPassword, subject: resetPasswordSubject },
  "organization-invitation": { component: OrganizationInvitation, subject: organizationInvitationSubject },
  "trial-ending": { component: TrialEnding, subject: trialEndingSubject },
  "payment-failed": { component: PaymentFailed, subject: paymentFailedSubject },
};

/** Subjects are plain header text: no line breaks (header injection), bounded length. */
const cleanSubject = (s: string) => s.replace(/[\r\n\t]+/g, " ").trim().slice(0, 200);

export async function renderEmail<K extends TemplateName>(name: K, props: TemplateProps[K]) {
  const template = TEMPLATES[name];
  const element = createElement(template.component as FunctionComponent<TemplateProps[K]>, props);
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { subject: cleanSubject(template.subject(props)), html, text };
}
