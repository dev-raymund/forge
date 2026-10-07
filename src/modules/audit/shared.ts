/**
 * Client-safe exports of the audit module: the event vocabulary, an event as a
 * sentence, and the activity page's URL parameters. No database access.
 */
export { AUDIT_ACTIONS, AUDIT_EVENTS, describeEvent, eventLabel, isAuditAction } from "./events";
export type { AuditAction, AuditEntry, AuditResourceType } from "./events";
export { ACTIVITY_PAGE_SIZE, activityHref, hasFilters, parseActivityQuery } from "./activity-query";
export type { ActivityQuery } from "./activity-query";
