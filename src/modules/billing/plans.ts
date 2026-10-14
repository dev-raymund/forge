import type { PLAN_KEYS } from "./schema";

/**
 * The plans, in code (plan §14, D-10). Client-safe.
 *
 * Only the limits that something enforces are here. M4-1 enforces the number
 * of sites, M6-1 the storage that uploads take; members, API keys and the rest
 * of the plan's table arrive with the features that check them (M11 wires the
 * remaining ones).
 *
 * The figures are the plan's ("illustrative" there, and the ones V1 ships
 * with): Free 1 site and 1 GB, Pro and the Pro trial 5 sites and 20 GB. A
 * gigabyte here is 1024³ bytes.
 */

export type PlanKey = (typeof PLAN_KEYS)[number];
export type LimitKey = "sites" | "storage";

export type Plan = { readonly label: string; readonly limits: Readonly<Record<LimitKey, number>> };

const GB = 1024 ** 3;

export const PLANS: Readonly<Record<PlanKey, Plan>> = Object.freeze({
  free: { label: "Free", limits: { sites: 1, storage: 1 * GB } },
  pro: { label: "Pro", limits: { sites: 5, storage: 20 * GB } },
});

/** A number of bytes the way people read it: "1 GB", "20 GB", "512 MB", "1.5 GB". */
export function formatBytes(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  return `${Number.isInteger(value) ? value : Number(value.toFixed(1))} ${units[unit]}`;
}

/** What a limit is called in a sentence: "1 site", "5 sites", "1 GB of storage". */
export function countOf(key: LimitKey, n: number): string {
  if (key === "storage") return `${formatBytes(n)} of storage`;
  return `${n} ${n === 1 ? "site" : "sites"}`;
}

/** How much of one limit an organization has used. */
export type Allowance = { readonly plan: PlanKey; readonly key: LimitKey; readonly used: number; readonly limit: number };

/** Whether `amount` more fits: one more site, or this many more bytes. */
export const hasRoomFor = (allowance: Allowance, amount = 1): boolean => allowance.used + amount <= allowance.limit;

/** What the person is told when the limit stops them. */
export function limitMessage(allowance: Allowance): string {
  const { plan, key, limit } = allowance;
  if (key === "storage") {
    return `The ${PLANS[plan].label} plan includes ${countOf(key, limit)}, and these files would take this organization past it (${formatBytes(allowance.used)} used).`;
  }
  return `The ${PLANS[plan].label} plan includes ${countOf(key, limit)}, and this organization has reached it.`;
}
