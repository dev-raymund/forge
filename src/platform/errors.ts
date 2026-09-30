import { ZodError } from "zod";

/**
 * Typed application errors (long-term §5.6). Services throw them; adapters map
 * them: Server Actions return an `ActionResult`, route handlers return RFC 9457
 * `problem+json`. Anything else is unexpected: callers report it (logger +
 * Sentry) and the user sees a generic message carrying the request ID.
 */

export const APP_ERROR_KINDS = [
  "NotFound", // also for anything outside the caller's tenant
  "Forbidden", // inside the tenant, but the caller lacks permission
  "Validation",
  "Conflict", // version mismatch, slug taken
  "LimitExceeded", // plan entitlement
  "RateLimited",
  "Unavailable", // transient infrastructure failure
] as const;
export type AppErrorKind = (typeof APP_ERROR_KINDS)[number];

export type FieldErrors = Record<string, string[]>;

type AppErrorOptions = {
  fieldErrors?: FieldErrors;
  entitlement?: string;
  retryAfterSeconds?: number;
  cause?: unknown;
};

export class AppError extends Error {
  readonly kind: AppErrorKind;
  readonly fieldErrors?: FieldErrors;
  readonly entitlement?: string;
  readonly retryAfterSeconds?: number;

  constructor(kind: AppErrorKind, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.kind = kind;
    this.fieldErrors = options.fieldErrors;
    this.entitlement = options.entitlement;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;

// Messages are user-facing and deliberately generic: a NotFound never says
// whether the thing exists in another tenant.
export const notFound = () => new AppError("NotFound", "Not found.");
export const forbidden = (message = "You don't have permission to do that.") => new AppError("Forbidden", message);
export const validationError = (fieldErrors: FieldErrors, message = "Please check the highlighted fields.") =>
  new AppError("Validation", message, { fieldErrors });
export const conflict = (message: string) => new AppError("Conflict", message);
export const limitExceeded = (entitlement: string, message = "Your plan's limit has been reached.") =>
  new AppError("LimitExceeded", message, { entitlement });
export const rateLimited = (retryAfterSeconds?: number) =>
  new AppError("RateLimited", "Too many requests. Please try again shortly.", { retryAfterSeconds });
export const unavailable = (cause?: unknown) =>
  new AppError("Unavailable", "The service is temporarily unavailable. Please try again.", { cause });

/** Zod issues → field errors keyed by dotted path ("_form" for top-level issues). */
export function fieldErrorsFrom(error: ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.join(".") : "_form";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/** Normalizes anything thrown: AppError as is, ZodError → Validation, otherwise null (unexpected). */
export function asAppError(error: unknown): AppError | null {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) return validationError(fieldErrorsFrom(error));
  return null;
}

// ── Server Actions ───────────────────────────────────────────────────────────

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: string;
      code: AppErrorKind | "Internal";
      fieldErrors?: FieldErrors;
      requestId?: string;
    };

export const actionOk = <T>(data: T): ActionResult<T> => ({ ok: true, data });

/** Maps a thrown error to an action result. Report unexpected errors before calling this. */
export function toActionResult(error: unknown, requestId?: string): ActionResult<never> {
  const appError = asAppError(error);
  if (!appError) {
    return {
      ok: false,
      code: "Internal",
      error: requestId ? `Something went wrong. Reference: ${requestId}` : "Something went wrong.",
      requestId,
    };
  }
  return {
    ok: false,
    code: appError.kind,
    error: appError.message,
    ...(appError.fieldErrors ? { fieldErrors: appError.fieldErrors } : {}),
  };
}

// ── Route handlers: RFC 9457 problem+json ────────────────────────────────────

const PROBLEMS: Record<AppErrorKind | "Internal", { status: number; slug: string; title: string }> = {
  NotFound: { status: 404, slug: "not-found", title: "Not found" },
  Forbidden: { status: 403, slug: "forbidden", title: "Forbidden" },
  Validation: { status: 422, slug: "validation", title: "Invalid request" },
  Conflict: { status: 409, slug: "conflict", title: "Conflict" },
  LimitExceeded: { status: 402, slug: "limit-exceeded", title: "Plan limit reached" },
  RateLimited: { status: 429, slug: "rate-limited", title: "Too many requests" },
  Unavailable: { status: 503, slug: "unavailable", title: "Service unavailable" },
  Internal: { status: 500, slug: "internal", title: "Internal error" },
};

export type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  errors?: { path: string; message: string }[];
  entitlement?: string;
};

/** A stable, domain-independent problem type URI. */
export const problemType = (kind: AppErrorKind | "Internal") => `urn:forge:problem:${PROBLEMS[kind].slug}`;

export function toProblem(error: unknown, requestId?: string): { status: number; headers: Record<string, string>; body: ProblemDetails } {
  const appError = asAppError(error);
  const kind = appError?.kind ?? "Internal";
  const { status, title } = PROBLEMS[kind];
  const body: ProblemDetails = { type: problemType(kind), title, status, ...(requestId ? { instance: requestId } : {}) };
  if (appError) {
    body.detail = appError.message;
    if (appError.fieldErrors) {
      body.errors = Object.entries(appError.fieldErrors).flatMap(([path, messages]) =>
        messages.map((message) => ({ path, message })),
      );
    }
    if (appError.entitlement) body.entitlement = appError.entitlement;
  }
  const headers: Record<string, string> = { "content-type": "application/problem+json" };
  if (appError?.retryAfterSeconds) headers["retry-after"] = String(appError.retryAfterSeconds);
  return { status, headers, body };
}

export function problemResponse(error: unknown, requestId?: string): Response {
  const { status, headers, body } = toProblem(error, requestId);
  return new Response(JSON.stringify(body), { status, headers });
}
