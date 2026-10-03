import { eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { emailSend, queueEmail, sendEmailSoon } from "@/platform/email";
import { setEmailProviderForTests } from "@/platform/email/get-provider";
import { EmailConfigError, EmailProviderError } from "@/platform/email/provider";
import { CaptureEmailProvider } from "@/platform/email/providers/capture";
import { organizationInvitations } from "@/platform/db/schema";
import { withPlatform, withTenant } from "@/platform/db/tenant";
import { createJobRegistry, runJobs } from "@/platform/jobs";
import { jobs } from "@/platform/jobs/schema";
import { setLogSink } from "@/platform/observability/logger";
import { createTenantGraph, createUser } from "../fixtures/factories";

/**
 * M1-4 against real Postgres through PgBouncer: application → email.send job →
 * provider. The capture provider stands in for Resend, honouring idempotency
 * keys the same way.
 */

const APP = "http://localhost:3000"; // APP_ORIGIN in tests/setup/integration-env.ts
const capture = new CaptureEmailProvider();
const registry = createJobRegistry([emailSend]);
const logs: string[] = [];
type Graph = Awaited<ReturnType<typeof createTenantGraph>>;
let A: Graph;
let B: Graph;

beforeAll(async () => {
  setEmailProviderForTests(capture);
  setLogSink((_level, line) => logs.push(line));
  [A, B] = await Promise.all([createTenantGraph(), createTenantGraph()]);
});
afterAll(() => {
  setEmailProviderForTests(null);
  setLogSink(null);
});
beforeEach(() => capture.clear());

/** A fake clock, so retries become due without waiting. */
function fakeClock() {
  let t = Date.now() + 1_000;
  return { now: () => new Date(t), advance: (seconds: number) => void (t += seconds * 1_000) };
}
const run = (now?: () => Date) => runJobs({ registry, budgetMs: 20_000, now, random: () => 0.5 });
const job = async (id: string) => (await withPlatform((tx) => tx.select().from(jobs).where(eq(jobs.id, id))))[0]!;
const unverifiedUser = () => createUser({ emailVerified: false, name: "Ada" });

describe("queue → job → provider", () => {
  it("delivers a verification email to the user's address, with the link, from a committed transaction", async () => {
    const user = await unverifiedUser();
    const url = `${APP}/api/auth/verify-email?token=tok_verify_${uuidv7()}`;
    const { id } = await withPlatform((tx) => queueEmail(tx, { template: "verify-email", userId: user.id, url }));
    expect(capture.messages).toHaveLength(0); // nothing is sent inside the transaction

    expect(await run()).toMatchObject({ succeeded: 1 });
    const [mail] = capture.to(user.email);
    expect(mail).toMatchObject({ subject: "Verify your email for Forge", idempotencyKey: id, tags: { template: "verify-email" } });
    expect(mail!.text).toContain(url);
    expect(mail!.text).toContain("Hi Ada,");
    expect(mail!.html).toContain("Ada");
  });

  it("rejects invalid payloads and links off the app origin, and queues nothing", async () => {
    const user = await unverifiedUser();
    const before = await withPlatform((tx) => tx.execute(sql`select count(*)::int as n from jobs where type = 'email.send'`));
    await expect(
      withPlatform((tx) => queueEmail(tx, { template: "verify-email", userId: "not-a-uuid", url: `${APP}/x` })),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      withPlatform((tx) => queueEmail(tx, { template: "verify-email", userId: user.id, url: "https://evil.example/phish" })),
    ).rejects.toThrow(/app origin/);
    await expect(
      withPlatform((tx) => queueEmail(tx, { template: "nope", userId: user.id, url: `${APP}/x` } as never)),
    ).rejects.toBeInstanceOf(ZodError);
    const after = await withPlatform((tx) => tx.execute(sql`select count(*)::int as n from jobs where type = 'email.send'`));
    expect(after.rows).toEqual(before.rows);
  });

  it("skips a verification email for a user who has verified meanwhile", async () => {
    const user = await createUser({ emailVerified: true });
    await sendEmailSoon({ template: "verify-email", userId: user.id, url: `${APP}/v?token=x` });
    expect(await run()).toMatchObject({ succeeded: 1 });
    expect(capture.to(user.email)).toHaveLength(0);
  });
});

describe("failures", () => {
  it("retries transient provider failures with backoff, then delivers", async () => {
    const clock = fakeClock();
    const user = await unverifiedUser();
    capture.failNext(new EmailProviderError("Resend 503", true)).failNext(new EmailProviderError("Resend 429", true));
    const { id } = await sendEmailSoon({ template: "reset-password", userId: user.id, url: `${APP}/r?token=t` });

    expect(await run(clock.now)).toMatchObject({ retried: 1 });
    expect(await job(id)).toMatchObject({ status: "queued", attempts: 1, lastError: "EmailProviderError: Resend 503" });
    clock.advance(3_600);
    expect(await run(clock.now)).toMatchObject({ retried: 1 });
    clock.advance(3_600);
    expect(await run(clock.now)).toMatchObject({ succeeded: 1 });
    expect(capture.to(user.email)).toHaveLength(1);
    expect(await job(id)).toMatchObject({ status: "succeeded", attempts: 3 });
  });

  it("a permanent provider rejection fails the job once, without retrying", async () => {
    const user = await unverifiedUser();
    capture.failNext(new EmailProviderError("Resend 422: invalid recipient", false, 422));
    const { id } = await sendEmailSoon({ template: "verify-email", userId: user.id, url: `${APP}/v?token=t` });
    expect(await run()).toMatchObject({ failed: 1, retried: 0 });
    expect(await job(id)).toMatchObject({ status: "failed", attempts: 1 });
    expect(capture.messages).toHaveLength(0);
  });

  it("a configuration fault keeps retrying with an explanation, so the email still goes out once fixed", async () => {
    const clock = fakeClock();
    const user = await unverifiedUser();
    capture.failNext(new EmailConfigError("Email is not configured: set RESEND_API_KEY, EMAIL_FROM."));
    const { id } = await sendEmailSoon({ template: "verify-email", userId: user.id, url: `${APP}/v?token=t` });
    expect(await run(clock.now)).toMatchObject({ retried: 1 });
    expect((await job(id)).lastError).toMatch(/set RESEND_API_KEY, EMAIL_FROM/);
    clock.advance(3_600);
    expect(await run(clock.now)).toMatchObject({ succeeded: 1 });
    expect(capture.to(user.email)).toHaveLength(1);
  });

  it("a retry after a lost provider response delivers exactly once (idempotency key = job id)", async () => {
    const clock = fakeClock();
    const user = await unverifiedUser();
    capture.failNext(new EmailProviderError("timeout", true), { afterDelivery: true });
    const { id } = await sendEmailSoon({ template: "verify-email", userId: user.id, url: `${APP}/v?token=t` });
    expect(await run(clock.now)).toMatchObject({ retried: 1 }); // delivered, but the job doesn't know
    clock.advance(3_600);
    expect(await run(clock.now)).toMatchObject({ succeeded: 1 });
    expect(capture.to(user.email)).toHaveLength(1);
    expect(capture.to(user.email)[0]!.idempotencyKey).toBe(id);
  });
});

describe("tenant emails", () => {
  it("an invitation survives email failures: the record stays valid while the job retries", async () => {
    const clock = fakeClock();
    const invitationId = uuidv7();
    const email = `invitee-${uuidv7()}@example.test`;
    const ownerRole = (await withPlatform((tx) => tx.execute<{ id: string }>(sql`select id from roles where key = 'editor'`))).rows[0]!.id;
    capture.failNext(new EmailProviderError("Resend 500", true));

    const queued = await withTenant({ orgId: A.org.id, userId: A.user.id }, async (tx) => {
      await tx.insert(organizationInvitations).values({
        id: invitationId,
        organizationId: A.org.id,
        email,
        roleId: ownerRole,
        tokenHash: `hash-${uuidv7()}`,
        invitedBy: A.user.id,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      });
      return queueEmail(tx, { template: "organization-invitation", invitationId, url: `${APP}/invite/tok_inv_secret` });
    });
    expect((await job(queued.id)).organizationId).toBe(A.org.id);

    expect(await run(clock.now)).toMatchObject({ retried: 1 });
    const stillThere = await withTenant({ orgId: A.org.id }, (tx) =>
      tx.select().from(organizationInvitations).where(eq(organizationInvitations.id, invitationId)),
    );
    expect(stillThere).toHaveLength(1);
    expect(stillThere[0]).toMatchObject({ revokedAt: null, acceptedAt: null });

    clock.advance(3_600);
    expect(await run(clock.now)).toMatchObject({ succeeded: 1 });
    const [mail] = capture.to(email);
    expect(mail!.subject).toBe(`Test User invited you to ${A.org.name} on Forge`);
    expect(mail!.text).toContain("as Editor");
  });

  it("a job for organization A cannot email organization B's invitee", async () => {
    const { id } = await withTenant({ orgId: A.org.id }, (tx) =>
      queueEmail(tx, { template: "organization-invitation", invitationId: B.invitation.id, url: `${APP}/invite/x` }),
    );
    expect(await run()).toMatchObject({ failed: 1 });
    expect((await job(id)).lastError).toMatch(/Invitation not found in this organization/);
    expect(capture.to(B.invitation.email)).toHaveLength(0);
    expect(capture.messages).toHaveLength(0);
  });

  it("an invitation email queued outside its organization is refused", async () => {
    const { id } = await withPlatform((tx) =>
      queueEmail(tx, { template: "organization-invitation", invitationId: A.invitation.id, url: `${APP}/invite/x` }),
    );
    expect(await run()).toMatchObject({ failed: 1 });
    expect((await job(id)).organizationId).toBeNull();
    expect(capture.messages).toHaveLength(0);
  });

  it("billing notices go to the organization's owners only, once each", async () => {
    const { id } = await withTenant({ orgId: A.org.id }, (tx) =>
      queueEmail(tx, { template: "payment-failed", url: `${APP}/${A.org.slug}/settings/billing` }),
    );
    await withTenant({ orgId: A.org.id }, (tx) =>
      queueEmail(tx, { template: "trial-ending", trialEndsAt: "2026-10-15T00:00:00Z", url: `${APP}/${A.org.slug}/settings/billing` }),
    );
    expect(await run()).toMatchObject({ succeeded: 2 });
    expect(capture.messages.map((m) => m.to)).toEqual([A.user.email, A.user.email]);
    expect(capture.messages[0]).toMatchObject({ subject: `Payment failed for ${A.org.name}`, idempotencyKey: `${id}:${A.user.id}` });
    expect(capture.to(B.user.email)).toHaveLength(0);
  });
});

describe("secrets", () => {
  it("one-time links never reach the logs, and leave the stored payload once the job finishes", async () => {
    logs.length = 0;
    const user = await unverifiedUser();
    const token = `tok_secret_${uuidv7()}`;
    const { id } = await sendEmailSoon({ template: "reset-password", userId: user.id, url: `${APP}/api/auth/reset-password/${token}` });
    expect(JSON.stringify((await job(id)).payload)).toContain(token); // needed until sent
    await run();
    expect(capture.to(user.email)[0]!.text).toContain(token);
    expect(JSON.stringify((await job(id)).payload)).not.toContain(token);
    expect((await job(id)).payload).toMatchObject({ template: "reset-password", url: "[redacted]" });
    expect(logs.join("\n")).not.toContain(token);
    expect(logs.join("\n")).not.toContain(user.email);
    expect(logs.some((l) => l.includes('"email sent"') && l.includes(id))).toBe(true);
  });
});

// Better Auth's verification and reset flows through email.send are covered in
// tests/integration/auth.test.ts against the production auth configuration (M2-1).
