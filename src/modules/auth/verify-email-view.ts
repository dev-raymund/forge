import type { AuthUser } from "./shared";

/**
 * What the verify-email screen shows (M2-2):
 *
 *  - `pending`   signed in, address not verified yet
 *  - `verified`  signed in and verified
 *  - `confirmed` not signed in, arrived from a link that verified an address
 *  - `invalid`   the link was invalid or expired; with `email` when a new one can be sent
 *  - `anonymous` not signed in, no link
 */
export type VerifyEmailView =
  | { kind: "pending"; email: string }
  | { kind: "verified" }
  | { kind: "confirmed" }
  | { kind: "invalid"; email?: string }
  | { kind: "anonymous" };

/**
 * The session decides. The query string (`?error=` and `?status=verified`,
 * added when an emailed link is followed) is only a hint: it can show a
 * message, but it never makes a signed-in user look verified.
 */
export function verifyEmailView(user: AuthUser | null, query: { error?: string; status?: string }): VerifyEmailView {
  if (user?.emailVerified) return { kind: "verified" };
  if (query.error) return user ? { kind: "invalid", email: user.email } : { kind: "invalid" };
  if (user) return { kind: "pending", email: user.email };
  return query.status === "verified" ? { kind: "confirmed" } : { kind: "anonymous" };
}
