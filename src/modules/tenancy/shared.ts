/**
 * Client-safe exports of the tenancy module: role keys, slug rules, schemas
 * and the shapes other code sees. No database access from here.
 */
import type { ORGANIZATION_STATUSES, RoleKey } from "./schema";

export { ROLE_KEYS } from "./schema";
export type { RoleKey } from "./schema";
export { checkOrgSlug, isReservedOrgSlug, ORG_SLUG_MAX, ORG_SLUG_MIN, RESERVED_ORG_SLUGS, suggestOrgSlug } from "./slugs";
export { createOrganizationSchema, updateOrganizationSchema } from "./validation";
export type { CreateOrganizationInput, UpdateOrganizationInput } from "./validation";

export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

/** An organization as one of its members sees it. */
export type OrganizationSummary = {
  id: string;
  slug: string;
  name: string;
  status: OrganizationStatus;
  /** The viewer's role in it. */
  role: RoleKey;
};

export type MemberSummary = {
  /** The membership (not the user): what role changes and removals name. */
  id: string;
  userId: string;
  name: string;
  email: string;
  role: RoleKey;
  joinedAt: Date;
};
