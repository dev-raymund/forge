/** One stored width of an image: its public URL (`/media/…`) and its size. */
export type ResponsiveImageSource = { url: string; width: number; height: number };

/** An image as a theme draws it: its alternative text, its intrinsic size, and the widths it is stored at. */
export type ResponsiveImageData = { alt: string; width: number; height: number; sources: readonly ResponsiveImageSource[] };

/** The width a browser that ignores `srcset` gets: the first one of at least this, or the largest. */
const FALLBACK_WIDTH = 800;

/**
 * A responsive `<img>` (M6-2, plan §8): every stored width in `srcset`, the layout's `sizes`, and the intrinsic
 * `width`/`height` so the page does not jump while it loads. The URLs are given (the renderer resolves them from the
 * media item's variants, M6-4); this draws nothing else and decides nothing about them. No sources (a missing or
 * trashed item): nothing at all, never a broken image.
 */
export function ResponsiveImage({
  image, sizes = "100vw", className, priority = false,
}: {
  image: ResponsiveImageData;
  /** How wide the image is drawn, for the browser's choice: e.g. `(min-width: 48rem) 48rem, 100vw`. */
  sizes?: string;
  className?: string;
  /** Above the fold: load at once rather than lazily. */
  priority?: boolean;
}) {
  const sources = [...image.sources].filter((source) => source.width > 0 && source.height > 0).sort((a, b) => a.width - b.width);
  if (sources.length === 0) return null;
  const fallback = sources.find((source) => source.width >= FALLBACK_WIDTH) ?? sources[sources.length - 1]!;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- variants are already sized WebP on the media CDN path; no optimizer in between
    <img
      src={fallback.url}
      srcSet={sources.map((source) => `${source.url} ${source.width}w`).join(", ")}
      sizes={sizes}
      width={image.width}
      height={image.height}
      alt={image.alt}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      className={className}
    />
  );
}
