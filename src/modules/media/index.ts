import "server-only";

/**
 * Public server API of the media module.
 *   M6-1  the upload protocol: request → PUT to storage → complete; the daily `uploads.cleanup` (ADR 0020)
 *   M6-2  image processing in `completeUpload`, delivery at /media/{key}, the account avatar (ADR 0021)
 * The library is M6-3's, the picker and the image block M6-4's.
 */
export * from "./shared";
export { completeUpload, requestUploads } from "./upload.service";
export type { IssuedUpload, UploadedMedia, UploadOutcome } from "./upload.service";
export { submitCompleteUpload, submitRequestUploads } from "./upload-requests";
export { cleanUpUploads, uploadsCleanup } from "./cleanup";
export type { UploadsCleanupResult } from "./cleanup";
export { MAX_INPUT_PIXELS, planVariants, processImage, ImageRejected, THUMB_SIZE, WEBP_QUALITY, WIDTH_LADDER } from "./processing";
export type { PlannedVariant, ProcessedImage } from "./processing";
export { PROCESSING_HOLD_SECONDS } from "./upload.service";
export { deliverableObject, DELIVERABLE_TYPES } from "./delivery";
export type { Deliverable } from "./delivery";
export { avatarsCollect, completeAvatarUpload, requestAvatarUpload } from "./avatar.service";
export type { IssuedAvatarUpload } from "./avatar.service";
export { submitCompleteAvatarUpload, submitRequestAvatarUpload } from "./upload-requests";
export { AvatarForm } from "./ui/avatar-form";
