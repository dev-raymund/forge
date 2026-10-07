import "server-only";
import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import type { TenantTx } from "@/platform/db";
// Another module's table (the actor's present name) comes from the schema barrel.
import { users } from "@/platform/db/schema";
import { ACTIVITY_PAGE_SIZE, dayRange, decodeCursor, encodeCursor, type ActivityQuery } from "./activity-query";
import { auditLogs } from "./schema";

/**
 * Reading an organization's activity (M3-5). The caller gives the transaction
 * (inside the organization, so RLS applies) and the organization's id, and
 * decides who may ask: the permission check is in the tenancy module's
 * `listActivity(ctx, …)`, which is what pages call.
 *
 * What is returned is what the activity page may show. The client address and
 * the request id stay in the table: they are stored for security work, and no
 * tenant-facing query selects them.
 */

export type ActivityItem = {
  id: string;
  action: string;
  /** Who did it: their name now, or the address recorded at the time if the account is gone. */
  actorName: string;
  resourceType: string;
  metadata: Record<string, unknown>;
  occurredAt: Date;
};

export type ActivityPage = { items: ActivityItem[]; /** Present when there are older events than these. */ nextCursor: string | null };

export type ActivityFilters = Pick<ActivityQuery, "action" | "site" | "from" | "to" | "before"> & {
  /** A user id. The page's `member` (a membership id) is resolved to this by the caller, inside the organization. */
  actorId?: string;
};

export async function queryActivity(tx: TenantTx, organizationId: string, filters: ActivityFilters = {}, limit = ACTIVITY_PAGE_SIZE): Promise<ActivityPage> {
  const size = Math.min(Math.max(Math.trunc(limit) || ACTIVITY_PAGE_SIZE, 1), 100);
  const range = dayRange(filters);
  const cursor = decodeCursor(filters.before);

  const conditions: SQL[] = [
    // Stated here as well as by RLS: this organization's rows, and so never a row that belongs to none (a login, a password change).
    eq(auditLogs.organizationId, organizationId),
  ];
  if (filters.action) conditions.push(eq(auditLogs.action, filters.action));
  if (filters.actorId) conditions.push(eq(auditLogs.actorId, filters.actorId));
  if (filters.site) conditions.push(eq(auditLogs.siteId, filters.site));
  if (range.from) conditions.push(gte(auditLogs.createdAt, range.from));
  if (range.before) conditions.push(lt(auditLogs.createdAt, range.before));
  // Keyset pagination: strictly older than the last event of the page before, by time and then id.
  if (cursor) {
    conditions.push(
      sql`(${auditLogs.createdAt}, ${auditLogs.id}) < (timestamptz 'epoch' + ${cursor.micros}::bigint * interval '1 microsecond', ${cursor.id}::uuid)`,
    );
  }

  const rows = await tx
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      actorLabel: auditLogs.actorLabel,
      actorName: users.name,
      resourceType: auditLogs.resourceType,
      metadata: auditLogs.metadata,
      occurredAt: auditLogs.createdAt,
      // The exact time, for the cursor: microseconds since the epoch, as text (a JavaScript number would round it).
      micros: sql<string>`(extract(epoch from ${auditLogs.createdAt}) * 1000000)::bigint::text`,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorId))
    .where(and(...conditions))
    // Newest first, as the index has it (`organization_id, created_at DESC NULLS LAST`); the id settles events of one instant.
    .orderBy(sql`${auditLogs.createdAt} desc nulls last`, desc(auditLogs.id))
    .limit(size + 1);

  const page = rows.slice(0, size);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      id: row.id,
      action: row.action,
      actorName: row.actorName ?? row.actorLabel,
      resourceType: row.resourceType,
      metadata: row.metadata ?? {},
      occurredAt: row.occurredAt,
    })),
    nextCursor: rows.length > size && last ? encodeCursor({ micros: last.micros, id: last.id }) : null,
  };
}
