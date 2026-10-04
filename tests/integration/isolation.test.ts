import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/modules/auth/shared";
import { resolveOrgContext } from "@/modules/tenancy";
import { getPool } from "@/platform/db/client";
import { withTenant } from "@/platform/db/tenant";
import { createTenantGraph } from "../fixtures/factories";
import { auditRlsCoverage } from "../isolation/coverage";
import { contextBoundOperations, tenantOperations, type Caller, type Foreign } from "../isolation/tenant-operations";
import { tenantReads } from "../isolation/tenant-reads";

/**
 * The tenant-isolation suite (M1-6, v1-build-plan §23). Stop-ship if red.
 *  1. Catalog: every table classified; tenant tables have RLS enabled + forced.
 *  2. Reads: every registered tenant read, run as A, returns only A's rows,
 *     while B's data sits in the same database.
 *  3. Operations: every registered operation, run as A with B's identifiers,
 *     answers NotFound and leaves B exactly as it was.
 */

describe("catalog coverage", () => {
  it("the live schema has no isolation gaps", async () => {
    expect(await auditRlsCoverage(getPool())).toEqual([]);
  });

  it("detects an unprotected tenant table (the check itself works)", async () => {
    // Created as the schema owner on a direct connection, like a careless migration would.
    const owner = new pg.Client({ connectionString: process.env.TEST_WORKER_OWNER_URL });
    await owner.connect();
    try {
      await owner.query("create table isolation_probe (id uuid primary key, organization_id uuid not null)");
      const problems = await auditRlsCoverage(owner);
      expect(problems).toContain(
        "isolation_probe: has organization_id but is not classified — an unprotected tenant table?",
      );
    } finally {
      await owner.query("drop table if exists isolation_probe");
      await owner.end();
    }
  });
});

describe("registered tenant reads return only the caller's rows", () => {
  let a: { orgId: string; userId: string; siteId: string };
  let bOrgId: string;

  beforeAll(async () => {
    const [A, B] = await Promise.all([createTenantGraph(), createTenantGraph()]);
    a = { orgId: A.org.id, userId: A.user.id, siteId: A.site.id };
    bOrgId = B.org.id;
  });

  it.each(tenantReads.map((r) => [r.name, r] as const))("%s", async (_name, entry) => {
    const orgIds = await entry.read(a);
    expect(orgIds.length, "fixtures should produce rows for tenant A").toBeGreaterThan(0);
    expect(orgIds).not.toContain(bOrgId);
    expect(new Set(orgIds)).toEqual(new Set([a.orgId]));
  });
});

describe("registered operations given another tenant's identifiers answer NotFound", () => {
  let caller: Caller;
  let foreign: Foreign;
  let aOrgId: string;

  /** Everything an organization owns in the tenancy tables, as one digest: any change to any row changes it. */
  const TENANCY_TABLES = ["organizations", "organization_members", "organization_invitations", "subscriptions", "sites", "site_settings"];
  const fingerprintOf = (orgId: string) =>
    withTenant({ orgId }, async (tx) => {
      const hash = createHash("sha256");
      for (const table of TENANCY_TABLES) {
        const column = sql.identifier(table === "organizations" ? "id" : "organization_id");
        const { rows } = await tx.execute<{ row: string }>(
          sql`select row_to_json(t)::text as row from ${sql.identifier(table)} t where ${column} = ${orgId} order by 1`,
        );
        hash.update(table).update(JSON.stringify(rows));
      }
      return hash.digest("hex");
    });

  beforeAll(async () => {
    const [A, B] = await Promise.all([createTenantGraph(), createTenantGraph()]);
    const actor: Actor = { kind: "user", userId: A.user.id, sessionId: A.user.id, emailVerified: true };
    caller = { actor, ctx: await resolveOrgContext(actor, A.org.slug), orgSlug: A.org.slug };
    aOrgId = A.org.id;
    const memberOfB = await withTenant({ orgId: B.org.id }, (tx) =>
      tx.execute<{ id: string }>(sql`select id from organization_members where organization_id = ${B.org.id} limit 1`),
    );
    foreign = { orgId: B.org.id, orgSlug: B.org.slug, siteId: B.site.id, siteSlug: B.site.slug, memberId: memberOfB.rows[0]!.id, userId: B.user.id };
  });

  it("has operations to check, and the fixtures are what the checks assume", async () => {
    expect(tenantOperations.length).toBeGreaterThan(0);
    expect(caller.ctx.membership.role).toBe("owner"); // so a refusal is never about permission
    expect(foreign.orgId).not.toBe(aOrgId);
    expect(foreign.memberId).toMatch(/^[0-9a-f-]{36}$/);

    // The digest is a real witness: it covers rows, and one changed column changes it.
    const before = await fingerprintOf(foreign.orgId);
    expect(before).not.toBe(await fingerprintOf(aOrgId));
    await withTenant({ orgId: foreign.orgId }, (tx) => tx.execute(sql`update sites set name = name || '!' where organization_id = ${foreign.orgId}`));
    const changed = await fingerprintOf(foreign.orgId);
    expect(changed).not.toBe(before);
    await withTenant({ orgId: foreign.orgId }, (tx) => tx.execute(sql`update sites set name = left(name, -1) where organization_id = ${foreign.orgId}`));
  });

  it.each(tenantOperations.map((op) => [op.name, op] as const))("%s", async (_name, operation) => {
    const before = await fingerprintOf(foreign.orgId);
    await expect(operation.run(caller, foreign)).rejects.toMatchObject({ name: "AppError", kind: "NotFound", message: "Not found." });
    expect(await fingerprintOf(foreign.orgId), "organization B changed").toBe(before);
  });

  it.each(contextBoundOperations.map((op) => [op.name, op] as const))("%s acts on the caller's own organization only", async (_name, operation) => {
    const before = await fingerprintOf(foreign.orgId);
    await expect(operation.run(caller, foreign)).resolves.toBeDefined();
    expect(await fingerprintOf(foreign.orgId), "organization B changed").toBe(before);
  });
});

