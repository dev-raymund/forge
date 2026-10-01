import "server-only";
import { EmailConfigError, EmailProviderError, type EmailMessage, type EmailProvider, type SendOptions } from "../provider";

const ENDPOINT = "https://api.resend.com/emails";

/**
 * Resend over its HTTP API (no SDK: one request, fully testable). The only
 * place that knows Resend. The job id travels as the `Idempotency-Key`, so a
 * retried job can't send the same email twice within Resend's 24 h window.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";

  constructor(
    private readonly config: { apiKey: string; from: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: EmailMessage, { idempotencyKey }: SendOptions) {
    let response: Response;
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          from: this.config.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          tags: Object.entries(message.tags ?? {}).map(([name, value]) => ({ name, value })),
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // Network failure or timeout: the request may or may not have arrived; the idempotency key makes a retry safe.
      throw new EmailProviderError(`Resend unreachable: ${err instanceof Error ? err.name : "error"}`, true);
    }

    if (response.ok) {
      const body = (await response.json().catch(() => ({}))) as { id?: string };
      return { providerMessageId: body.id ?? "unknown" };
    }

    const detail = await describe(response);
    if (response.status === 401 || response.status === 403) {
      // Bad key or unverified sending domain: fixable configuration, so the job keeps retrying meanwhile.
      throw new EmailConfigError(
        `Resend rejected the request (${response.status}): check RESEND_API_KEY and that the EMAIL_FROM domain is verified. ${detail}`,
      );
    }
    const retryable = response.status === 429 || response.status >= 500;
    throw new EmailProviderError(`Resend ${response.status}: ${detail}`, retryable, response.status);
  }
}

async function describe(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { name?: string; message?: string } | null;
  return [body?.name, body?.message].filter(Boolean).join(": ").slice(0, 300) || response.statusText;
}
