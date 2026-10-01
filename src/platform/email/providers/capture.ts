import type { EmailMessage, EmailProvider, SendOptions } from "../provider";

export type CapturedEmail = EmailMessage & { idempotencyKey: string; providerMessageId: string };

/**
 * In-process provider for tests: records messages instead of sending them,
 * and honours idempotency keys the way Resend does (same key → delivered
 * once). Failures can be scripted to exercise retries.
 */
export class CaptureEmailProvider implements EmailProvider {
  readonly name = "capture";
  readonly messages: CapturedEmail[] = [];
  private readonly failures: { error: Error; afterDelivery: boolean }[] = [];
  private readonly byKey = new Map<string, CapturedEmail>();

  /**
   * The next send fails with `error`. With `afterDelivery`, the message is
   * delivered first and the failure happens after, like a response lost on
   * the way back.
   */
  failNext(error: Error, options: { afterDelivery?: boolean } = {}) {
    this.failures.push({ error, afterDelivery: options.afterDelivery ?? false });
    return this;
  }

  async send(message: EmailMessage, { idempotencyKey }: SendOptions) {
    const failure = this.failures.shift();
    if (failure && !failure.afterDelivery) throw failure.error;
    let delivered = this.byKey.get(idempotencyKey);
    if (!delivered) {
      delivered = { ...message, idempotencyKey, providerMessageId: `capture-${this.messages.length + 1}` };
      this.byKey.set(idempotencyKey, delivered);
      this.messages.push(delivered);
    }
    if (failure) throw failure.error;
    return { providerMessageId: delivered.providerMessageId };
  }

  to(address: string) {
    return this.messages.filter((m) => m.to === address);
  }

  clear() {
    this.messages.length = 0;
    this.byKey.clear();
    this.failures.length = 0;
  }
}
