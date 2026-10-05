import "server-only";
import { headers } from "next/headers";
import { cache } from "react";
import { getCurrentActor, type Actor } from "@/modules/auth";
import { findSiteBySlug, type SiteRef } from "@/modules/sites";
import { withTenant, withUser, type TenantTx } from "@/platform/db";
import { forbidden, notFound, unauthenticated } from "@/platform/errors";
import { requestIdFrom } from "@/platform/observability";
import { permissionsForRole, type PermissionSet } from "./permissions";
import { findMembershipBySlug } from "./repository";
import type { RoleKey } from "./schema";
import { looksLikeOrgSlug } from "./slugs";

/**
 * The tenant resolver (D-08, plan §19): the one place that turns "this user,
 * this URL" into "this organization, this site".
 *
 *   authentication (modules/auth)   who is this?
 *   tenancy        (here)           which organization and site is this request about, and does the user belong there?
 *   authorization  (./policies.ts)  what may they do there?
 *
 * The organization and the site come from the URL and nowhere else: never from
 * a form field, a request body or client state. Every service that touches
 * tenant data takes the context this file returns and opens its transaction
 * with `inTenant(ctx, …)`, so the organization id that RLS sees is always one
 * whose membership was just verified.
 */

/** Type-level only: makes `OrgContext` impossible to write as an object literal outside this file. */
declare const VERIFIED: unique symbol;

/**
 * The contexts this file has produced. Membership in this set, not the shape of
 * the object, is what `assertContext` checks: a cast, a hand-built object, or a
 * spread copy with another organization's id put in is not in it.
 */
const genuine = new WeakSet<object>();

function seal<T extends object>(context: T): T {
  Object.freeze(context);
  genuine.add(context);
  return context;
}

export type UserActor = Extract<Actor, { kind: "user" }>;

export type OrgContext = {
  readonly requestId: string;
  /** The client address, for audit rows. */
  readonly ip?: string;
  readonly actor: UserActor;
  readonly org: { readonly id: string; readonly slug: string; readonly name: string };
  /** The actor's membership of `org`, as it was when the context was resolved. */
  readonly membership: { readonly id: string; readonly role: RoleKey };
  /**
   * What the member may do here: the catalog's set for their role
   * (./permissions.ts). Worked out by the resolver from the membership it just
   * read, once per request, and from nothing the request itself says.
   */
  readonly permissions: PermissionSet;
  /** Never present at runtime (see `genuine`): a context cannot be assembled from loose ids. */
  readonly [VERIFIED]: true;
};

export type SiteContext = OrgContext & {
  readonly site: { readonly id: string; readonly slug: string; readonly name: string; readonly status: SiteRef["status"] };
};

export type RequestMeta = { requestId?: string; ip?: string };

/** Is `ctx` an object the resolver itself returned? */
export function isContext(ctx: unknown): ctx is OrgContext {
  return typeof ctx === "object" && ctx !== null && genuine.has(ctx);
}

/** Throws unless `ctx` is an object the resolver itself returned. */
export function assertContext(ctx: OrgContext): void {
  if (!isContext(ctx)) throw new Error("A tenant context must come from resolveOrgContext() / resolveSiteContext()");
}

/**
 * Opens a transaction scoped to the context's organization. The way a service
 * reaches tenant tables: the organization id is the verified one, by construction.
 */
export function inTenant<T>(ctx: OrgContext, work: (tx: TenantTx) => Promise<T>): Promise<T> {
  assertContext(ctx);
  return withTenant({ orgId: ctx.org.id, userId: ctx.actor.userId }, work);
}

/**
 * session user → organization slug → membership.
 *
 * - Not signed in → `Unauthenticated`.
 * - Unknown slug, deleted organization, or not a member → `NotFound`. One
 *   answer for all three: a non-member cannot tell whether a slug exists.
 * - A member of a suspended organization → `Forbidden` (they know it exists;
 *   it just cannot be used).
 *
 * The context carries the member's permissions. They follow from the role on
 * the membership row read here, so a role change counts from the next request,
 * and somebody who is not signed in or not a member never has a context to
 * hold permissions in.
 */
export async function resolveOrgContext(actor: Actor, orgSlug: string, meta: RequestMeta = {}): Promise<OrgContext> {
  if (actor.kind !== "user") throw unauthenticated();
  // A slug has one spelling. Anything else is not asked of the database at all.
  if (typeof orgSlug !== "string" || !looksLikeOrgSlug(orgSlug)) throw notFound();

  const membership = await withUser(actor.userId, (tx) => findMembershipBySlug(tx, actor.userId, orgSlug));
  if (!membership) throw notFound();
  if (membership.status !== "active") throw forbidden("This organization has been suspended.");

  return seal({
    requestId: meta.requestId ?? "",
    ...(meta.ip ? { ip: meta.ip } : {}),
    actor: Object.freeze({ ...actor }),
    org: Object.freeze({ id: membership.id, slug: membership.slug, name: membership.name }),
    membership: Object.freeze({ id: membership.membershipId, role: membership.role }),
    permissions: permissionsForRole(membership.role),
  } as OrgContext);
}

/**
 * V1: a role is organization-wide (plan §13), so a member can reach every site
 * of their organization, and no site of any other. Later rules (a member
 * limited to some sites) change this one function.
 */
export function canAccessSite(ctx: OrgContext, site: Pick<SiteRef, "organizationId">): boolean {
  return site.organizationId === ctx.org.id;
}

/**
 * … → site slug → the site belongs to the organization → the member may reach it.
 *
 * A slug that names no site of THIS organization is `NotFound`, including a
 * slug that is a perfectly good site of another organization.
 */
export async function resolveSiteWithin(ctx: OrgContext, siteSlug: string): Promise<SiteContext> {
  assertContext(ctx);
  if (typeof siteSlug !== "string" || !looksLikeOrgSlug(siteSlug)) throw notFound();
  const site = await inTenant(ctx, (tx) => findSiteBySlug(tx, ctx.org.id, siteSlug));
  if (!site || !canAccessSite(ctx, site)) throw notFound();
  return seal({ ...ctx, site: Object.freeze({ id: site.id, slug: site.slug, name: site.name, status: site.status }) });
}

export async function resolveSiteContext(actor: Actor, orgSlug: string, siteSlug: string, meta: RequestMeta = {}): Promise<SiteContext> {
  return resolveSiteWithin(await resolveOrgContext(actor, orgSlug, meta), siteSlug);
}

// ── The current request ──────────────────────────────────────────────────────

/** The request id and client address of the current request, for contexts resolved outside `requireOrgContext` (Server Actions). */
export async function currentRequestMeta(): Promise<RequestMeta> {
  const incoming = await headers();
  return { requestId: requestIdFrom(incoming), ip: incoming.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 64) || undefined };
}

/**
 * The context of the current request for `/{orgSlug}/…`, from the session and
 * the URL segment. Cached per request (React `cache`): layouts, pages and
 * actions that ask for the same organization share one membership query.
 * Throws the same errors as `resolveOrgContext`.
 */
export const requireOrgContext = cache(async (orgSlug: string): Promise<OrgContext> => {
  return resolveOrgContext(await getCurrentActor(), orgSlug, await currentRequestMeta());
});

/** The same for `/{orgSlug}/sites/{siteSlug}/…`. */
export const requireSiteContext = cache(async (orgSlug: string, siteSlug: string): Promise<SiteContext> => {
  return resolveSiteWithin(await requireOrgContext(orgSlug), siteSlug);
});
