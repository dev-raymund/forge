import "server-only";
import type { CacheEvent } from "@/platform/cache";
import { asAppError, type AppErrorKind } from "@/platform/errors";
import { formFailure } from "@/platform/form-failure";
import type { FormState } from "@/platform/forms";
import { loginPath } from "@/platform/routing/admin-access";
import type { RequestMeta } from "./context";
import { orgActivityPath, orgMembersPath, orgSettingsPath, orgSitesPath } from "./paths";

/** What an admin form submission comes to (./organization-forms.ts, ./member-forms.ts; the sites module's forms since M4-1). */
export type FormOutcome = {
  /** What the form shows. The only part that is sent to the browser. */
  state: FormState;
  /** Why it was refused, for callers and tests. */
  refused?: AppErrorKind | "Internal";
  /** Where the browser goes next. */
  redirectTo?: string;
  /** Admin URLs that now show something out of date. */
  revalidate?: string[];
  /** Public pages that now show something out of date: their cache tags are flushed (D-27). */
  invalidate?: CacheEvent[];
  /** An email was queued: the action starts the email job once the response is sent. */
  emailQueued?: boolean;
};

/** The pages of an organization that show its name, its URL, who is in it, its sites, or what was just done there (the activity log). */
export const pagesOf = (orgSlug: string): string[] => [orgSitesPath(orgSlug), orgSettingsPath(orgSlug), orgMembersPath(orgSlug), orgActivityPath(orgSlug)];

/** A thrown error → what the form shows. A session that ended leaves for the login page and comes back. */
export function refusal(
  error: unknown,
  meta: RequestMeta,
  values: Record<string, string>,
  next: string,
  messages: Partial<Record<AppErrorKind, string>> = {},
  module = "tenancy",
): FormOutcome {
  const appError = asAppError(error);
  const state = formFailure(error, { module, requestId: meta.requestId ?? "", values });
  if (!appError) return { state, refused: "Internal" };
  if (appError.kind === "Unauthenticated") return { state, refused: "Unauthenticated", redirectTo: loginPath({ next, reason: "session" }) };
  const message = messages[appError.kind];
  return { state: message ? { ...state, message } : state, refused: appError.kind };
}
