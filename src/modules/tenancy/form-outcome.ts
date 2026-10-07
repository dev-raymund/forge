import "server-only";
import { asAppError, type AppErrorKind } from "@/platform/errors";
import { formFailure } from "@/platform/form-failure";
import type { FormState } from "@/platform/forms";
import { loginPath } from "@/platform/routing/admin-access";
import type { RequestMeta } from "./context";
import { orgActivityPath, orgMembersPath, orgPath, orgSettingsPath } from "./paths";

/** What a form submission of this module comes to (./organization-forms.ts, ./member-forms.ts). */
export type FormOutcome = {
  /** What the form shows. The only part that is sent to the browser. */
  state: FormState;
  /** Why it was refused, for callers and tests. */
  refused?: AppErrorKind | "Internal";
  /** Where the browser goes next. */
  redirectTo?: string;
  /** Admin URLs that now show something out of date. */
  revalidate?: string[];
  /** An email was queued: the action starts the email job once the response is sent. */
  emailQueued?: boolean;
};

/** The pages of an organization that show its name, its URL, who is in it, or what was just done there (the activity log). */
export const pagesOf = (orgSlug: string): string[] => [orgPath(orgSlug), orgSettingsPath(orgSlug), orgMembersPath(orgSlug), orgActivityPath(orgSlug)];

/** A thrown error → what the form shows. A session that ended leaves for the login page and comes back. */
export function refusal(error: unknown, meta: RequestMeta, values: Record<string, string>, next: string, messages: Partial<Record<AppErrorKind, string>> = {}): FormOutcome {
  const appError = asAppError(error);
  const state = formFailure(error, { module: "tenancy", requestId: meta.requestId ?? "", values });
  if (!appError) return { state, refused: "Internal" };
  if (appError.kind === "Unauthenticated") return { state, refused: "Unauthenticated", redirectTo: loginPath({ next, reason: "session" }) };
  const message = messages[appError.kind];
  return { state: message ? { ...state, message } : state, refused: appError.kind };
}
