import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { uuidv7 } from "uuidv7";
import { beforeAll, describe, expect, it } from "vitest";
import * as t from "@/platform/db/schema";
import { TABLE_CLASSES, tablesOfClass, type TableName } from "@/platform/db/table-classes";
import { withPlatform, withTenant, withUser, type Tx } from "@/platform/db/tenant";
import { getPool } from "@/platform/db/client";
import { dbError, PG } from "../fixtures/db-error";
import { createMedia, createSite, createTenantGraph } from "../fixtures/factories";

/**
 * Spike S2 / M0-3 — RLS through the pooled connection (ADR 0001).
 *
 * Every query in this file runs as forge_app through PgBouncer in transaction
 * mode (DATABASE_URL → :6432), the same shape as Neon's pooled endpoint. The
 * central claim: organization A cannot read organization B even when a query
 * omits its WHERE clause entirely.
 */

type Graph = Awaited<ReturnType<typeof createTenantGraph>>;

const RLS_VIOLATION = { code: PG.insufficientPrivilege, message: expect.stringMatching(/row-level security/) };
const PERMISSION_DENIED = { code: PG.insufficientPrivilege, message: expect.stringMatching(/permission denied/) };
const fkViolation = (constraint: string) => ({ code: PG.foreignKeyViolation, constraint });
let A: Graph;
let B: Graph;

const tenantTables = [...tablesOfClass("tenant"), ...tablesOfClass("membership")];
const orgColumn = (table: TableName) => (table === "organizations" ? "id" : "organization_id");

async function orgIdsVisible(table: TableName, ctx?: { orgId: string; userId?: string }) {
  const query = sql`select ${sql.identifier(orgColumn(table))} as org from ${sql.identifier(table)}`;
  const run = async (tx: Tx) => {
    const res = await tx.execute(query);
    return (res.rows as { org: string | null }[]).map((r) => r.org);
  };
  return ctx ? withTenant(ctx, run) : withPlatform(run);
}

beforeAll(async () => {
  [A, B] = await Promise.all([createTenantGraph(), createTenantGraph()]);
});

describe("runtime role", () => {
  it("forge_app is not a superuser, cannot bypass RLS, and cannot inherit a role that can", async () => {
    const { rows } = await getPool().query<{ user: string; super: boolean; bypass: boolean; inherits_bypass: boolean }>(`
      select current_user as user, r.rolsuper as super, r.rolbypassrls as bypass,
             exists (select 1 from pg_roles x
                     where (x.rolsuper or x.rolbypassrls) and x.rolname <> current_user
                       and pg_has_role(current_user, x.oid, 'MEMBER')) as inherits_bypass
      from pg_roles r where r.rolname = current_user`);
    expect(rows[0]).toEqual({ user: "forge_app", super: false, bypass: false, inherits_bypass: false });
  });

  it("forge_app owns no tables, so FORCE is not what protects it — the policy is", async () => {
    const { rows } = await getPool().query(
      `select count(*)::int as n from pg_tables where schemaname = 'public' and tableowner = current_user`,
    );
    expect(rows[0].n).toBe(0);
  });

  it("forge_app cannot assume the lookup role", async () => {
    const error = await dbError(withPlatform((tx) => tx.execute(sql`set local role forge_lookup`)));
    expect(error).toMatchObject(PERMISSION_DENIED);
  });
});

describe("classification", () => {
  it("every table in the schema is classified, and nothing classified is missing", async () => {
    const { rows } = await getPool().query<{ name: string }>(
      `select tablename as name from pg_tables where schemaname = 'public' order by 1`,
    );
    expect(rows.map((r) => r.name).sort()).toEqual(Object.keys(TABLE_CLASSES).sort());
  });

  it("tenant and membership tables have RLS enabled AND forced; others have none", async () => {
    const { rows } = await getPool().query<{ name: string; rls: boolean; force: boolean }>(`
      select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as force
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'`);
    for (const row of rows) {
      const cls = TABLE_CLASSES[row.name as TableName];
      const protectedClass = cls === "tenant" || cls === "membership";
      expect({ table: row.name, rls: row.rls, force: row.force }).toEqual({
        table: row.name,
        rls: protectedClass,
        force: protectedClass,
      });
    }
  });

  it("every tenant table carries organization_id", async () => {
    const { rows } = await getPool().query<{ table_name: string }>(
      `select table_name from information_schema.columns where table_schema = 'public' and column_name = 'organization_id'`,
    );
    const withOrg = new Set(rows.map((r) => r.table_name));
    for (const table of tablesOfClass("tenant")) expect(withOrg.has(table), table).toBe(true);
  });
});

