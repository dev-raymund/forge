import { sql } from "drizzle-orm";
import { listSites } from "@/modules/sites";
import { listActivity, listOrganizations, resolveOrgContext } from "@/modules/tenancy";
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
  // M3-5: the activity log as its page reads it. Each event it returns is looked up again for the organization it belongs to.
  {
    name: "tenancy.listActivity (the organization's activity page)",
    read: async (ctx) => {
      const actor = { kind: "user", userId: ctx.userId, sessionId: ctx.userId, emailVerified: true } as const;
      const [org] = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => (await tx.execute<{ slug: string }>(sql`select slug from organizations where id = ${ctx.orgId}`)).rows);
      const page = await listActivity(await resolveOrgContext(actor, org!.slug));
      // Read without any tenant filter of its own: whatever organization each returned event really belongs to.
      const owners = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
        const res = await tx.execute<{ id: string; org: string }>(sql`select id, organization_id as org from audit_logs`);
        return new Map(res.rows.map((row) => [row.id, row.org]));
      });
      // An event the organization's own context cannot see would not be its own: name it, so the suite fails.
      return page.items.map((item) => owners.get(item.id) ?? `not-visible-to-${ctx.orgId}`);
    },
  },
  // M4-1: the organization's sites page. Each site it lists, with the address joined from the platform table, is looked up again.
  {
    name: "sites.listSites (the organization's sites page)",
    read: async (ctx) => {
      const actor = { kind: "user", userId: ctx.userId, sessionId: ctx.userId, emailVerified: true } as const;
      const [org] = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => (await tx.execute<{ slug: string }>(sql`select slug from organizations where id = ${ctx.orgId}`)).rows);
      const sites = await listSites(await resolveOrgContext(actor, org!.slug));
      // Both halves of each line: the site, and the address shown with it (read from `domains`, which has no RLS).
      const owners = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
        const res = await tx.execute<{ id: string; org: string; hostname: string | null; address_org: string | null }>(
          sql`select s.id, s.organization_id as org, d.hostname, d.organization_id as address_org from sites s left join domains d on d.site_id = s.id and d.kind = 'subdomain'`,
        );
        return new Map(res.rows.map((row) => [row.id, row]));
      });
      return sites.flatMap((site) => {
        const owner = owners.get(site.id);
        if (!owner) return [`not-visible-to-${ctx.orgId}`];
        return site.address === null ? [owner.org] : [owner.org, owner.hostname === site.address ? (owner.address_org ?? "none") : "address-mismatch"];
      });
    },
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
