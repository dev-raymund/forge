import { randomBytes } from "node:crypto";
import pg from "pg";
import { uuidv7 } from "uuidv7";
import { inTenant } from "./sites";

/**
 * Organizations for E2E (M3-3), seeded and inspected the way the app would do
 * it: as forge_app through the pooler, with the tenant or user context that
 * RLS requires. Plain SQL: Playwright can't load the app's server-only modules.
 */
const url = process.env.DATABASE_URL ?? "postgres://forge_app:forge_app@localhost:6432/forge";

export type Role = "owner" | "admin" | "editor" | "author" | "viewer";
export type SeededOrganization = { id: string; slug: string; name: string };

/** An organization with no members yet. Add them with `addMember` (./sites.ts). */
export async function seedOrganization(label: string): Promise<SeededOrganization> {
  const id = uuidv7();
  const tail = randomBytes(3).toString("hex");
  const organization = { id, slug: `${label}-${tail}`, name: `${label[0]!.toUpperCase()}${label.slice(1)} ${tail}` };
  await inTenant(id, async (c) => {
    await c.query("insert into organizations (id, name, slug) values ($1, $2, $3)", [id, organization.name, organization.slug]);
    await c.query("insert into subscriptions (organization_id, plan_key, status) values ($1, 'pro', 'trialing')", [id]);
  });
  return organization;
}

/** What staff do from their console (M12-1); here only to see that the app honours it. */
export async function setOrganizationStatus(orgId: string, status: "active" | "suspended") {
  await inTenant(orgId, (c) => c.query("update organizations set status = $2 where id = $1", [orgId, status]));
}

export async function removeMember(orgId: string, email: string) {
  await inTenant(orgId, (c) =>
    c.query("delete from organization_members where organization_id = $1 and user_id = (select id from users where email = $2)", [orgId, email]),
  );
}

/** Email → role, for every member of the organization. */
export async function rolesIn(orgId: string): Promise<Record<string, Role>> {
  const { rows } = await inTenant(orgId, (c) =>
    c.query<{ email: string; role: Role }>(
      `select u.email, r.key as role from organization_members m join users u on u.id = m.user_id join roles r on r.id = m.role_id
       where m.organization_id = $1`,
      [orgId],
    ),
  );
  return Object.fromEntries(rows.map((row) => [row.email, row.role]));
}

export async function organizationRow(orgId: string) {
  const { rows } = await inTenant(orgId, (c) => c.query<{ name: string; slug: string; status: string }>("select name, slug, status from organizations where id = $1", [orgId]));
  return rows[0];
}

export async function subscriptionOf(orgId: string) {
  const { rows } = await inTenant(orgId, (c) =>
    c.query<{ plan_key: string; status: string; trial_days: number }>(
      "select plan_key, status, extract(epoch from (trial_ends_at - now())) / 86400 as trial_days from subscriptions where organization_id = $1",
      [orgId],
    ),
  );
  return rows[0];
}

/** The organizations a user belongs to, as the database shows them to that user and to nobody else. */
export async function organizationsOf(email: string): Promise<(SeededOrganization & { role: Role; status: string })[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.user_id', (select id::text from users where email = $1), true)", [email]);
    const { rows } = await client.query(
      `select o.id, o.slug, o.name, o.status, r.key as role
       from organization_members m join organizations o on o.id = m.organization_id join roles r on r.id = m.role_id
       where m.user_id = (select id from users where email = $1) and o.deleted_at is null order by o.name`,
      [email],
    );
    await client.query("commit");
    return rows;
  } finally {
    await client.end();
  }
}