describe("isolation with the WHERE clause omitted", () => {
  it.each(tenantTables)("%s: tenant A sees only its own rows", async (table) => {
    const seen = await orgIdsVisible(table, { orgId: A.org.id, userId: A.user.id });
    expect(seen.length, `${table} should have fixture rows for A`).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([A.org.id]));
  });

  it.each(tenantTables)("%s: no tenant context means no rows at all", async (table) => {
    expect(await orgIdsVisible(table)).toEqual([]);
  });

  it("the same, via a raw pooled query outside any transaction", async () => {
    for (const table of tenantTables) {
      const { rows } = await getPool().query(`select 1 from "${table}"`);
      expect(rows, table).toEqual([]);
    }
  });

  it("a user-only context lists that user's organizations and nothing else", async () => {
    const result = await withUser(A.user.id, async (tx) => ({
      orgs: (await tx.execute(sql`select id from organizations`)).rows,
      sites: (await tx.execute(sql`select id from sites`)).rows,
      entries: (await tx.execute(sql`select id from entries`)).rows,
    }));
    expect(result).toEqual({ orgs: [{ id: A.org.id }], sites: [], entries: [] });
  });
});

describe("writes are checked too (WITH CHECK)", () => {
  it("cannot insert a row stamped with another organization", async () => {
    const error = await dbError(
      withTenant({ orgId: A.org.id }, (tx) =>
        tx.insert(t.sites).values({ organizationId: B.org.id, name: "hijack", slug: "hijack" })
      ),
    );
    expect(error).toMatchObject(RLS_VIOLATION);
  });

  it("cannot move an own row into another organization", async () => {
    const error = await dbError(
      withTenant({ orgId: A.org.id }, (tx) =>
        tx.execute(sql`update menus set organization_id = ${B.org.id} where id = ${A.menu.id}`)
      ),
    );
    expect(error).toMatchObject(RLS_VIOLATION);
  });

  it("updates and deletes aimed at another tenant's ids silently affect nothing", async () => {
    const affected = await withTenant({ orgId: A.org.id }, async (tx) => {
      const u = await tx.execute(sql`update entries set title = 'pwned' where id = ${B.entry.id}`);
      const d = await tx.execute(sql`delete from redirects where id = ${B.redirect.id}`);
      return [u.rowCount, d.rowCount];
    });
    expect(affected).toEqual([0, 0]);
    const title = await withTenant({ orgId: B.org.id }, async (tx) =>
      (await tx.execute(sql`select title from entries where id = ${B.entry.id}`)).rows[0],
    );
    expect(title).toEqual({ title: "Hello" });
  });
});

describe("composite foreign keys make cross-tenant references unrepresentable", () => {
  it("an entry cannot reference media from another site of the same organization", async () => {
    const otherSite = await createSite(A.org.id, A.user.id);
    const { media: otherMedia } = await createMedia({ orgId: A.org.id, siteId: otherSite.id, userId: A.user.id });
    const error = await dbError(
      withTenant({ orgId: A.org.id }, (tx) =>
        tx.execute(sql`update entries set featured_media_id = ${otherMedia.id} where id = ${A.entry.id}`)
      ),
    );
    expect(error).toMatchObject(fkViolation("entries_featured_media_fk"));
  });

  it("an entry cannot reference another organization's media, even by a known id", async () => {
    const error = await dbError(
      withTenant({ orgId: A.org.id }, (tx) =>
        tx.execute(sql`update entries set featured_media_id = ${B.media.id} where id = ${A.entry.id}`)
      ),
    );
    expect(error).toMatchObject(fkViolation("entries_featured_media_fk"));
  });

  it("a site-scoped row cannot claim a site of another organization", async () => {
    const error = await dbError(
      withTenant({ orgId: A.org.id }, (tx) =>
        tx.insert(t.menus).values({ organizationId: A.org.id, siteId: B.site.id, location: "footer" })
      ),
    );
    expect(error).toMatchObject(fkViolation("menus_site_fk"));
  });

  it("a published revision must belong to its own entry", async () => {
    const error = await dbError(
      withTenant({ orgId: B.org.id }, (tx) =>
        tx.execute(sql`update entries set published_revision_id = ${A.revision.id} where id = ${B.entry.id}`)
      ),
    );
    expect(error).toMatchObject(fkViolation("entries_published_revision_fk"));
  });
});

