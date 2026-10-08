/** Client-safe exports of the billing module: the plans and their limits (plan §14). */
export { countOf, hasRoomFor, limitMessage, PLANS } from "./plans";
export type { Allowance, LimitKey, Plan, PlanKey } from "./plans";
