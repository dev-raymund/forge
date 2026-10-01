import { expect, test } from "@playwright/test";
import { emailHeaders, waitForEmail } from "./helpers/mailbox";
import { seedUser } from "./helpers/sites";

/**
 * M1-4 end to end, with no email service: the app queues `email.send`,
 * `kickJobs()` runs it after the response, and the Mailpit provider
 * delivers into the local inbox, where the test reads it.
 */

const cronAuth = process.env.CRON_SECRET ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : undefined;

test("a queued verification email is delivered through the job runner to the dev inbox", async ({ request }) => {
  const user = await seedUser("Ada E2E");
  const res = await request.post("/api/dev/email", { data: { userId: user.id }, headers: cronAuth });
  expect(res.status()).toBe(200);
  const { jobId } = await res.json();

  const mail = await waitForEmail(user.email); // delivered by the after() kick, no cron call needed
  expect(mail.Subject).toBe("Verify your email for Forge");
  expect(mail.From.Address).toMatch(/^no-reply@/);
  expect(mail.To.map((t) => t.Address)).toEqual([user.email]);
  expect(mail.Text).toContain("Hi Ada E2E,");
  expect(mail.Text).toMatch(/http:\/\/localhost:\d+\/verify-email\?token=dev-/);
  expect(mail.HTML).toContain("Verify email");
  expect((await emailHeaders(mail.ID))["X-Forge-Idempotency-Key"]).toEqual([jobId]);
});

test("the dev email route rejects bad input", async ({ request }) => {
  const res = await request.post("/api/dev/email", { data: { userId: "nope" }, headers: cronAuth });
  expect(res.status()).toBe(422);
});
