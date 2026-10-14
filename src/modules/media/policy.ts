/**
 * What may be uploaded (plan §8, M6-1). Pure and client-safe: the server
 * decides with it, and a dropzone (M6-3) may use it to warn before asking.
 *
 *   images     JPEG, PNG, WebP, GIF, at most 20 MB each
 *   documents  PDF, at most 25 MB
 *   nothing else: no SVG, no video, no HTML, no archives
 *
 * The 50-megapixel limit for images needs the image decoded; it is M6-2's
 * (sharp's `limitInputPixels` in `processImage`). A megabyte here is 1024²
 * bytes.
 */

export type MediaKind = "image" | "document";

export type UploadType = { readonly kind: MediaKind; readonly ext: string; readonly maxBytes: number; readonly label: string };

const MB = 1024 * 1024;

export const UPLOAD_TYPES: Readonly<Record<string, UploadType>> = Object.freeze({
  "image/jpeg": { kind: "image", ext: "jpg", maxBytes: 20 * MB, label: "JPEG" },
  "image/png": { kind: "image", ext: "png", maxBytes: 20 * MB, label: "PNG" },
  "image/webp": { kind: "image", ext: "webp", maxBytes: 20 * MB, label: "WebP" },
  "image/gif": { kind: "image", ext: "gif", maxBytes: 20 * MB, label: "GIF" },
  "application/pdf": { kind: "document", ext: "pdf", maxBytes: 25 * MB, label: "PDF" },
});

export type UploadMimeType = keyof typeof UPLOAD_TYPES;

export const uploadTypeOf = (mimeType: string): UploadType | null => (Object.hasOwn(UPLOAD_TYPES, mimeType) ? UPLOAD_TYPES[mimeType]! : null);

/** How long an upload target may be used (plan §8: 10 minutes). */
export const UPLOAD_TARGET_SECONDS = 600;
/** An upload not completed within this many hours is expired by `uploads.cleanup` (plan §8, §16). */
export const UNFINISHED_UPLOAD_HOURS = 24;
/** How much of the start of a file `completeUpload` reads to recognise it (plan §8: the first 4 KB). */
export const SNIFF_BYTES = 4096;
/**
 * How many files one `requestUploads` may ask for. Not a product limit (the plan names none): a bound on one
 * request's work, as every list input has. A dropzone sends more in several requests.
 */
export const MAX_FILES_PER_REQUEST = 20;
/** A file name is display metadata; longer than this is refused rather than cut. */
export const FILENAME_MAX = 255;

export const ACCEPTED_LABEL = "JPEG, PNG, WebP, GIF or PDF";

// ── Recognising a file by its first bytes ─────────────────────────────────────

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((byte, i) => bytes[offset + i] === byte);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/**
 * The allowed type these bytes are, by their signature, or null for anything else. Only the start of the file
 * is looked at: it says what the file claims to be, which must be what it was uploaded as. It is not a check that
 * the whole file is well formed (M6-2 decodes images; a PDF is served as a download-safe document).
 */
export function sniffType(bytes: Uint8Array): UploadMimeType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  if (startsWith(bytes, ascii("%PDF-"))) return "application/pdf";
  return null;
}

// ── File names ────────────────────────────────────────────────────────────────

/**
 * The name to show for an uploaded file: its last path segment (a browser sends only that, but nothing here relies
 * on it), without control characters, trimmed. Null when nothing is left. It never reaches a storage key as typed.
 */
export function displayName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const base = name.split(/[/\\]/).pop() ?? "";
  const clean = base.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "").trim();
  return clean.length ? clean : null;
}

const KEY_NAME_MAX = 60;

/**
 * The file-name part of a storage key (plan §8: `…/{slugified-name}.{ext}`): ASCII letters and digits joined by
 * hyphens, from the display name without its extension, or `file` when nothing of it survives. Only a readable hint
 * in the URL: the key is unique by the media id before it, and the extension comes from the type, not the name.
 */
export function keyNameOf(filename: string): string {
  const stem = filename.replace(/\.[^.]*$/, "");
  const slug = stem
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, KEY_NAME_MAX)
    .replace(/-+$/, "");
  return slug || "file";
}

// ── One file of a request ─────────────────────────────────────────────────────

export type FileRequest = { name: string; size: number; type: string };
export type AcceptedFile = { name: string; size: number; mimeType: UploadMimeType; type: UploadType };

const sizeInWords = (bytes: number) => (bytes >= MB ? `${Number((bytes / MB).toFixed(1))} MB` : bytes >= 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${bytes} bytes`);

/** Checks one file as the browser describes it: what it is called, its size, its type. Returns why not, or the file. */
export function checkFile(input: unknown): { ok: true; file: AcceptedFile } | { ok: false; message: string } {
  const value = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const name = displayName(value.name);
  if (!name) return { ok: false, message: "A file has no name." };
  if (name.length > FILENAME_MAX) return { ok: false, message: `The name of ${name.slice(0, 40)}… is too long. Rename the file and try again.` };
  const mimeType = typeof value.type === "string" ? value.type.trim().toLowerCase() : "";
  const type = uploadTypeOf(mimeType);
  if (!type) return { ok: false, message: `${name} can't be uploaded. Upload ${ACCEPTED_LABEL} files.` };
  const size = value.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return { ok: false, message: `The size of ${name} is not valid.` };
  if (size === 0) return { ok: false, message: `${name} is empty.` };
  if (size > type.maxBytes) {
    return { ok: false, message: `${name} is ${sizeInWords(size)}. ${type.kind === "image" ? "Images" : "PDFs"} can be at most ${sizeInWords(type.maxBytes)}.` };
  }
  return { ok: true, file: { name, size, mimeType: mimeType as UploadMimeType, type } };
}
