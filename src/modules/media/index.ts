import "server-only";

/**
 * Public server API of the media module.
 *   M6-1  the upload protocol: request → PUT to storage → complete; the daily `uploads.cleanup` (ADR 0020)
 *   M6-2  image processing in `completeUpload`, delivery at /media/{key}, the account avatar (ADR 0021)
 *   M6-3  the library: dropzone, folders, search, the drawer, the trash and `trash.purge` (ADR 0022)
 *   M6-4  images everywhere: the picker, the image block's data, featured images, the logo and favicon (ADR 0023)
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
export {
  canManageFolders, canSeeLibrary, createFolder, deleteFolder, FOLDER_NAME_MAX, listLibrary, MEDIA_ALT_MAX, MEDIA_CAPTION_MAX, MEDIA_TITLE_MAX, MOVE_MAX, moveMedia,
  renameFolder, restoreMedia, trashMedia, updateMediaDetails,
} from "./library.service";
export type { Library, LibraryFolder, LibraryItem } from "./library.service";
export { LIBRARY_PAGE_SIZE, libraryHref, parseLibraryQuery } from "./library-query";
export type { LibraryQuery } from "./library-query";
export {
  mediaLibraryPath, submitCreateFolder, submitDeleteFolder, submitMoveMedia, submitRenameFolder, submitRestoreMedia, submitTrashMedia, submitUpdateMedia,
} from "./library-forms";
export { purgeTrashedMedia, TRASH_DAYS, trashPurge } from "./purge";
export type { TrashPurgeResult } from "./purge";
export { MediaLibrary } from "./ui/media-library";
export { imagePreviews, publicImages, siteImageRefusal, siteImagery, usableImageIds } from "./images";
export type { ImagePreview, PublicImage, SiteImagery } from "./images";
export { FAVICON_SIZES, isWidthVariant, LOGO_BOX } from "./processing";
