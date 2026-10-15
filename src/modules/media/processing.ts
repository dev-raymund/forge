import "server-only";
import sharp, { type Metadata } from "sharp";
import { logger } from "@/platform/observability";
import type { UploadMimeType } from "./policy";

/**
 * Image processing (M6-2; plan §8): synchronous, in `completeUpload`, with `sharp`.
 *
 *   decode     only JPEG, PNG, WebP and GIF (the format must be the one the upload was checked as), at most 50
 *              megapixels (`limitInputPixels`; for an animation, all its frames together); anything sharp cannot
 *              decode cleanly is refused (`failOn: "error"`), and so is anything that takes over 30 s
 *   orient     auto-rotated from EXIF, then every piece of metadata dropped (EXIF with GPS, XMP, ICC: sharp keeps
 *              none unless told to)
 *   variants   WebP, quality 75:
 *                thumb  a square of 400 (cropped from the centre; smaller if the image is)
 *                w800, w1600, w2400  each width the image reaches (never above the original)
 *                w{width}  the image's own width, when it is narrower than 800
 *              an animation (GIF, WebP) stays animated in each of these
 *   site       made at upload as well (plan §8 "favicon sizes produced from the image at upload"; M6-4), from the
 *   imagery    first frame, so any library image can become the site's logo or favicon:
 *                logo   WebP (quality 90: sharp edges), fitting inside 640 × 240, never enlarged
 *                fav32, fav180  PNG squares of 32 and 180 (cropped from the centre): the browser icon and the
 *                       Apple touch icon
 *
 * The original is kept as uploaded and never served (its metadata is still in it). Memory: one decode at a time is
 * bounded by the pixel limit (50 MP × 4 bytes ≈ 200 MB), and sharp's operation cache is off so nothing is held
 * between images.
 */

export const MAX_INPUT_PIXELS = 50_000_000;
export const THUMB_SIZE = 400;
export const WIDTH_LADDER = [800, 1600, 2400] as const;
export const WEBP_QUALITY = 75;
export const LOGO_BOX = { width: 640, height: 240 } as const;
export const LOGO_QUALITY = 90;
export const FAVICON_SIZES = [32, 180] as const;
const TIMEOUT_SECONDS = 30;

sharp.cache(false);

/** The file's own fault: it is refused (failed), not retried. */
export class ImageRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRejected";
  }
}

/**
 * One variant to make: its name, its (expected) size, how it is cut (`width`: to this width; `square`: cropped to a
 * square; `inside`: fitted inside the box, never enlarged), its format, and whether it is a still of the first frame.
 */
export type PlannedVariant = { key: string; width: number; height: number; fit: "width" | "square" | "inside"; format: "webp" | "png"; still: boolean };

/** The widths an image is drawn at (`<ResponsiveImage>`): the ladder's `w{n}` variants, not the thumbnail or the site imagery. */
export const isWidthVariant = (key: string) => /^w[1-9][0-9]{0,4}$/.test(key);

/** The variants of an image of this (oriented) size. Pure. */
export function planVariants(width: number, height: number, preset: "media" | "avatar" = "media"): PlannedVariant[] {
  const side = Math.min(THUMB_SIZE, width, height);
  const thumb: PlannedVariant = { key: "thumb", width: side, height: side, fit: "square", format: "webp", still: false };
  if (preset === "avatar") return [thumb];
  const widths = WIDTH_LADDER.filter((w) => w <= width);
  const ladder = (widths.length ? [...widths] : [width]).map((w): PlannedVariant => ({
    key: `w${w}`, width: w, height: Math.max(1, Math.round((height * w) / width)), fit: "width", format: "webp", still: false,
  }));
  const scale = Math.min(1, LOGO_BOX.width / width, LOGO_BOX.height / height);
  const logo: PlannedVariant = {
    key: "logo", width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), fit: "inside", format: "webp", still: true,
  };
  const favicons = FAVICON_SIZES.map((size): PlannedVariant => ({ key: `fav${size}`, width: size, height: size, fit: "square", format: "png", still: true }));
  return [thumb, ...ladder, logo, ...favicons];
}

