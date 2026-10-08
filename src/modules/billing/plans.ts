import type { PLAN_KEYS } from "./schema";

/**
 * The plans, in code (plan §14, D-10). Client-safe.
 *
 * Only the limits that something enforces are here. M4-1 enforces the number
 * of sites; members, storage, API keys and the rest of the plan's table arrive
 * with the features that check them (M11 wires the remaining ones).
 *
 * The figures are the plan's ("illustrative" there, and the ones V1 ships
 * with): Free 1 site, Pro and the Pro trial 5.
 */

export type PlanKey = (typeof PLAN_KEYS)[number];
export type LimitKey = "sites";

export type Plan = { readonly label: string; readonly limits: Readonly<Record<LimitKey, number>> };

export const PLANS: Readonly<Record<PlanKey, Plan>> = Object.freeze({
  free: { label: "Free", limits: { sites: 1 } },
  pro: { label: "Pro", limits: { sites: 5 } },
});

/** What a limit is called in a sentence: "1 site", "5 sites". */
const NOUNS: Readonly<Record<LimitKey, [one: string, many: string]>> = { sites: ["site", "sites"] };

export const countOf = (key: LimitKey, n: number): string => `${n} ${NOUNS[key][n === 1 ? 0 : 1]}`;

/** How much of one limit an organization has used. */
export type Allowance = { readonly plan: PlanKey; readonly key: LimitKey; readonly used: number; readonly limit: number };

export const hasRoomFor = (allowance: Allowance): boolean => allowance.used < allowance.limit;

/** What the person is told when the limit stops them. */
export function limitMessage(allowance: Allowance): string {
  const { plan, key, limit } = allowance;
  return `The ${PLANS[plan].label} plan includes ${countOf(key, limit)}, and this organization has reached it.`;
}
