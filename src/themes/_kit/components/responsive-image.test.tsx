import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { responsiveSources } from "@/modules/media/shared";
import { ResponsiveImage } from "./responsive-image";

const base = "https://cms.example.com/media/o/1/s/2/m/3/v1";
const variants = [
  { key: "w1600", width: 1600, height: 1067, storageKey: "o/1/s/2/m/3/v1/w1600/beach.webp" },
  { key: "thumb", width: 400, height: 400, storageKey: "o/1/s/2/m/3/v1/thumb/beach.webp" },
  { key: "w800", width: 800, height: 533, storageKey: "o/1/s/2/m/3/v1/w800/beach.webp" },
  { key: "w2400", width: 2400, height: 1600, storageKey: "o/1/s/2/m/3/v1/w2400/beach.webp" },
  // The site's imagery (M6-4): never a width a page chooses from.
  { key: "logo", width: 360, height: 240, storageKey: "o/1/s/2/m/3/v1/logo/beach.webp" },
  { key: "fav32", width: 32, height: 32, storageKey: "o/1/s/2/m/3/v1/fav32/beach.png" },
  { key: "fav180", width: 180, height: 180, storageKey: "o/1/s/2/m/3/v1/fav180/beach.png" },
];
const urlOf = (key: string) => `https://cms.example.com/media/${key}`;

describe("<ResponsiveImage> (M6-2)", () => {
  it("srcset of every width but the square thumbnail, sizes, intrinsic width and height, lazy", () => {
    const html = renderToStaticMarkup(
      <ResponsiveImage image={{ alt: "The beach at dusk", width: 3000, height: 2000, sources: responsiveSources(variants, urlOf) }} sizes="(min-width: 48rem) 48rem, 100vw" />,
    );
    expect(html).toBe(
      `<img src="${base}/w800/beach.webp" srcSet="${base}/w800/beach.webp 800w, ${base}/w1600/beach.webp 1600w, ${base}/w2400/beach.webp 2400w" ` +
        `sizes="(min-width: 48rem) 48rem, 100vw" width="3000" height="2000" alt="The beach at dusk" loading="lazy" decoding="async"/>`,
    );
  });

  it("a small image: its one width; above the fold: eager, and React preloads it; the alt text escaped", () => {
    const html = renderToStaticMarkup(
      <ResponsiveImage
        image={{ alt: `Logo "A&B" <co>`, width: 300, height: 200, sources: [{ url: `${base}/w300/logo.webp`, width: 300, height: 200 }] }}
        priority
        className="hero"
      />,
    );
    expect(html).toBe(
      `<link rel="preload" as="image" imageSrcSet="${base}/w300/logo.webp 300w" imageSizes="100vw"/>` +
        `<img src="${base}/w300/logo.webp" srcSet="${base}/w300/logo.webp 300w" sizes="100vw" width="300" height="200" alt="Logo &quot;A&amp;B&quot; &lt;co&gt;" loading="eager" decoding="async" class="hero"/>`,
    );
  });

  it("no sources (a missing or trashed item): nothing at all, never a broken image", () => {
    expect(renderToStaticMarkup(<ResponsiveImage image={{ alt: "Gone", width: 10, height: 10, sources: [] }} />)).toBe("");
    expect(renderToStaticMarkup(<ResponsiveImage image={{ alt: "Gone", width: 10, height: 10, sources: responsiveSources([variants[1]!], urlOf) }} />)).toBe("");
  });
});
