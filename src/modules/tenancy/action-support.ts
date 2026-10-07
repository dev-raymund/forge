import "server-only";
import { refresh, revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { kickEmail } from "@/platform/email";
import type { FormState } from "@/platform/forms";
import type { FormOutcome } from "./form-outcome";

/** Helpers for ./actions.ts (a "use server" file may export only actions). */

/**
 * Ends a Server Action: drops what is now out of date, then goes where the
 * outcome says, or hands the form its new state.
 *
 * Nothing about an organization is cached on the server: its pages are
 * rendered per request, from the caller's own membership, so there is no
 * shared cache entry that could hold one user's organizations for another.
 * What does keep old pages is the browser's router: `revalidatePath` (the
 * organization's own admin URLs, nothing else) makes it fetch them again, and
 * `refresh()` re-renders the page the form is on, header included.
 */
export function finish(outcome: FormOutcome): FormState {
  // The email is already queued, in the transaction that made the invitation. This only sends it sooner.
  if (outcome.emailQueued) kickEmail();
  for (const path of outcome.revalidate ?? []) revalidatePath(path);
  if (outcome.redirectTo) redirect(outcome.redirectTo);
  if (outcome.state.status === "success") refresh();
  return outcome.state;
}
