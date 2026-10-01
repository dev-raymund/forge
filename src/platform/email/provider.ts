/**
 * The email provider contract (M1-4). Application code never talks to a
 * provider: it queues `email.send` (./job.ts), whose handler renders the
 * template and calls `send`. Only the adapters in ./providers know vendors.
 *
 * A message has no `from`: the sender is the configured platform identity
 * (EMAIL_FROM), never caller-controlled.
 */

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Short ASCII labels for the provider's dashboard, e.g. the template name. */
  tags?: Record<string, string>;
};

export type SendOptions = {
  /**
   * Same key → the same message is delivered at most once. `email.send` uses
   * the job id (plus the recipient for multi-recipient jobs), so a retry after
   * a send whose response was lost cannot deliver twice. Resend honours it
   * for 24 h.
   */
  idempotencyKey: string;
};

export type SendResult = { providerMessageId: string };

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage, options: SendOptions): Promise<SendResult>;
}

/** A delivery failure. `retryable` decides between a retry and a permanent failure of the job. */
export class EmailProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EmailProviderError";
  }
}

/** Email is misconfigured (missing/invalid variables, rejected credentials). Explains what to set, never values. */
export class EmailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailConfigError";
  }
}
