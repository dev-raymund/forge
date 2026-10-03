/**
 * The captured-email helper for E2E (M1-6, delivered with M1-4): reads the
 * local Mailpit inbox that EMAIL_PROVIDER=mailpit delivers to. No real email
 * service is involved.
 */
const MAILPIT = (process.env.MAILPIT_URL ?? "http://localhost:8025").replace(/\/$/, "");

export type CapturedMail = {
  ID: string;
  Subject: string;
  From: { Name: string; Address: string };
  To: { Name: string; Address: string }[];
  HTML: string;
  Text: string;
};

/** Waits for the newest message to `to` (optionally with this subject) and returns it in full. */
export async function waitForEmail(to: string, { subject, timeoutMs = 15_000 }: { subject?: string; timeoutMs?: number } = {}): Promise<CapturedMail> {
  const query = `to:"${to}"${subject ? ` subject:"${subject}"` : ""}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(query)}`);
    const { messages } = (await res.json()) as { messages: { ID: string }[] };
    if (messages?.length) {
      return (await (await fetch(`${MAILPIT}/api/v1/message/${messages[0]!.ID}`)).json()) as CapturedMail;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No email matching ${query} arrived in Mailpit within ${timeoutMs} ms`);
}

/** How many messages `to` has received (to assert that nothing was sent). */
export async function countEmails(to: string): Promise<number> {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  return ((await res.json()) as { messages?: unknown[] }).messages?.length ?? 0;
}

/** The first link in a message's plain-text part. */
export function firstLink(mail: CapturedMail): string {
  const link = mail.Text.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error(`No link in the email "${mail.Subject}"`);
  return link;
}

/** The raw headers of a captured message. */
export async function emailHeaders(id: string): Promise<Record<string, string[]>> {
  return (await fetch(`${MAILPIT}/api/v1/message/${id}/headers`)).json() as Promise<Record<string, string[]>>;
}
