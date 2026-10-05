import type { FieldErrors } from "./errors";

/**
 * What a form's Server Action returns to `useActionState` (client-safe).
 * `values` echoes the submitted non-secret fields so the form keeps them;
 * passwords and tokens are never echoed.
 */
export type FormState = {
  status: "idle" | "error" | "success";
  /** A message for the whole form (shown in the alert above the fields). */
  message?: string;
  /** Field name → messages. */
  fieldErrors?: FieldErrors;
  values?: Record<string, string>;
  /**
   * Where to go now, as a full page load. Signing in or out changes who the
   * page is for, so the browser leaves through a real navigation: nothing of
   * the previous state (rendered pages, typed passwords) is kept in the tab.
   */
  redirectTo?: string;
};

export const IDLE: FormState = { status: "idle" };

/** A FormData value as a string ("" for missing values and files). */
export const text = (value: FormDataEntryValue | null): string => (typeof value === "string" ? value : "");
