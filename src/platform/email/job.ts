import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { env } from "@/platform/config/env";
import { organizationInvitations, organizationMembers, organizations, roles, users } from "@/platform/db/schema";
import { withPlatform, type Tx } from "@/platform/db/tenant";
import { defineJob, enqueue, kickJobs, PermanentJobError, type EnqueueOptions, type JobContext } from "@/platform/jobs";
import { reportError } from "@/platform/observability/sentry";
import { getEmailProvider } from "./get-provider";
import { EmailConfigError, EmailProviderError } from "./provider";
import { renderEmail, type TemplateName, type TemplateProps } from "./templates";

/**
 * `email.send` (plan §16, M1-4): the only way application code sends email.
 *
 * - Queued inside the business transaction (`queueEmail(tx, …)`), so the email
 *   exists only if the change committed, and a delivery failure can never roll
 *   the change back.
 * - Recipients are never taken from the caller: the job resolves them when it
 *   runs, from a user, an open invitation, or the organization's owners. The
 *   sender is the configured platform identity.
 * - `inherit` scope: invitation and billing emails carry the enqueuing
 *   transaction's organization and read their data under its RLS context.
 * - Delivery is at least once, made exactly once by the provider's idempotency
 *   key = the job id (+ recipient). The provider call happens outside any
 *   database transaction.
 * - One-time links are removed from the stored payload when the job finishes.
 */

const appLink = z.url({ protocol: /^https?$/ }).max(2048);

export const emailPayload = z.discriminatedUnion("template", [
  z.object({ template: z.literal("verify-email"), userId: z.uuid(), url: appLink }),
  z.object({
    template: z.literal("reset-password"),
    userId: z.uuid(),
    url: appLink,
    expiresInMinutes: z.int().min(1).max(1_440).default(60),
  }),
  // A notice after a password change. `url` is the app's forgot-password page: no token, nothing secret.
  z.object({ template: z.literal("password-changed"), userId: z.uuid(), url: appLink, changedAt: z.iso.datetime() }),
  z.object({ template: z.literal("organization-invitation"), invitationId: z.uuid(), url: appLink }),
  z.object({ template: z.literal("trial-ending"), trialEndsAt: z.iso.datetime(), url: appLink }),
  z.object({ template: z.literal("payment-failed"), url: appLink }),
]);
export type EmailPayload = z.input<typeof emailPayload>;
type ParsedPayload = z.output<typeof emailPayload>;

/** Every link in an email points at the app itself (ADR 0006: one origin). */
export function isAppLink(url: string): boolean {
  try {
    return new URL(url).origin === new URL(env("core").APP_ORIGIN).origin;
  } catch {
    return false;
  }
}

type Delivery<K extends TemplateName = TemplateName> = { to: string; key: string; template: K; props: TemplateProps[K] };

async function userRecipient(userId: string) {
  const [user] = await withPlatform((tx) =>
    tx.select({ email: users.email, name: users.name, verified: users.emailVerified }).from(users).where(eq(users.id, userId)),
  );
  if (!user) throw new PermanentJobError("Recipient user no longer exists");
  return user;
}

async function owners(ctx: JobContext) {
  return ctx.withTenant(async (tx) => {
    const [org] = await tx.select({ name: organizations.name }).from(organizations);
    const recipients = await tx
      .select({ userId: users.id, email: users.email })
      .from(organizationMembers)
      .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(roles.key, "owner"));
    if (!org) throw new PermanentJobError("Organization not found");
    return { organizationName: org.name, recipients };
  });
}

