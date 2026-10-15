"use client";

import { createContext, useContext } from "react";

/**
 * What the editor knows about the images its document holds (M6-4): each one's thumbnail and name, from the server
 * when the editor opened (`getEntryForEditor`) and from the picker when one is chosen. An id it does not know (an
 * image trashed meanwhile, another site's) has no preview: the block says so, and the public page draws nothing.
 *
 * Thumbnails are loaded only after the person asks (`shown`): "Show previews", or choosing an image in the picker
 * they opened. Until then the editor names each image and loads nothing (ADR 0023).
 */
export type ImagePreviewData = { name: string; altText: string; thumbUrl: string | null; width: number | null; height: number | null };
export type ImagePreviewState = { images: Readonly<Record<string, ImagePreviewData>>; shown: boolean; show: () => void };

export const ImagePreviews = createContext<ImagePreviewState>({ images: {}, shown: false, show: () => {} });

export const useImagePreview = (mediaId: unknown): { preview: ImagePreviewData | undefined; shown: boolean; show: () => void } => {
  const { images, shown, show } = useContext(ImagePreviews);
  return { preview: typeof mediaId === "string" && Object.hasOwn(images, mediaId) ? images[mediaId] : undefined, shown, show };
};