export type ProcessedVariant = { key: string; width: number; height: number; format: "webp" | "png"; data: Buffer };
export type ProcessedImage = { width: number; height: number; animated: boolean; variants: ProcessedVariant[]; durationMs: number };

const SHARP_FORMATS: Record<string, UploadMimeType> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
const megapixels = (pixels: number) => `${Math.round(pixels / 100_000) / 10} megapixels`;

// p95 of this instance's recent processing times, logged with each one: a hint while there is no metrics store
// (the logs carry every duration, from which the real p95 across instances is computed).
const recent: number[] = [];
function p95(durationMs: number): number {
  recent.push(durationMs);
  if (recent.length > 50) recent.shift();
  const sorted = [...recent].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

/**
 * Decodes, checks and resizes one image. Throws `ImageRejected` for what is wrong with the file (not an allowed
 * format, too many pixels, undecodable, truncated), and anything else for what is wrong here.
 */
export async function processImage(input: Uint8Array, declared: UploadMimeType, options: { preset?: "media" | "avatar"; label?: Record<string, unknown> } = {}): Promise<ProcessedImage> {
  const started = performance.now();
  let meta: Metadata;
  try {
    meta = await sharp(input, { animated: true, limitInputPixels: false }).metadata();
  } catch {
    throw new ImageRejected("could not be read as an image");
  }
  const format = meta.format ? SHARP_FORMATS[meta.format] : undefined;
  if (format !== declared) throw new ImageRejected("is not the kind of image it was sent as");
  const width = meta.width ?? 0;
  const frameHeight = meta.pageHeight ?? meta.height ?? 0;
  const frames = meta.pages ?? 1;
  if (!width || !frameHeight) throw new ImageRejected("could not be read as an image");
  // Checked before anything is decoded: the header says how big it is.
  if (width * frameHeight > MAX_INPUT_PIXELS) throw new ImageRejected(`is ${megapixels(width * frameHeight)}; images can be at most 50`);
  if (width * frameHeight * frames > MAX_INPUT_PIXELS) throw new ImageRejected(`has too many frames at this size (${megapixels(width * frameHeight * frames)} in all; at most 50)`);
  const animated = frames > 1;
  // EXIF orientations 5–8 turn the image a quarter: width and height swap.
  const [w, h] = (meta.orientation ?? 1) >= 5 ? [frameHeight, width] : [width, frameHeight];

  const variants: ProcessedVariant[] = [];
  try {
    for (const plan of planVariants(w, h, options.preset)) {
      const resized = sharp(input, { animated: animated && !plan.still, limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
        .rotate()
        .resize(
          plan.fit === "square"
            ? { width: plan.width, height: plan.height, fit: "cover", position: "centre" }
            : plan.fit === "inside"
              ? { width: LOGO_BOX.width, height: LOGO_BOX.height, fit: "inside", withoutEnlargement: true }
              : { width: plan.width },
        );
      const encoded = plan.format === "png" ? resized.png({ compressionLevel: 9, palette: true }) : resized.webp({ quality: plan.key === "logo" ? LOGO_QUALITY : WEBP_QUALITY });
      const { data, info } = await encoded.timeout({ seconds: TIMEOUT_SECONDS }).toBuffer({ resolveWithObject: true });
      variants.push({ key: plan.key, width: info.width, height: plan.still ? info.height : (info.pageHeight ?? info.height), format: plan.format, data });
    }
  } catch (error) {
    throw new ImageRejected(/timeout/i.test(String((error as Error)?.message)) ? "took too long to process" : "could not be processed as an image");
  }
  const durationMs = Math.round(performance.now() - started);
  logger.info("media image processed", {
    module: "media", ...options.label, durationMs, p95Ms: p95(durationMs), megapixels: Math.round((width * frameHeight) / 100_000) / 10, frames, variants: variants.length,
  });
  return { width: w, height: h, animated, variants, durationMs };
}
