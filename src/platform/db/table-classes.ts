/**
 * Every table belongs to exactly one class, and the class decides its
 * protection (v1-build-plan §4.3). The isolation test suite iterates this map:
 * a table missing from it, or a tenant table without RLS + FORCE, fails CI.
 *
 *   tenant      RLS: organization_id = tenant context. Access only via withTenant().
 *   membership  RLS: own organization, or rows of the current user (org switcher).
 *   identity    No RLS. Managed by modules/auth (Better Auth) only.
 *   reference   No RLS. Read-only for the runtime role.
 *   platform    No RLS. Not tenant-owned; owned by one module (domains, jobs).
 */
export type TableClass = "tenant" | "membership" | "identity" | "reference" | "platform";

export const TABLE_CLASSES = {
  users: "identity",
  auth_accounts: "identity",
  auth_sessions: "identity",
  auth_verifications: "identity",

  organizations: "membership",
  organization_members: "membership",
  organization_invitations: "tenant",
  roles: "reference",
  subscriptions: "tenant",
  api_keys: "tenant",
  audit_logs: "tenant",

  sites: "tenant",
  site_settings: "tenant",
  domains: "platform",

  entries: "tenant",
  entry_drafts: "tenant",
  entry_revisions: "tenant",
  terms: "tenant",
  entry_terms: "tenant",

  media_folders: "tenant",
  media_assets: "tenant",

  menus: "tenant",
  redirects: "tenant",

  jobs: "platform",
} as const satisfies Record<string, TableClass>;

export type TableName = keyof typeof TABLE_CLASSES;

export const tablesOfClass = (cls: TableClass): TableName[] =>
  (Object.keys(TABLE_CLASSES) as TableName[]).filter((t) => TABLE_CLASSES[t] === cls);
