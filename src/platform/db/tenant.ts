import "server-only";
import { sql } from "drizzle-orm";
import { getDb, type Database } from "./client";

/**
 * Tenant transactions (D-04, v1-build-plan §4.3).
 *
 * Every tenant query runs inside a transaction that first sets the tenant
 * context with set_config(…, is_local = true). Transaction-local settings are
 * the only kind that is safe behind PgBouncer in transaction mode (Neon's
 * pooled endpoint): a session-level SET would stay on the server connection
 * and leak into whichever client borrows it next.
 *
 * RLS policies read the context through app_current_org_id() /
 * app_current_user_id(), which map both "never set" (NULL) and "set by an
 * earlier transaction on this pooled connection" ('') to NULL — so a query
 * without context sees no tenant rows at all. See ADR 0001.
 */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type TenantTx = Tx & { readonly __tenant: true };
export type UserTx = Tx & { readonly __user: true };
export type PlatformTx = Tx & { readonly __platform: true };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw new Error(`${label} must be a UUID`);
}

/**
 * Run `work` inside a transaction scoped to one organization.
 * The only way application code touches tenant tables.
 */
export async function withTenant<T>(
  ctx: { orgId: string; userId?: string | null },
  work: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  assertUuid(ctx.orgId, "orgId");
  if (ctx.userId) assertUuid(ctx.userId, "userId");
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.org_id', ${ctx.orgId}, true), set_config('app.user_id', ${ctx.userId ?? ""}, true)`,
    );
    return work(tx as TenantTx);
  });
}

/**
 * Run `work` with only a user context: lists the organizations a user belongs
 * to (org switcher, membership resolution) before any organization is chosen.
 * Tenant tables stay invisible; organizations/organization_members expose the
 * user's own memberships only.
 */
export async function withUser<T>(userId: string, work: (tx: UserTx) => Promise<T>): Promise<T> {
  assertUuid(userId, "userId");
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return work(tx as UserTx);
  });
}

/**
 * Run `work` without tenant context, for platform-class tables that are not
 * tenant-owned (domains, jobs) and identity tables (users, auth_*). RLS still
 * applies, so tenant tables return nothing here.
 */
export async function withPlatform<T>(work: (tx: PlatformTx) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => work(tx as PlatformTx));
}
