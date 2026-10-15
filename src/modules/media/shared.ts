/** Client-safe exports of the media module: what may be uploaded (M6-1, plan §8). */
export {
  ACCEPTED_LABEL, checkFile, MAX_FILES_PER_REQUEST, responsiveSources, sniffType, UNFINISHED_UPLOAD_HOURS, UPLOAD_TARGET_SECONDS, UPLOAD_TYPES, uploadTypeOf,
} from "./policy";
export type { AcceptedFile, FileRequest, MediaKind, UploadType } from "./policy";
// The picker (M6-4): a client component, for the editor, a post's settings and the site's settings.
export { MediaPicker } from "./ui/media-picker";
export type { PickedImage } from "./ui/media-picker";
