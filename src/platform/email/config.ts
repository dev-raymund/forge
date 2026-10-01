import "server-only";
import { ConfigError, env, resolveEmailProvider, type EmailProviderName } from "@/platform/config/env";
import { EmailConfigError } from "./provider";

export type EmailConfig = {
  provider: EmailProviderName;
  /** The platform sender identity. */
  from: string;
  resendApiKey?: string;
  mailpitUrl: string;
};

const LOCAL_SENDER = "Forge <no-reply@forge.localhost>";

/**
 * Resolved lazily, when an email is about to be sent: importing the email
 * module never fails on missing variables. Errors name the variables to set
 * and never include values.
 */
export function emailConfig(source: Record<string, string | undefined> = process.env): EmailConfig {
  let vars;
  try {
    vars = env("email", source);
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new EmailConfigError(
        `Email is not configured: set ${err.variables.join(", ")}. Resend (the default on Vercel production) ` +
          "needs RESEND_API_KEY and EMAIL_FROM; set EMAIL_PROVIDER=mailpit or console to deliver locally instead.",
      );
    }
    throw err;
  }
  const provider = resolveEmailProvider(vars);
  return {
    provider,
    from: vars.EMAIL_FROM ?? LOCAL_SENDER,
    resendApiKey: vars.RESEND_API_KEY,
    mailpitUrl: (vars.MAILPIT_URL ?? "http://localhost:8025").replace(/\/$/, ""),
  };
}

/** `Name <address>` → parts (for providers that take them separately). */
export function parseSender(from: string): { name?: string; email: string } {
  const match = from.match(/^(.*)<([^<>]+)>$/);
  return match ? { name: match[1]!.trim() || undefined, email: match[2]!.trim() } : { email: from.trim() };
}
