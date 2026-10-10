/**
 * Publishing a site (M4-5, ADR 0015): which status changes a member may make.
 * Pure.
 *
 *   coming_soon → live          publish (needs a verified email address)
 *   live        → coming_soon   back to Coming soon
 *   suspended   → anything      refused: only staff lift a suspension (M12-1)
 *   x           → x             nothing to do
 *
 * `suspended` is never a target here: the schema of the request does not
 * have it.
 */
export const SETTABLE_STATUSES = ["coming_soon", "live"] as const;
export type SettableStatus = (typeof SETTABLE_STATUSES)[number];

export type Transition = "change" | "unchanged" | "refused";

export function statusTransition(current: string, target: SettableStatus): Transition {
  if (current === "suspended" || !(SETTABLE_STATUSES as readonly string[]).includes(current)) return "refused";
  return current === target ? "unchanged" : "change";
}

export const VERIFY_TO_PUBLISH = "Verify your email address to publish this site.";
export const SITE_UNAVAILABLE = "This site is unavailable, so its status cannot be changed here. Contact Forge support.";
