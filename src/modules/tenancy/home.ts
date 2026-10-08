import { ONBOARDING_PATH, orgSitesPath } from "./paths";
import type { OrganizationStatus } from "./shared";

/**
 * Where `/` takes a signed-in user (plan §19: "the last org, or onboarding").
 *
 * Nothing remembers which organization a user was last in: there is no
 * "active organization" in the session or anywhere else (D-08). The answer is
 * worked out from the memberships themselves, the same way every time:
 *
 *  1. No organizations → onboarding.
 *  2. Otherwise the organization joined last (created or accepted most
 *     recently), among those that can be used.
 *  3. If every one is suspended, the one joined last anyway: its page says so.
 *
 * Pure, so the rule can be read and tested without a database.
 */

export type HomeCandidate = { id: string; slug: string; status: OrganizationStatus; joinedAt: Date };

/** Later join first; the id (a UUIDv7, so newer sorts higher) settles a tie. */
const byLastJoined = (a: HomeCandidate, b: HomeCandidate) => b.joinedAt.getTime() - a.joinedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export function chooseHomeOrganization<T extends HomeCandidate>(memberships: readonly T[]): T | null {
  const usable = memberships.filter((m) => m.status === "active");
  const pool = usable.length > 0 ? usable : memberships;
  return [...pool].sort(byLastJoined)[0] ?? null;
}

/** The path `/` redirects to. */
export const homePath = (organization: { slug: string } | null): string => (organization ? orgSitesPath(organization.slug) : ONBOARDING_PATH);
