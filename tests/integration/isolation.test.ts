import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/modules/auth/shared";
import { parseActivityQuery } from "@/modules/audit";
import { listActivity, resolveOrgContext } from "@/modules/tenancy";
import { getPool } from "@/platform/db/client";
import { withTenant } from "@/platform/db/tenant";
import { isAppError } from "@/platform/errors";
import { createTenantGraph, createUser } from "../fixtures/factories";
import { addUser } from "../fixtures/tenants";
import { auditRlsCoverage } from "../isolation/coverage";
import { contextBoundOperations, tenantForms, tenantOperations, tenantPolicyChecks, type Caller, type Foreign } from "../isolation/tenant-operations";
import { tenantReads } from "../isolation/tenant-reads";

/**
 * The tenant-isolation suite (M1-6, v1-build-plan §23). Stop-ship if red.
 *  1. Catalog: every table classified; tenant tables have RLS enabled + forced.
 *  2. Reads: every registered tenant read, run as A, returns only A's rows,
 *     while B's data sits in the same database.
 *  3. Operations: every registered operation, run as A with B's identifiers,
 *     answers NotFound and leaves B exactly as it was.
 *  4. The same operations, run by a member of A who may manage nothing (M3-2):
 *     whatever they are told about B's identifiers, they are told the same
 *     about identifiers that do not exist, and B is exactly as it was.
 *  5. Policies handed a resource of B allow nothing, even to the user who made it.
 *  6. The form submissions behind the Server Actions (M3-3), given B's slug or
 *     B's member: refused as NotFound, no redirect, B exactly as it was.
 *  7. The activity log (M3-5): read as A it holds A's events only, whatever
 *     filter names something of B's; and B's own log is among the rows that
 *     must not change in any check above.
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

// A registered form may queue an email (an invitation). Leave the worker's queue as we found it: other suites count the jobs they run.
afterAll(async () => {
  await getPool().query("delete from jobs where type = 'email.send'");
});

describe("registered operations given another tenant's identifiers answer NotFound", () => {
  let caller: Caller;
  /** A member of A with the least a member can have: a Viewer. */
  let bystander: Caller;
  let foreign: Foreign;
  /** Identifiers of the same shapes that belong to nobody. */
  let nowhere: Foreign;
  let aOrgId: string;

  /** Everything an organization owns in the tenancy tables, as one digest: any change to any row changes it. */
  // The activity log is in it: nothing done from A may add a line to B's record, any more than change B's rows.
  // So are B's site addresses (M4-1): `domains` is a platform table, without RLS, so this is its only witness.
  const TENANCY_TABLES = ["organizations", "organization_members", "organization_invitations", "subscriptions", "sites", "site_settings", "domains", "audit_logs"];
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
    foreign = {
      orgId: B.org.id, orgSlug: B.org.slug, siteId: B.site.id, siteSlug: B.site.slug, memberId: memberOfB.rows[0]!.id, userId: B.user.id, invitationId: B.invitation.id,
    };

    const viewer = await addUser(A.org, await createUser(), "viewer");
    bystander = { actor: viewer.actor, ctx: await resolveOrgContext(viewer.actor, A.org.slug), orgSlug: A.org.slug };
    const tail = randomBytes(4).toString("hex");
    nowhere = { orgId: uuidv7(), orgSlug: `nobody-${tail}`, siteId: uuidv7(), siteSlug: `nothing-${tail}`, memberId: uuidv7(), userId: uuidv7(), invitationId: uuidv7() };
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

  it.each(tenantForms.map((op) => [op.name, op] as const))("%s", async (_name, submission) => {
    const before = await fingerprintOf(foreign.orgId);
    const outcome = await submission.run(caller, foreign);
    expect(outcome.refused).toBe("NotFound");
    expect(outcome.state.status).toBe("error");
    expect(outcome.redirectTo, "a refused form sends the browser nowhere").toBeUndefined();
    expect(outcome.revalidate).toBeUndefined();
    // What the server adds to the answer says nothing of B. (`values` is the caller's own input, handed back to refill the form.)
    const said = JSON.stringify({ message: outcome.state.message, fieldErrors: outcome.state.fieldErrors });
    for (const secret of [foreign.orgId, foreign.orgSlug, foreign.memberId, foreign.userId]) expect(said).not.toContain(secret);
    expect(await fingerprintOf(foreign.orgId), "organization B changed").toBe(before);
  });

  describe("asked by a member of A who may manage nothing", () => {
    const answerOf = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        if (isAppError(error)) return { kind: error.kind, message: error.message };
        throw error;
      }
      throw new Error("expected the operation to be refused");
    };

    it("the bystander is a Viewer, and the identifiers that belong to nobody really do", async () => {
      expect(bystander.ctx.membership.role).toBe("viewer");
      expect(bystander.ctx.org.id).toBe(aOrgId);
      expect(bystander.ctx.permissions.list).toEqual(["entries.page.read", "entries.post.read"]);
      await expect(resolveOrgContext(caller.actor, nowhere.orgSlug)).rejects.toMatchObject({ kind: "NotFound" });
    });

    it.each(tenantOperations.map((op) => [op.name, op] as const))("%s: the same answer as for something that does not exist", async (_name, operation) => {
      const before = await fingerprintOf(foreign.orgId);
      const aboutB = await answerOf(() => operation.run(bystander, foreign));
      const aboutNothing = await answerOf(() => operation.run(bystander, nowhere));
      expect(aboutB).toEqual(aboutNothing);
      expect(["NotFound", "Forbidden"]).toContain(aboutB.kind);
      expect(await fingerprintOf(foreign.orgId), "organization B changed").toBe(before);
    });

    it.each(tenantForms.map((op) => [op.name, op] as const))("%s: the same answer as for something that does not exist", async (_name, submission) => {
      const before = await fingerprintOf(foreign.orgId);
      const [aboutB, aboutNothing] = [await submission.run(bystander, foreign), await submission.run(bystander, nowhere)];
      expect({ refused: aboutB.refused, message: aboutB.state.message, fieldErrors: aboutB.state.fieldErrors }).toEqual({
        refused: aboutNothing.refused, message: aboutNothing.state.message, fieldErrors: aboutNothing.state.fieldErrors,
      });
      expect(["NotFound", "Forbidden"]).toContain(aboutB.refused);
      expect(aboutB.redirectTo).toBeUndefined();
      expect(await fingerprintOf(foreign.orgId), "organization B changed").toBe(before);
    });
  });

  describe("the activity log, asked about another tenant", () => {
    const eventsOf = (orgId: string) =>
      withTenant({ orgId }, async (tx) => (await tx.execute<{ id: string }>(sql`select id from audit_logs where organization_id = ${orgId}`)).rows.map((row) => row.id));

    it("as A, every filter that names something of B's shows none of B's events, and B's log is unchanged", async () => {
      const before = await fingerprintOf(foreign.orgId);
      const [mine, theirs] = [new Set(await eventsOf(aOrgId)), await eventsOf(foreign.orgId)];
      expect(theirs.length, "the fixtures give B events to leak").toBeGreaterThan(0);

      const queries = [
        {},
        { member: foreign.memberId },
        { site: foreign.siteId },
        { member: foreign.userId },
        { member: foreign.orgId },
        { member: foreign.memberId, site: foreign.siteId },
        // Things a query string could carry that are not filters at all.
        { organizationId: foreign.orgId, orgSlug: foreign.orgSlug, org: foreign.orgId } as Record<string, string>,
      ];
      for (const query of queries) {
        const page = await listActivity(caller.ctx, parseActivityQuery(query));
        for (const item of page.items) {
          expect(mine.has(item.id), JSON.stringify(query)).toBe(true);
          expect(theirs).not.toContain(item.id);
        }
        expect(JSON.stringify(page)).not.toContain(foreign.orgId);
      }
      // Filters that name B's member or site match nothing in A, rather than falling back to everything.
      expect((await listActivity(caller.ctx, { member: foreign.memberId })).items).toEqual([]);
      expect((await listActivity(caller.ctx, { site: foreign.siteId })).items).toEqual([]);
      expect((await listActivity(caller.ctx)).items.length).toBeGreaterThan(0);
      expect(await fingerprintOf(foreign.orgId), "organization B changed").toBe(before);
    });

    it("a member of A who may not read the log is refused, whatever they ask about", async () => {
      for (const query of [{}, { member: foreign.memberId }, { site: foreign.siteId }]) {
        await expect(listActivity(bystander.ctx, query)).rejects.toMatchObject({ name: "AppError", kind: "Forbidden" });
      }
    });

    it("B's slug gives A no context to read B's log with", async () => {
      await expect(resolveOrgContext(caller.actor, foreign.orgSlug)).rejects.toMatchObject({ kind: "NotFound" });
      await expect(resolveOrgContext(bystander.actor, foreign.orgSlug)).rejects.toMatchObject({ kind: "NotFound" });
    });
  });

  describe("policies handed a resource of another tenant", () => {
    it.each(tenantPolicyChecks.map((check) => [check.name, check] as const))("%s allows nothing", async (_name, check) => {
      for (const who of [caller, bystander]) {
        // The worst case for an ownership rule: B's resource, recorded as made by this very user.
        expect(check.run(who.ctx, { organizationId: foreign.orgId, ownerId: who.ctx.actor.userId }), who.ctx.membership.role).toEqual([]);
        expect(check.run(who.ctx, { organizationId: nowhere.orgId, ownerId: who.ctx.actor.userId })).toEqual([]);
      }
      // Not passing by refusing everything: the same check on A's own resource allows A's Owner something.
      expect(check.run(caller.ctx, { organizationId: aOrgId, ownerId: caller.ctx.actor.userId }).length).toBeGreaterThan(0);
    });
  });
});

