import "server-only";

/** Public email API (M1-4). Application modules queue email; only ./providers know vendors. */
export { emailSend, queueEmail, kickEmail, sendEmailSoon, isAppLink } from "./job";
export type { EmailPayload } from "./job";
export type { EmailMessage, EmailProvider, SendOptions, SendResult } from "./provider";
export { EmailConfigError, EmailProviderError } from "./provider";
export { renderEmail } from "./templates";
export type { TemplateName, TemplateProps } from "./templates";
