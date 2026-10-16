import "server-only";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { TenantTx } from "@/platform/db";
// Another module's table (the actor's address, for the label) comes from the schema barrel.
import { sites, users } from "@/platform/db/schema";
import { AUDIT_EVENTS, AuditEventError, isAuditAction, sanitizeMetadata, type AuditEntry } from "./events";
import { auditLogs } from "./schema";

/**
 * `audit.record(tx, entry)`: the one way a tenant's activity is written (D-30,
 * ADR 0010).
 *
 * It takes the transaction of the change it describes, so the two commit
 * together or not at all: there is no change without its record, and no record
 * of a change that was rolled back. If the record cannot be written, this
 * throws and the caller's transaction is lost with it. That is deliberate
 * (D-30): an unrecorded change to who may do what is worse than a failed one.
 *
 * Who did it, and in which organization, are not parameters. They are read,
 * inside the INSERT itself, from the transaction's own context
 * (`app_current_org_id()`, `app_current_user_id()`): the values `withTenant`
 * set and that row-level security already answers to. A service can therefore
 * not record an event for another organization, or in somebody else's name,
 * even by mistake. Called without that context, it writes nothing and throws.
 *
 * A site-level event (M4-1) names its site, and that one is checked the same
 * way: it must be a site of the transaction's organization, or nothing is
 * written and this throws.
 *
 * The request id and client address are for support and security work. They
 * come from the request's context and are stored; the activity page never
 * shows them.
 */

/** The part of a request's context that is stored with an event. An `OrgContext` has both. */
export type AuditRequest = { readonly requestId?: string; readonly ip?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clip = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");

export async function record(tx: TenantTx, entry: AuditEntry, request: AuditRequest = {}): Promise<void> {
  if (!isAuditAction(entry.action)) throw new AuditEventError(`"${String(entry.action)}" is not an audit event (modules/audit/events.ts)`);
  const event = AUDIT_EVENTS[entry.action];
  if (entry.resourceType !== event.resourceType) {
    throw new AuditEventError(`Audit event "${entry.action}" is about a ${event.resourceType}, not a ${String(entry.resourceType)}`);
  }
  if (typeof entry.resourceId !== "string" || !UUID.test(entry.resourceId)) throw new AuditEventError(`Audit event "${entry.action}" needs the id of its ${event.resourceType}`);
  if (entry.siteId !== undefined && (typeof entry.siteId !== "string" || !UUID.test(entry.siteId))) {
    throw new AuditEventError(`Audit event "${entry.action}" was given a site that is not an id`);
  }
  const metadata = sanitizeMetadata(entry.action, entry.metadata);

  // One statement. The organization and the actor are read by the database from the transaction's own
  // context; with either missing there is no row to insert, and so nothing is written at all. The same for a
  // site that is not one of that organization's (RLS hides every other organization's sites from the lookup).
  const siteId = entry.siteId ?? null;
  const written = await tx.execute<{ id: string }>(sql`
    insert into ${auditLogs} (id, organization_id, site_id, actor_type, actor_id, actor_label, action, resource_type, resource_id, request_id, ip, metadata)
    select ${uuidv7()}::uuid, app_current_org_id(), ${siteId}::uuid, 'user', app_current_user_id(),
           coalesce((select ${users.email} from ${users} where ${users.id} = app_current_user_id()), ''),
           ${entry.action}, ${event.resourceType}, ${entry.resourceId}::uuid,
           ${clip(request.requestId, 100)}, ${clip(request.ip, 64)}, ${JSON.stringify(metadata)}::jsonb
    where app_current_org_id() is not null and app_current_user_id() is not null
      and (${siteId}::uuid is null
           or exists (select 1 from ${sites} where ${sites.id} = ${siteId}::uuid and ${sites.organizationId} = app_current_org_id()))
    returning id`);

  // Thrown inside the caller's transaction, which is lost with it: a change is not committed without its record.
  if (written.rows.length !== 1) {
    throw new AuditEventError(
      siteId
        ? "audit.record() must run inside an organization's transaction, with the acting user in its context, for a site of that organization"
        : "audit.record() must run inside an organization's transaction, with the acting user in its context (inTenant, or withTenant({ orgId, userId }))",
    );
  }
}

/**
 * Who acts when no person does (M7-2, ADR 0025): one of Forge's own jobs, from this fixed list, with the name the
 * activity page shows for it. Typed, never free text: a caller cannot invent an actor.
 */
export const SYSTEM_ACTORS = {
  "entry.publish_scheduled": "Forge (scheduled publishing)",
  "trash.purge": "Forge (trash cleanup)",
} as const;
export type SystemActor = keyof typeof SYSTEM_ACTORS;

/**
 * `record` for a system actor (M7-2): the same events, checks and transaction rule (the record commits with the change
 * or neither does), written as `actor_type = 'system'` with no user. The organization is still read from the
 * transaction's own context (`withTenant({ orgId })`, as a tenant job's is), never passed in; and the transaction must
 * have no user in it: a person's change is never recorded as the system's, nor the system's as a person's.
 */
export async function recordSystem(tx: TenantTx, entry: AuditEntry, actor: SystemActor): Promise<void> {
  if (!Object.hasOwn(SYSTEM_ACTORS, actor)) throw new AuditEventError(`"${String(actor)}" is not a system actor`);
  if (!isAuditAction(entry.action)) throw new AuditEventError(`"${String(entry.action)}" is not an audit event (modules/audit/events.ts)`);
  const event = AUDIT_EVENTS[entry.action];
  if (entry.resourceType !== event.resourceType) {
    throw new AuditEventError(`Audit event "${entry.action}" is about a ${event.resourceType}, not a ${String(entry.resourceType)}`);
  }
  if (typeof entry.resourceId !== "string" || !UUID.test(entry.resourceId)) throw new AuditEventError(`Audit event "${entry.action}" needs the id of its ${event.resourceType}`);
  if (entry.siteId !== undefined && (typeof entry.siteId !== "string" || !UUID.test(entry.siteId))) {
    throw new AuditEventError(`Audit event "${entry.action}" was given a site that is not an id`);
  }
  const metadata = sanitizeMetadata(entry.action, entry.metadata);
  const siteId = entry.siteId ?? null;
  const written = await tx.execute<{ id: string }>(sql`
    insert into ${auditLogs} (id, organization_id, site_id, actor_type, actor_id, actor_label, action, resource_type, resource_id, request_id, ip, metadata)
    select ${uuidv7()}::uuid, app_current_org_id(), ${siteId}::uuid, 'system', null, ${SYSTEM_ACTORS[actor]},
           ${entry.action}, ${event.resourceType}, ${entry.resourceId}::uuid, ${`job:${actor}`}, '', ${JSON.stringify(metadata)}::jsonb
    where app_current_org_id() is not null and app_current_user_id() is null
      and (${siteId}::uuid is null
           or exists (select 1 from ${sites} where ${sites.id} = ${siteId}::uuid and ${sites.organizationId} = app_current_org_id()))
    returning id`);
  if (written.rows.length !== 1) {
    throw new AuditEventError("audit.recordSystem() must run inside an organization's transaction with no user in its context (a tenant job's withTenant), for a site of that organization");
  }
}
