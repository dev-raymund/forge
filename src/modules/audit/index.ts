import "server-only";
import { withPlatform } from "@/platform/db/tenant";
import { auditLogs } from "./schema";

/**
 * Public server API of the audit module (D-30, ADR 0010).
 *
 * Two kinds of record, in one table:
 *
 *  - Tenant activity: `record(tx, entry)` (./record.ts), written inside the
 *    transaction of the change it describes. `queryActivity(tx, …)` reads it
 *    for the organization's activity page.
 *  - Platform events: `recordPlatformEvent()` below. Things a user does to
 *    their own account (log in, log out, change the password). They belong to
 *    no organization, no tenant can read them, and they are written after
 *    Better Auth's own queries, so not in their transaction (ADR 0004).
 */
export { record } from "./record";
export type { AuditRequest } from "./record";
export { queryActivity } from "./activity";
export type { ActivityFilters, ActivityItem, ActivityPage } from "./activity";
export { AUDIT_ACTIONS, AUDIT_EVENTS, AuditEventError, describeEvent, eventLabel, isAuditAction } from "./events";
export type { AuditAction, AuditEntry } from "./events";
export { ACTIVITY_PAGE_SIZE, activityHref, hasFilters, parseActivityQuery } from "./activity-query";
export type { ActivityQuery } from "./activity-query";
export { ActivityView } from "./ui/activity-view";

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
