import { AppError, conflict, notFound, unavailable, validationError } from "@/platform/errors";

/**
 * Storage failures, the same for every driver (M1-5, ADR 0008). Messages are
 * written by us: they never carry a provider's raw response, a signed URL or
 * credentials. `providerCode` keeps the provider's short error name or HTTP
 * status for diagnosis.
 */
export const STORAGE_ERROR_CODES = [
  "NotFound",
  "AlreadyExists",
  "InvalidKey",
  "PermissionDenied",
  "Unavailable",
  "UploadFailed",
  "DeleteFailed",
  "ConfigurationError",
] as const;
export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number];

export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    readonly providerCode?: string,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export const isStorageError = (e: unknown, code?: StorageErrorCode): e is StorageError =>
  e instanceof StorageError && (code === undefined || e.code === code);

/**
 * For services and adapters: the application error a storage failure becomes.
 * A key outside the caller's tenant is NotFound, like any other cross-tenant
 * access (long-term §5.6). Infrastructure and configuration faults are
 * Unavailable; report them before mapping.
 */
export function storageErrorToAppError(error: StorageError): AppError {
  switch (error.code) {
    case "NotFound":
    case "PermissionDenied":
      return notFound();
    case "AlreadyExists":
      return conflict("A file already exists at this location.");
    case "InvalidKey":
      return validationError({ key: ["Invalid storage key."] });
    case "Unavailable":
    case "UploadFailed":
    case "DeleteFailed":
    case "ConfigurationError":
      return unavailable(error);
  }
}
