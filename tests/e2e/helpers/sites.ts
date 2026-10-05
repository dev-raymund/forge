import { randomBytes } from "node:crypto";
import pg from "pg";
import { uuidv7 } from "uuidv7";

/**
 * Seeds tenant sites for E2E the way the app would: as forge_app through the
 * pooler, inside a transaction carrying the tenant context (RLS WITH CHECK).
 * Plain SQL: Playwright can't load the app's server-only modules.
 */
const url = process.env.DATABASE_URL ?? "postgres://forge_app:forge_app@localhost:6432/forge";

export async function inTenant<T>(orgId: string, work: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.org_id', $1, true)", [orgId]);
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    await client.end();
  }
}

/** `address` is the site's platform address: the public site lives at `/s/{address}` (ADR 0006). */
export type SeededSite = { orgId: string; siteId: string; address: string; name: string };

export async function seedSite(label: string, tagline: string): Promise<SeededSite> {
  const orgId = uuidv7();
  const siteId = uuidv7();
  const slug = `${label}-${randomBytes(3).toString("hex")}`;
  await inTenant(orgId, async (c) => {
    await c.query("insert into organizations (id, name, slug) values ($1, $2, $3)", [orgId, `Org ${slug}`, `org-${slug}`]);
    await c.query("insert into sites (id, organization_id, name, slug) values ($1, $2, $3, $4)", [siteId, orgId, `Site ${label}`, slug]);
    await c.query("insert into site_settings (site_id, organization_id, general) values ($1, $2, $3)", [
      siteId, orgId, JSON.stringify({ tagline }),
    ]);
    await c.query(
      "insert into domains (id, organization_id, site_id, hostname, kind, is_primary, status) values ($1, $2, $3, $4, 'subdomain', true, 'active')",
      [uuidv7(), orgId, siteId, slug],
    );
  });
  return { orgId, siteId, address: slug, name: `Site ${label}` };
}

/** A write that bypasses the app, so no cache tag is invalidated. */
export async function setTaglineWithoutInvalidation(site: SeededSite, tagline: string) {
  await inTenant(site.orgId, (c) =>
    c.query("update site_settings set general = general || jsonb_build_object('tagline', $1::text) where site_id = $2", [
      tagline, site.siteId,
    ]),
  );
}

/** A user row (identity table: no tenant context needed), e.g. an email recipient. */
export async function seedUser(name = "E2E User"): Promise<{ id: string; email: string }> {
  const id = uuidv7();
  const email = `e2e-${randomBytes(4).toString("hex")}@example.test`;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("insert into users (id, name, email, email_verified) values ($1, $2, $3, false)", [id, name, email]);
  } finally {
    await client.end();
  }
  return { id, email };
}

/**
 * Makes an existing user (by email) a member of an organization, the way
 * accepting an invitation will (M3-4): inside the organization's own context.
 * For someone who is already a member, it changes their role.
 */
export async function addMember(orgId: string, email: string, role: "owner" | "admin" | "editor" | "author" | "viewer" = "owner") {
  await inTenant(orgId, (c) =>
    c.query(
      `insert into organization_members (id, organization_id, user_id, role_id)
       select $1, $2, u.id, r.id from users u, roles r where u.email = $3 and r.key = $4 and r.organization_id is null
       on conflict (organization_id, user_id) do update set role_id = excluded.role_id`,
      [uuidv7(), orgId, email, role],
    ),
  );
}

