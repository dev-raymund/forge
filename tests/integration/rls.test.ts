import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { uuidv7 } from "uuidv7";
import { beforeAll, describe, expect, it } from "vitest";
import * as t from "@/platform/db/schema";
import { tablesOfClass, type TableName } from "@/platform/db/table-classes";
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

describe("isolation with the WHERE clause omitted", () => {
  // "Tenant A sees only its own rows" for every table lives in isolation.test.ts
  // (the M1-6 suite), which also runs every registered repository read.

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

describe("the uploads.cleanup lookup (SECURITY DEFINER, owned by forge_lookup; M6-1)", () => {
  const lookup = (before: Date, limit = 1000) =>
    withPlatform(async (tx) => (await tx.execute(sql`select * from organizations_with_unfinished_uploads(${before.toISOString()}::timestamptz, ${limit})`)).rows);

  it("names the organizations with an upload not ready before the cutoff, and nothing else: organization ids only", async () => {
    // A's graph media is `ready`: A is not named. One pending upload of B's is.
    expect((await lookup(new Date(Date.now() + 3_600_000))).map((row) => row.organization_id)).not.toContain(A.org.id);
    const [pending] = await withTenant({ orgId: B.org.id }, (tx) =>
      tx
        .insert(t.mediaAssets)
        .values({
          organizationId: B.org.id, siteId: B.site.id, kind: "image", status: "pending", storageKey: `o/${B.org.id}/s/${B.site.id}/m/${uuidv7()}/v1/original/x.png`,
          originalFilename: "x.png", mimeType: "image/png", sizeBytes: 10, uploadedBy: B.user.id,
        })
        .returning(),
    );
    const later = await lookup(new Date(Date.now() + 3_600_000));
    expect(later).toContainEqual({ organization_id: B.org.id });
    expect(Object.keys(later[0]!)).toEqual(["organization_id"]);
    expect(await lookup(new Date(Date.now() - 3_600_000))).not.toContainEqual({ organization_id: B.org.id }); // too recent
    // Without the function, a context with no organization still sees no media rows at all.
    expect(await orgIdsVisible("media_assets")).toEqual([]);
    await withTenant({ orgId: B.org.id }, (tx) => tx.execute(sql`delete from media_assets where id = ${pending!.id}`));
  });
});

describe("the /media lookup (SECURITY DEFINER, owned by forge_lookup; M6-2)", () => {
  const lookup = (mediaId: string, key: string) =>
    withPlatform(async (tx) => (await tx.execute(sql`select * from public_media_object(${mediaId}::uuid, ${key})`)).rows);

  it("answers for a ready, untrashed item's variant or document file only, with its organization, site and type", async () => {
    const insert = (values: Partial<typeof t.mediaAssets.$inferInsert>) =>
      withTenant({ orgId: B.org.id }, async (tx) => {
        const id = uuidv7();
        const storageKey = `o/${B.org.id}/s/${B.site.id}/m/${id}/v1/original/x.${values.kind === "document" ? "pdf" : "jpg"}`;
        const variantKey = `o/${B.org.id}/s/${B.site.id}/m/${id}/v1/w800/x.webp`;
        await tx.insert(t.mediaAssets).values({
          id, organizationId: B.org.id, siteId: B.site.id, kind: "image", status: "ready", storageKey, originalFilename: "x", mimeType: values.kind === "document" ? "application/pdf" : "image/jpeg",
          sizeBytes: 10, uploadedBy: B.user.id, variants: [{ key: "w800", format: "webp", width: 800, height: 600, sizeBytes: 5, storageKey: variantKey }], ...values,
        });
        return { id, storageKey, variantKey };
      });
    const image = await insert({});
    expect(await lookup(image.id, image.variantKey)).toEqual([{ organization_id: B.org.id, site_id: B.site.id, content_type: "image/webp" }]);
    expect(await lookup(image.id, image.storageKey)).toEqual([]); // an image's original is never public
    expect(await lookup(image.id, image.variantKey.replace("w800", "w1600"))).toEqual([]);
    expect(await lookup(uuidv7(), image.variantKey)).toEqual([]); // the key must be this item's
    const document = await insert({ kind: "document", variants: [] });
    expect(await lookup(document.id, document.storageKey)).toEqual([{ organization_id: B.org.id, site_id: B.site.id, content_type: "application/pdf" }]);
    for (const hidden of [{ status: "pending" as const }, { status: "failed" as const }, { deletedAt: new Date() }]) {
      const row = await insert(hidden);
      expect(await lookup(row.id, row.variantKey), JSON.stringify(hidden)).toEqual([]);
    }
    // Without the function, a context with no organization still sees no media rows.
    expect(await orgIdsVisible("media_assets")).toEqual([]);
  });
});

describe("the trash.purge lookup (SECURITY DEFINER, owned by forge_lookup; M6-3)", () => {
  it("names the organizations with media trashed before the cutoff: organization ids only", async () => {
    const lookup = (before: Date) =>
      withPlatform(async (tx) => (await tx.execute(sql`select * from organizations_with_purgeable_media(${before.toISOString()}::timestamptz, 1000)`)).rows);
    // Nothing of B's has been in the trash 30 days yet (an earlier test here trashed one just now).
    expect(await lookup(new Date(Date.now() - 30 * 24 * 3_600_000))).not.toContainEqual({ organization_id: B.org.id });
    await withTenant({ orgId: B.org.id }, (tx) => tx.execute(sql`update media_assets set deleted_at = now() - interval '31 days' where id = ${B.media.id}`));
    try {
      const rows = await lookup(new Date(Date.now() - 30 * 24 * 3_600_000));
      expect(rows).toContainEqual({ organization_id: B.org.id });
      expect(Object.keys(rows[0]!)).toEqual(["organization_id"]);
      expect(await lookup(new Date(Date.now() - 32 * 24 * 3_600_000))).not.toContainEqual({ organization_id: B.org.id });
      expect(await orgIdsVisible("media_assets")).toEqual([]);
    } finally {
      await withTenant({ orgId: B.org.id }, (tx) => tx.execute(sql`update media_assets set deleted_at = null where id = ${B.media.id}`));
    }
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
