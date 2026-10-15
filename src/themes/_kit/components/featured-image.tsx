import { ResponsiveImage, type ResponsiveImageData } from "./responsive-image";

/**
 * A post's featured image (M6-4), above its text: every width it is stored at, the post's column wide on a large
 * screen, eager (it is at the top). Nothing at all when the post has none, or it was trashed.
 */
export function FeaturedImage({ image }: { image?: ResponsiveImageData | null }) {
  if (!image) return null;
  return (
    <figure className="forge-featured-image">
      <ResponsiveImage image={image} sizes="(min-width: 72rem) 72rem, 100vw" priority />
    </figure>
  );
}
