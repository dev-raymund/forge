import type { RoleKey } from "./schema";

/**
 * The permission catalog, and what each role holds (plan §13, D-09, ADR 0009).
 *
 * This file is the single source of both. Nothing else in the application maps
 * a role to what it may do: code asks `can(ctx, permission)` (./policies.ts),
 * and the answer comes from the tables below.
 *
 * It is plain data and pure functions: no database, no request. A role's
 * permissions are a fact about the code that is running, the same in every
 * organization, which is why they are never stored and never sent by a client.
 */

/**
 * Every permission in V1, as `area.action`. Entries carry their type:
 * `entries.{type}.{action}`. A key ending in `.own` covers only what the member
 * made themselves; its `.any` twin covers everyone's.
 *
 * Reading an organization, its members and its sites takes no permission:
 * being a member is what grants it (the resolver, ./context.ts).
 */
export const PERMISSIONS = [
  // The organization
  "org.manage", // rename, re-address, transfer ownership, delete
  "org.billing.manage",
  "org.members.manage", // invite, change role, remove
  "org.activity.read",
  // Sites
  "sites.create",
  "sites.delete",
  "site.settings.manage", // settings, appearance, domains, API keys, publish site
  "site.menus.manage",
  "site.seo.manage", // including redirects
  // Pages
  "entries.page.read", // admin, drafts, preview
  "entries.page.create",
  "entries.page.update",
  "entries.page.publish",
  "entries.page.delete",
  // Posts
  "entries.post.read",
  "entries.post.create",
  "entries.post.update.own",
  "entries.post.update.any",
  "entries.post.publish.own",
  "entries.post.publish.any",
  "entries.post.delete.own",
  "entries.post.delete.any",
  // Categories and tags
  "terms.manage",
  "terms.assign",
  // Media
  "media.upload",
  "media.update.own",
  "media.update.any",
  "media.delete.own",
  "media.delete.any",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const CATALOG: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(key: unknown): key is Permission {
  return typeof key === "string" && CATALOG.has(key);
}

// ── What a role is given ─────────────────────────────────────────────────────

type ActionOf<P> = P extends `entries.${string}.${infer Action}` ? Action : never;

/**
 * A catalog key, or `entries.*.{action}`: that action on every entry type.
 * It is the only wildcard there is, and it stands for the type segment only.
 */
export type Grant = Permission | `entries.*.${ActionOf<Permission>}`;

/**
 * Does a grant cover a key? Exactly equal, or equal with `*` in place of the
 * entry type. A wildcard never spans segments (`entries.*.update` is not
 * `entries.post.update.own`) and means nothing anywhere else.
 */
export function grantMatches(grant: string, permission: string): boolean {
  if (grant === permission) return true;
  const [area, type, ...action] = grant.split(".");
  if (area !== "entries" || type !== "*" || action.length === 0) return false;
  const asked = permission.split(".");
  return asked[0] === "entries" && asked.length === action.length + 2 && asked[1] !== "*" && asked.slice(2).join(".") === action.join(".");
}

// The five columns of the table in plan §13, as the five things a member can be trusted with.
// A role lists the ones it has; no role is defined in terms of another.

/** See everything in the admin, change nothing. */
const READ = ["entries.*.read"] as const satisfies readonly Grant[];

/** Write posts and upload media, and manage only what they made. */
const OWN_WORK = [
  "entries.post.create",
  "entries.post.update.own",
  "entries.post.publish.own",
  "entries.post.delete.own",
  "terms.assign",
  "media.upload",
  "media.update.own",
  "media.delete.own",
] as const satisfies readonly Grant[];

/** Everyone's content, and the parts of a site that are content: pages, menus, SEO, terms. */
const EDITORIAL = [
  "site.menus.manage",
  "site.seo.manage",
  "entries.page.create",
  "entries.page.update",
  "entries.page.publish",
  "entries.page.delete",
  "entries.post.update.any",
  "entries.post.publish.any",
  "entries.post.delete.any",
  "terms.manage",
  "media.update.any",
  "media.delete.any",
] as const satisfies readonly Grant[];

/** People and sites. */
const ADMINISTRATION = ["org.members.manage", "org.activity.read", "sites.create", "site.settings.manage"] as const satisfies readonly Grant[];

/** What cannot be undone or costs money. */
const OWNERSHIP = ["org.manage", "org.billing.manage", "sites.delete"] as const satisfies readonly Grant[];

/** Role → what it is given. The authoritative mapping (plan §13). */
export const ROLE_GRANTS: Readonly<Record<RoleKey, readonly Grant[]>> = Object.freeze({
  owner: [...READ, ...OWN_WORK, ...EDITORIAL, ...ADMINISTRATION, ...OWNERSHIP],
  admin: [...READ, ...OWN_WORK, ...EDITORIAL, ...ADMINISTRATION],
  editor: [...READ, ...OWN_WORK, ...EDITORIAL],
  author: [...READ, ...OWN_WORK],
  viewer: [...READ],
});

// ── What a role holds ────────────────────────────────────────────────────────

/**
 * The permissions somebody holds. It answers one question and cannot be
 * changed: there is no way to add a key to a set once it exists.
 */
export type PermissionSet = {
  /** True only for a catalog key that is in the set. Anything else is false. */
  readonly has: (permission: Permission) => boolean;
  /** The keys in the set, in catalog order. */
  readonly list: readonly Permission[];
};

function permissionSet(held: readonly Permission[]): PermissionSet {
  const keys: ReadonlySet<unknown> = new Set(held);
  return Object.freeze({ has: (permission: unknown) => keys.has(permission), list: Object.freeze([...held]) });
}

/** Grants → catalog keys. Only keys of the catalog can come out, whatever went in. */
const expand = (grants: readonly string[]): Permission[] => PERMISSIONS.filter((key) => grants.some((grant) => grantMatches(grant, key)));

/** Holds nothing. What an unknown role gets. */
export const NO_PERMISSIONS: PermissionSet = permissionSet([]);

// A Map, so that a role named "constructor" or "__proto__" finds nothing rather than something inherited.
const ROLE_PERMISSIONS: ReadonlyMap<unknown, PermissionSet> = new Map(
  Object.entries(ROLE_GRANTS).map(([role, grants]) => [role, permissionSet(expand(grants))]),
);

/**
 * What a role holds. The same answer every time, for every organization.
 * A role this code does not know holds nothing.
 */
export function permissionsForRole(role: RoleKey | (string & {})): PermissionSet {
  return ROLE_PERMISSIONS.get(role) ?? NO_PERMISSIONS;
}

/**
 * The same question for a role just read from the database: the services
 * re-read the member's role under the organization lock and ask again, so a
 * demotion that landed after the request began still counts.
 */
export function roleHolds(role: RoleKey | (string & {}), permission: Permission): boolean {
  return permissionsForRole(role).has(permission);
}

// ── Ownership ────────────────────────────────────────────────────────────────

export type OwnPermission = Extract<Permission, `${string}.own`>;

type ScopeOf<P> = P extends `${infer Scope}.own` ? Scope : never;

/** `entries.post.update`, `media.delete`, …: a thing that can be done to one's own or to anyone's. */
export type OwnScope = ScopeOf<Permission>;

const isOwnPermission = (permission: Permission): permission is OwnPermission => permission.endsWith(".own");
const isId = (value: unknown): value is string => typeof value === "string" && value !== "";

/**
 * The thing a permission is being asked about: which organization it belongs
 * to and who made it (an entry's `author_id`, a media item's `uploaded_by`).
 */
export type OwnedResource = { readonly organizationId: string; readonly ownerId: string | null };

/** Who is asking, reduced to what a decision needs. */
export type Subject = { readonly permissions: PermissionSet; readonly userId: string; readonly organizationId: string };

/**
 * The decision behind `can()`, without the request around it.
 *
 *  1. The subject must hold the key. An unknown key is held by nobody.
 *  2. A resource from another organization is never allowed, whatever the key.
 *  3. A `.own` key needs a resource, and the subject must be the one who made it.
 */
export function permits(subject: Subject, permission: Permission, resource?: OwnedResource | null): boolean {
  if (!subject.permissions.has(permission)) return false;
  if (resource != null && (!isId(resource.organizationId) || resource.organizationId !== subject.organizationId)) return false;
  if (!isOwnPermission(permission)) return true;
  return resource != null && isId(resource.ownerId) && resource.ownerId === subject.userId;
}
