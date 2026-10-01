import { afterEach, describe, expect, it } from "vitest";
import { setLogSink } from "@/platform/observability/logger";
import { emailConfig, parseSender } from "./config";
import { EmailConfigError, EmailProviderError, type EmailMessage } from "./provider";
import { CaptureEmailProvider } from "./providers/capture";
import { ConsoleEmailProvider } from "./providers/console";
import { MailpitEmailProvider } from "./providers/mailpit";
import { ResendEmailProvider } from "./providers/resend";

const message: EmailMessage = {
  to: "ada@example.com",
  subject: "Verify your email for Forge",
  html: "<p>secret link https://cms.example.com/x?token=tok_123</p>",
  text: "secret link https://cms.example.com/x?token=tok_123",
  tags: { template: "verify-email" },
};

/** A fake fetch that records the request and answers with `status`/`body`. */
function fakeFetch(status: number, body: unknown = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

afterEach(() => setLogSink(null));

describe("ResendEmailProvider", () => {
  const config = { apiKey: "re_test_key", from: "Forge <no-reply@cms.example.com>" };

  it("sends one request with the platform sender and the job id as idempotency key", async () => {
    const { calls, impl } = fakeFetch(200, { id: "re_msg_1" });
    const result = await new ResendEmailProvider(config, impl).send(message, { idempotencyKey: "job-123" });
    expect(result).toEqual({ providerMessageId: "re_msg_1" });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authorization: "Bearer re_test_key",
      "content-type": "application/json",
      "idempotency-key": "job-123",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      from: "Forge <no-reply@cms.example.com>",
      to: ["ada@example.com"],
      subject: message.subject,
      html: message.html,
      text: message.text,
      tags: [{ name: "template", value: "verify-email" }],
    });
  });

  it.each([
    [429, true],
    [500, true],
    [503, true],
    [422, false],
    [400, false],
  ])("HTTP %i → EmailProviderError (retryable: %s)", async (status, retryable) => {
    const { impl } = fakeFetch(status, { name: "error", message: "nope" });
    const err = await new ResendEmailProvider(config, impl).send(message, { idempotencyKey: "k" }).catch((e) => e);
    expect(err).toBeInstanceOf(EmailProviderError);
    expect(err).toMatchObject({ retryable, status });
  });

  it.each([401, 403])("HTTP %i is a configuration fault with an explanation, never the key", async (status) => {
    const { impl } = fakeFetch(status, { name: "validation_error", message: "The domain is not verified" });
    const err = await new ResendEmailProvider(config, impl).send(message, { idempotencyKey: "k" }).catch((e) => e);
    expect(err).toBeInstanceOf(EmailConfigError);
    expect(err.message).toMatch(/RESEND_API_KEY.*EMAIL_FROM/);
    expect(err.message).not.toContain("re_test_key");
  });

  it("a network failure is retryable", async () => {
    const impl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(new ResendEmailProvider(config, impl).send(message, { idempotencyKey: "k" })).rejects.toMatchObject({
      retryable: true,
    });
  });
});

describe("MailpitEmailProvider", () => {
  it("hands the message to Mailpit's HTTP API with the sender split into name and address", async () => {
    const { calls, impl } = fakeFetch(200, { ID: "mp1" });
    const provider = new MailpitEmailProvider({ url: "http://localhost:8025", from: "Forge <no-reply@forge.localhost>" }, impl);
    expect(await provider.send(message, { idempotencyKey: "job-1" })).toEqual({ providerMessageId: "mp1" });
    expect(calls[0]!.url).toBe("http://localhost:8025/api/v1/send");
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      From: { Email: "no-reply@forge.localhost", Name: "Forge" },
      To: [{ Email: "ada@example.com" }],
      Subject: message.subject,
      Headers: { "X-Forge-Idempotency-Key": "job-1" },
    });
  });
});

describe("CaptureEmailProvider", () => {
  it("captures messages and delivers each idempotency key once", async () => {
    const capture = new CaptureEmailProvider();
    await capture.send(message, { idempotencyKey: "a" });
    await capture.send(message, { idempotencyKey: "a" });
    await capture.send({ ...message, to: "bob@example.com" }, { idempotencyKey: "b" });
    expect(capture.messages.map((m) => [m.to, m.idempotencyKey])).toEqual([
      ["ada@example.com", "a"],
      ["bob@example.com", "b"],
    ]);
  });

  it("scripts failures, including one after delivery (a lost response)", async () => {
    const capture = new CaptureEmailProvider()
      .failNext(new EmailProviderError("down", true))
      .failNext(new EmailProviderError("timeout", true), { afterDelivery: true });
    await expect(capture.send(message, { idempotencyKey: "a" })).rejects.toThrow("down");
    expect(capture.messages).toHaveLength(0);
    await expect(capture.send(message, { idempotencyKey: "a" })).rejects.toThrow("timeout");
    expect(capture.messages).toHaveLength(1); // delivered, response lost
    await capture.send(message, { idempotencyKey: "a" });
    expect(capture.messages).toHaveLength(1); // the retry doesn't deliver again
  });
});

describe("ConsoleEmailProvider", () => {
  it("logs that an email would be sent, never its body or recipient", async () => {
    const lines: string[] = [];
    setLogSink((_level, line) => lines.push(line));
    await new ConsoleEmailProvider().send(message, { idempotencyKey: "job-9" });
    const logged = lines.join("\n");
    expect(logged).toContain("Verify your email for Forge");
    expect(logged).not.toMatch(/tok_123|secret link|ada@/);
  });
});

describe("email configuration", () => {
  it("needs nothing locally: console unless a provider is set", () => {
    expect(emailConfig({})).toMatchObject({ provider: "console", from: "Forge <no-reply@forge.localhost>" });
    expect(emailConfig({ EMAIL_PROVIDER: "mailpit" })).toMatchObject({ provider: "mailpit", mailpitUrl: "http://localhost:8025" });
  });

  it("defaults to Resend on Vercel production and explains what is missing (names, never values)", () => {
    const err = (() => {
      try {
        emailConfig({ VERCEL_ENV: "production", EMAIL_FROM: "Forge <no-reply@cms.example.com>" });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(EmailConfigError);
    expect(err!.message).toMatch(/RESEND_API_KEY/);
    expect(emailConfig({ VERCEL_ENV: "production", RESEND_API_KEY: "re_live", EMAIL_FROM: "a@b.co" })).toMatchObject({
      provider: "resend",
      resendApiKey: "re_live",
      from: "a@b.co",
    });
  });

  it("parses the sender identity", () => {
    expect(parseSender("Forge <no-reply@cms.example.com>")).toEqual({ name: "Forge", email: "no-reply@cms.example.com" });
    expect(parseSender("no-reply@cms.example.com")).toEqual({ email: "no-reply@cms.example.com" });
  });

  it("importing the email module never reads configuration", async () => {
    const saved = { ...process.env };
    try {
      process.env.EMAIL_PROVIDER = "resend";
      delete process.env.RESEND_API_KEY;
      await expect(import("./index")).resolves.toBeDefined();
    } finally {
      process.env = saved;
    }
  });
});
