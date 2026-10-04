import { sql } from "drizzle-orm";
import { listOrganizations } from "@/modules/tenancy";
import { tablesOfClass, type TableName } from "@/platform/db/table-classes";
import { withTenant, withUser } from "@/platform/db/tenant";

/**
 * Registry of tenant-scoped READS for the isolation suite (M1-6).
 *
 * Each entry reads under a tenant context and returns the organization id of
 * every row it produced. The suite runs every entry as tenant A against a
 * database that also holds tenant B, and fails if any row belongs to B.
 *
 * It starts with one full-table read per tenant/membership table — the
 * "WHERE clause omitted" case. As repositories and queries land (M3 onward),
 * register their read functions here so the same check covers them.
 */
export type TenantCtx = { orgId: string; userId: string; siteId: string };
export type TenantRead = { name: string; read: (ctx: TenantCtx) => Promise<string[]> };

const fullTableRead = (table: TableName): TenantRead => ({
  name: `table ${table} (no WHERE clause)`,
  read: (ctx) =>
    withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
      const column = table === "organizations" ? "id" : "organization_id";
      const res = await tx.execute(sql`select ${sql.identifier(column)} as org from ${sql.identifier(table)}`);
      return (res.rows as { org: string }[]).map((r) => r.org);
    }),
});

export const tenantReads: TenantRead[] = [
  ...[...tablesOfClass("tenant"), ...tablesOfClass("membership")].map(fullTableRead),
  // Repository/query reads are registered below as they are implemented, e.g.
  // { name: "content.queries.listEntries", read: (ctx) => listEntries(ctx).then(rows => rows.map(r => r.organizationId)) },

  // M3-1: what a user sees before any organization is chosen.
  {
    name: "tenancy.listOrganizations (user context, no organization chosen)",
    read: (ctx) =>
      listOrganizations({ kind: "user", userId: ctx.userId, sessionId: ctx.userId, emailVerified: true }).then((rows) => rows.map((r) => r.id)),
  },
  ...(["organizations", "organization_members"] as const).map((table): TenantRead => ({
    name: `table ${table} under a user-only context (no WHERE clause)`,
    read: (ctx) =>
      withUser(ctx.userId, async (tx) => {
        const column = table === "organizations" ? "id" : "organization_id";
        const res = await tx.execute(sql`select ${sql.identifier(column)} as org from ${sql.identifier(table)}`);
        return (res.rows as { org: string }[]).map((r) => r.org);
      }),
  })),
];
