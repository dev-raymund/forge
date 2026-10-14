import "server-only";

/**
 * Public storage API (M1-5, ADR 0008). Modules get tenant-scoped storage from
 * `storageFor()`; the raw driver and the providers stay private to platform/.
 */
export { storageFor, storageForUser, platformStorage } from "./scoped";
export type { StorageScope } from "./scoped";
export type { StorageDriver, ObjectInfo, PutOptions, CreateUploadInput, UploadTarget } from "./driver";
export { StorageError, isStorageError, storageErrorToAppError, STORAGE_ERROR_CODES } from "./errors";
export type { StorageErrorCode } from "./errors";
export { avatarObjectKey, mediaObjectKey, organizationPrefix, sitePrefix, userPrefix, isStorageKey, assertStorageKey } from "./keys";
export type { AvatarKeyParts, MediaKeyParts } from "./keys";
export { handleLocalUpload } from "./local-upload";
