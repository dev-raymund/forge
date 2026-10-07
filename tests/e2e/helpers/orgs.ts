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

// ── Members and invitations (M3-4) ───────────────────────────────────────────

/** What following the verification link does. Inviting people takes a verified email (plan §12). */
export async function markEmailVerified(email: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("update users set email_verified = true where email = $1", [email]);
  } finally {
    await client.end();
  }
}

export type InvitationRecord = { email: string; role: Role; state: "pending" | "expired" | "accepted" | "revoked"; token_hash: string };

/** Every invitation of the organization, with where it is in its life. */
export async function invitationsOf(orgId: string): Promise<InvitationRecord[]> {
  const { rows } = await inTenant(orgId, (c) =>
    c.query<InvitationRecord>(
      `select i.email, r.key as role, i.token_hash,
              case when i.accepted_at is not null then 'accepted' when i.revoked_at is not null then 'revoked'
                   when i.expires_at <= now() then 'expired' else 'pending' end as state
       from organization_invitations i join roles r on r.id = i.role_id where i.organization_id = $1 order by i.created_at, i.id`,
      [orgId],
    ),
  );
  return rows;
}

/** Moves an open invitation's expiry, as time would: `minutes` from now (negative: already expired). */
export async function setInvitationExpiry(orgId: string, email: string, minutes: number) {
  await inTenant(orgId, (c) =>
    c.query(
      "update organization_invitations set expires_at = now() + make_interval(mins => $3) where organization_id = $1 and email = $2 and accepted_at is null and revoked_at is null",
      [orgId, email, minutes],
    ),
  );
}

/** As if an open invitation had been sent `minutes` ago (an invitation lasts 7 days from when it is sent). */
export const invitationSentMinutesAgo = (orgId: string, email: string, minutes: number) => setInvitationExpiry(orgId, email, 7 * 24 * 60 - minutes);

// ── The activity log (M3-5) ──────────────────────────────────────────────────

export type AuditRecord = { action: string; actor_label: string; resource_type: string; request_id: string; ip: string; metadata: Record<string, unknown> };

/** Everything recorded for the organization, oldest first, as the database has it (including what the page never shows). */
export async function auditOf(orgId: string): Promise<AuditRecord[]> {
  const { rows } = await inTenant(orgId, (c) =>
    c.query<AuditRecord>("select action, actor_label, resource_type, request_id, ip, metadata from audit_logs where organization_id = $1 order by created_at, id", [orgId]),
  );
  return rows;
}

/**
 * `count` older events for the organization, one a minute going back from an
 * hour ago, by the user with this email. Written as the application's own
 * database role would write them: it may add to the log, and nothing else.
 */
export async function seedActivity(orgId: string, email: string, count: number) {
  await inTenant(orgId, async (c) => {
    for (let i = 0; i < count; i++) {
      await c.query(
        `insert into audit_logs (id, organization_id, actor_type, actor_id, actor_label, action, resource_type, metadata, created_at)
         select $1, $2, 'user', u.id, u.email, 'member.role_changed', 'membership', $3::jsonb, now() - make_interval(mins => 60 + $4)
         from users u where u.email = $5`,
        [uuidv7(), orgId, JSON.stringify({ memberName: `Seeded ${String(i + 1).padStart(3, "0")}`, previousRole: "viewer", newRole: "author" }), i, email],
      );
    }
  });
}
