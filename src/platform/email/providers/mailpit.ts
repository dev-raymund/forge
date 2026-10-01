import "server-only";
import { parseSender } from "../config";
import { EmailProviderError, type EmailMessage, type EmailProvider, type SendOptions } from "../provider";

/**
 * Local development: hands the message to the Mailpit container
 * (docker-compose) over its HTTP API. Nothing leaves the machine; the inbox
 * is at http://localhost:8025, where verification and reset links can be
 * clicked without ever printing them to a log. E2E tests read it too.
 */
export class MailpitEmailProvider implements EmailProvider {
  readonly name = "mailpit";

  constructor(
    private readonly config: { url: string; from: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: EmailMessage, { idempotencyKey }: SendOptions) {
    const from = parseSender(this.config.from);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.url}/api/v1/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          From: { Email: from.email, Name: from.name ?? "" },
          To: [{ Email: message.to }],
          Subject: message.subject,
          HTML: message.html,
          Text: message.text,
          Tags: Object.values(message.tags ?? {}),
          Headers: { "X-Forge-Idempotency-Key": idempotencyKey },
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new EmailProviderError(`Mailpit unreachable at ${this.config.url} (is \`npm run dev:services\` running?)`, true);
    }
    if (!response.ok) throw new EmailProviderError(`Mailpit ${response.status}`, response.status >= 500, response.status);
    const body = (await response.json().catch(() => ({}))) as { ID?: string };
    return { providerMessageId: body.ID ?? "mailpit" };
  }
}