describe("tenant context never leaks across pooled connections", () => {
  it("interleaved A/B/no-context transactions each see exactly their own rows", async () => {
    const pattern = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? A : i % 3 === 1 ? B : null));
    const results = await Promise.all(
      pattern.map((g) =>
        g
          ? withTenant({ orgId: g.org.id }, async (tx) => ({
              expected: g.org.id,
              seen: (await tx.execute(sql`select distinct organization_id as org from entries`)).rows,
            }))
          : withPlatform(async (tx) => ({
              expected: null,
              seen: (await tx.execute(sql`select distinct organization_id as org from entries`)).rows,
            })),
      ),
    );
    for (const r of results) {
      expect(r.seen).toEqual(r.expected ? [{ org: r.expected }] : []);
    }
  });

  it("after a transaction-local set_config, the setting reads back as '' (not NULL) on that connection", async () => {
    // A direct (unpooled) connection pins one server session, making the
    // PgBouncer-reuse situation deterministic.
    const client = new pg.Client({ connectionString: process.env.TEST_WORKER_APP_DIRECT_URL });
    await client.connect();
    try {
      const before = await client.query(`select current_setting('app.org_id', true) as v`);
      await client.query("begin");
      await client.query(`select set_config('app.org_id', $1, true)`, [A.org.id]);
      await client.query("commit");
      const after = await client.query(`select current_setting('app.org_id', true) as v`);
      expect(before.rows[0].v).toBeNull();
      expect(after.rows[0].v).toBe(""); // the gotcha: '' — a bare ::uuid cast would error here
      await expect(client.query(`select ''::uuid`)).rejects.toThrow(/invalid input syntax for type uuid/);
      // …and because the policies go through nullif(), the session still sees nothing.
      const rows = await client.query(`select count(*)::int as n from entries`);
      expect(rows.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });
});

describe("token lookups (SECURITY DEFINER, owned by forge_lookup)", () => {
  it("resolve_api_key finds the key's tenant without any context, and returns only minimal columns", async () => {
    const hash = createHash("sha256").update(A.apiKeySecret).digest("hex");
    const rows = await withPlatform(async (tx) => (await tx.execute(sql`select * from resolve_api_key(${hash})`)).rows);
    expect(rows).toEqual([{ key_id: A.apiKey.id, organization_id: A.org.id, site_id: A.site.id, scope: "read" }]);
  });

  it("resolve_api_key ignores unknown and revoked keys", async () => {
    await withTenant({ orgId: B.org.id }, (tx) =>
      tx.execute(sql`update api_keys set revoked_at = now() where id = ${B.apiKey.id}`),
    );
    const revoked = createHash("sha256").update(B.apiKeySecret).digest("hex");
    const results = await withPlatform(async (tx) => [
      (await tx.execute(sql`select * from resolve_api_key(${revoked})`)).rows,
      (await tx.execute(sql`select * from resolve_api_key(${uuidv7()})`)).rows,
    ]);
    expect(results).toEqual([[], []]);
  });

  it("resolve_invitation finds an invitation by token hash only", async () => {
    const hash = createHash("sha256").update(A.invitationToken).digest("hex");
    const rows = await withPlatform(async (tx) => (await tx.execute(sql`select * from resolve_invitation(${hash})`)).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ invitation_id: A.invitation.id, organization_id: A.org.id });
  });
});

describe("append-only tables", () => {
  it("audit_logs rejects UPDATE and DELETE for the runtime role", async () => {
    const asA = (statement: ReturnType<typeof sql>) =>
      dbError(withTenant({ orgId: A.org.id }, (tx) => tx.execute(statement)));
    expect(await asA(sql`update audit_logs set action = 'x'`)).toMatchObject(PERMISSION_DENIED);
    expect(await asA(sql`delete from audit_logs`)).toMatchObject(PERMISSION_DENIED);
  });

  it("entry_revisions rejects UPDATE", async () => {
    const error = await dbError(
      withTenant({ orgId: A.org.id }, (tx) => tx.execute(sql`update entry_revisions set title = 'x'`)),
    );
    expect(error).toMatchObject(PERMISSION_DENIED);
  });

  it("platform events (no organization) can be written without a tenant context but never read by a tenant", async () => {
    await withPlatform((tx) =>
      tx.insert(t.auditLogs).values({ organizationId: null, actorType: "system", action: "auth.login" }),
    );
    const seen = await orgIdsVisible("audit_logs", { orgId: A.org.id });
    expect(seen.every((o) => o === A.org.id)).toBe(true);
  });
});