/** Who receives what, resolved from records at send time. */
async function deliveries(payload: ParsedPayload, ctx: JobContext): Promise<Delivery[]> {
  const id = ctx.job.id;
  switch (payload.template) {
    case "verify-email": {
      const user = await userRecipient(payload.userId);
      if (user.verified) return []; // already verified: nothing to send
      return [{ to: user.email, key: id, template: "verify-email", props: { name: user.name, url: payload.url } }];
    }
    case "reset-password": {
      const user = await userRecipient(payload.userId);
      const props = { name: user.name, url: payload.url, expiresInMinutes: payload.expiresInMinutes };
      return [{ to: user.email, key: id, template: "reset-password", props }];
    }
    case "password-changed": {
      const user = await userRecipient(payload.userId);
      const props = { name: user.name, email: user.email, changedAt: new Date(payload.changedAt), url: payload.url };
      return [{ to: user.email, key: id, template: "password-changed", props }];
    }
    case "organization-invitation": {
      if (!ctx.orgId) throw new PermanentJobError("An invitation email must be queued inside its organization's transaction");
      const [invitation] = await ctx.withTenant((tx) =>
        tx
          .select({
            email: organizationInvitations.email,
            expiresAt: organizationInvitations.expiresAt,
            acceptedAt: organizationInvitations.acceptedAt,
            revokedAt: organizationInvitations.revokedAt,
            organizationName: organizations.name,
            roleName: roles.name,
            inviterName: users.name,
          })
          .from(organizationInvitations)
          .innerJoin(organizations, eq(organizations.id, organizationInvitations.organizationId))
          .innerJoin(roles, eq(roles.id, organizationInvitations.roleId))
          .leftJoin(users, eq(users.id, organizationInvitations.invitedBy))
          .where(eq(organizationInvitations.id, payload.invitationId)),
      );
      // RLS hides other organizations' invitations: a job can never email another tenant's invitee.
      if (!invitation) throw new PermanentJobError("Invitation not found in this organization");
      if (invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= new Date()) return [];
      return [
        {
          to: invitation.email,
          key: id,
          template: "organization-invitation",
          props: {
            inviterName: invitation.inviterName || "A teammate",
            organizationName: invitation.organizationName,
            roleName: invitation.roleName,
            url: payload.url,
            expiresAt: invitation.expiresAt,
          },
        },
      ];
    }
    case "trial-ending":
    case "payment-failed": {
      const { organizationName, recipients } = await owners(ctx);
      return recipients.map((r) => ({
        to: r.email,
        key: `${id}:${r.userId}`,
        ...(payload.template === "trial-ending"
          ? { template: "trial-ending" as const, props: { organizationName, trialEndsAt: new Date(payload.trialEndsAt), url: payload.url } }
          : { template: "payment-failed" as const, props: { organizationName, url: payload.url } }),
      }));
    }
  }
}

export const emailSend = defineJob({
  type: "email.send",
  scope: "inherit",
  payload: emailPayload,
  maxAttempts: 8, // ≈ 2 h of retries, well inside Resend's 24 h idempotency window
  backoff: { baseSeconds: 60, maxSeconds: 3_600 },
  redactOnFinish: (payload) => ({ ...(payload as object), url: "[redacted]" }),
  run: async (payload, ctx) => {
    if (!isAppLink(payload.url)) throw new PermanentJobError("Email link does not point at the app origin");
    const list = await deliveries(payload, ctx);
    if (!list.length) {
      ctx.log.info("email skipped: nothing to send", { template: payload.template, jobId: ctx.job.id });
      return;
    }
    for (const delivery of list) {
      const rendered = await renderEmail(delivery.template, delivery.props as never);
      try {
        const provider = getEmailProvider();
        const result = await provider.send(
          { to: delivery.to, ...rendered, tags: { template: delivery.template } },
          { idempotencyKey: delivery.key },
        );
        ctx.log.info("email sent", {
          template: delivery.template,
          jobId: ctx.job.id,
          provider: provider.name,
          providerMessageId: result.providerMessageId,
        });
      } catch (err) {
        if (err instanceof EmailConfigError) {
          // Fixable by configuration: explain loudly now, keep retrying so the email still goes out once fixed.
          reportError(err, { module: "email" }, { jobId: ctx.job.id, template: delivery.template });
          throw err;
        }
        if (err instanceof EmailProviderError && !err.retryable) throw new PermanentJobError(err.message, { cause: err });
        throw err; // transient: the runner retries with backoff
      }
    }
  },
});

/**
 * Queue an email inside the caller's transaction. Inside withTenant() the job
 * carries that organization. Throws only for programming errors (an invalid
 * payload or a link off the app origin), never for delivery problems. After
 * the transaction commits, adapters call `kickEmail()` for low latency.
 */
export async function queueEmail(tx: Tx, payload: EmailPayload, options?: EnqueueOptions) {
  if (!isAppLink(payload.url)) throw new Error("Email links must point at the app origin (APP_ORIGIN)");
  return enqueue(tx, emailSend, payload as never, options);
}

/** Best effort: deliver queued emails right after the response (the cron runner is the guarantee). */
export function kickEmail() {
  kickJobs([emailSend]);
}

/** Queue outside a business transaction (e.g. Better Auth callbacks), then kick. */
export async function sendEmailSoon(payload: EmailPayload) {
  const result = await withPlatform((tx) => queueEmail(tx, payload));
  kickEmail();
  return result;
}
