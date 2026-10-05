import "server-only";
import { asAppError } from "./errors";
import type { FormState } from "./forms";
import { reportError } from "./observability";

/**
 * A thrown error → what the form shows. Expected failures (`AppError`) carry
 * Forge's own message and field errors. Anything else is reported (log +
 * Sentry, never the form's values) and the user gets a generic message with
 * the request id.
 */
export function formFailure(error: unknown, context: { module: string; requestId: string; values?: Record<string, string> }): FormState {
  const values = context.values ?? {};
  const appError = asAppError(error);
  if (!appError) {
    reportError(error, { module: context.module, requestId: context.requestId });
    return { status: "error", message: `Something went wrong. Please try again. Reference: ${context.requestId}`, values };
  }
  const { _form, ...fieldErrors } = appError.fieldErrors ?? {};
  const hasFieldErrors = Object.keys(fieldErrors).length > 0;
  return {
    status: "error",
    message: _form?.[0] ?? (hasFieldErrors ? undefined : appError.message),
    ...(hasFieldErrors ? { fieldErrors } : {}),
    values,
  };
}
