import "server-only";
import { withPlatform } from "@/platform/db/tenant";
import { auditLogs } from "./schema";

/**
 * Public server API of the audit module.
 *
 * M2-4 needs only platform events: things a user does to their own account
 * (log in, log out, change the password), which belong to no organization.
 * `audit.record(tx, …)` for tenant mutations, written in the mutation's own
 * transaction, arrives with M3-5.
 */

export type PlatformAuditEvent = {
  /** Dotted, past tense where it reads naturally: `auth.login`, `auth.password_changed`. */
  action: string;
  /** The user who did it. */
  userId: string;
  /** A snapshot of who that was (the email address), because the log outlives the user row. */
  userLabel?: string;
  requestId?: string;
  ip?: string;
  /** Small, non-secret details. Never a password, a token or a session id. */
  metadata?: Record<string, unknown>;
};

/**
 * Appends a platform event: `organization_id` is NULL, so no tenant context
 * can ever read it (the table's policy), and `forge_app` can neither change
 * nor delete it (INSERT and SELECT only).
 */
export async function recordPlatformEvent(event: PlatformAuditEvent): Promise<void> {
  await withPlatform((tx) =>
    tx.insert(auditLogs).values({
      organizationId: null,
      siteId: null,
      actorType: "user",
      actorId: event.userId,
      actorLabel: event.userLabel ?? "",
      action: event.action,
      resourceType: "user",
      resourceId: event.userId,
      requestId: event.requestId ?? "",
      ip: event.ip ?? "",
      metadata: event.metadata ?? {},
    }),
  );
}
