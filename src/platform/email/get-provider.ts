import "server-only";
import { emailConfig } from "./config";
import { EmailConfigError, type EmailProvider } from "./provider";
import { ConsoleEmailProvider } from "./providers/console";
import { MailpitEmailProvider } from "./providers/mailpit";
import { ResendEmailProvider } from "./providers/resend";

let override: EmailProvider | null = null;
let cached: { key: string; provider: EmailProvider } | undefined;

/**
 * The provider for the current configuration, built on first use (never at
 * import). Throws EmailConfigError, with an explanation, when the selected
 * provider can't be built.
 */
export function getEmailProvider(): EmailProvider {
  if (override) return override;
  const config = emailConfig();
  const key = `${config.provider}|${config.from}|${config.mailpitUrl}|${config.resendApiKey ? "key" : ""}`;
  if (cached?.key === key) return cached.provider;
  let provider: EmailProvider;
  switch (config.provider) {
    case "resend":
      if (!config.resendApiKey) throw new EmailConfigError("Email is not configured: set RESEND_API_KEY.");
      provider = new ResendEmailProvider({ apiKey: config.resendApiKey, from: config.from });
      break;
    case "mailpit":
      provider = new MailpitEmailProvider({ url: config.mailpitUrl, from: config.from });
      break;
    case "console":
      provider = new ConsoleEmailProvider();
      break;
  }
  cached = { key, provider };
  return provider;
}

/** Tests: route every send to this provider (e.g. CaptureEmailProvider); null restores configuration. */
export function setEmailProviderForTests(provider: EmailProvider | null) {
  override = provider;
}
