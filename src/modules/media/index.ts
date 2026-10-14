import "server-only";

/**
 * Public server API of the media module.
 *   M6-1  the upload protocol: request → PUT to storage → complete; the daily `uploads.cleanup` (ADR 0020)
 * Processing and delivery are M6-2's, the library M6-3's, the picker and the image block M6-4's.
 */
export * from "./shared";
export { completeUpload, requestUploads } from "./upload.service";
export type { IssuedUpload, UploadedMedia, UploadOutcome } from "./upload.service";
export { submitCompleteUpload, submitRequestUploads } from "./upload-requests";
export { cleanUpUploads, uploadsCleanup } from "./cleanup";
export type { UploadsCleanupResult } from "./cleanup";
