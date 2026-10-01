import "server-only";
import { logger } from "@/platform/observability/logger";
import type { EmailMessage, EmailProvider, SendOptions } from "../provider";

/**
 * Fallback where nothing may be sent and no Mailpit runs (e.g. a preview
 * deployment without email configured). Logs that a message would have been
 * sent: subject and tags only. Never the body, which carries one-time links.
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";

  async send(message: EmailMessage, { idempotencyKey }: SendOptions) {
    logger.info("email not sent (console provider)", {
      module: "email",
      subject: message.subject,
      tags: message.tags,
      idempotencyKey,
      recipientDomain: message.to.split("@")[1],
    });
    return { providerMessageId: `console:${idempotencyKey}` };
  }
}
