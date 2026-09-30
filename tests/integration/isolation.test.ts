import pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { getPool } from "@/platform/db/client";
import { createTenantGraph } from "../fixtures/factories";
import { auditRlsCoverage } from "../isolation/coverage";
import { tenantReads } from "../isolation/tenant-reads";

/**
 * The tenant-isolation suite (M1-6, v1-build-plan §23). Stop-ship if red.
 *  1. Catalog: every table classified; tenant tables have RLS enabled + forced.
 *  2. Reads: every registered tenant read, run as A, returns only A's rows,
 *     while B's data sits in the same database.
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
