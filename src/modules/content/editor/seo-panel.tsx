"use client";

import { useId, useState } from "react";
import type { ImagePreviewState } from "@/blocks/image/preview-context";
import { Button } from "@/components/ui/button";
import { MediaPicker, type PickedImage } from "@/modules/media/shared";
import {
  absoluteHttps, resolveSeo, SEO_DESCRIPTION_ADVISED, SEO_DESCRIPTION_MAX, SEO_TITLE_ADVISED, SEO_TITLE_MAX, type EntrySeo, type SeoImage, type SeoSource,
} from "@/modules/seo/shared";
import type { EditorEntry } from "../queries";

/**
 * The editor's SEO tab (M8-4; plan §10; ADR 0031): the entry's own title, description, canonical, social image and
 * robots, saved with the draft (autosave) and published with it. Each field shows what it inherits when left empty
 * ("inherited from…"), worked out by the same `resolveSeo()` the public site uses, and the title and description
 * their length against what search results show. saveDraft checks it all again (the canonical, the image).
 */

const CONTROL =
  "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-foreground focus-visible:ring-3 focus-visible:ring-foreground/25 aria-invalid:border-destructive disabled:opacity-60 md:text-sm";

const FROM: Record<SeoSource, string> = {
  entry: "this page's own",
  derived: "the content",
  type: "the content type's title template",
  site: "the site's SEO settings",
  platform: "Forge's default",
};
/** Only its presence matters to the resolver's choice here; the public site resolves the real image. */
const PRESENT: SeoImage = { url: "", width: 0, height: 0, alt: "" };

function Counter({ length, advised, id }: { length: number; advised: number; id: string }) {
  return (
    <span id={id} className={length > advised ? "text-xs font-medium text-amber-800" : "text-xs text-muted-foreground"}>
      {length} / {advised}
    </span>
  );
}

export function EntrySeoPanel({
  orgSlug, siteSlug, entry, own, title, path, isHome, excerpt, featuredMediaId, bodyText, images, editable, onChange, onImagePicked,
}: {
  orgSlug: string;
  siteSlug: string;
  entry: Pick<EditorEntry, "type" | "seo">;
  own: EntrySeo;
  title: string;
  path: string;
  isHome: boolean;
  excerpt: string;
  featuredMediaId: string | null;
  /** The text as it is now, for the description the page would take from it. */
  bodyText: () => string;
  images: ImagePreviewState;
  editable: boolean;
  onChange: (next: EntrySeo) => void;
  onImagePicked?: (image: PickedImage) => void;
}) {
  const ids = { title: useId(), titleCount: useId(), description: useId(), descriptionCount: useId(), canonical: useId(), noindex: useId(), nofollow: useId() };
  const [picking, setPicking] = useState(false);
  const { seo } = entry;
  const baseUrl = seo.baseUrl ?? "";
  const resolve = (with_: EntrySeo) =>
    resolveSeo({
      site: {
        name: seo.site.name, tagline: seo.site.tagline, baseUrl, seo: seo.site.seo, defaultOgImage: seo.site.seo.defaultOgImageId ? PRESENT : null,
        status: seo.site.live ? "live" : "coming_soon",
      },
      page: {
        kind: "entry", path, title: title || "Untitled", isHome, contentType: entry.type, typeTitleTemplate: seo.typeTitleTemplate ?? undefined,
        excerpt: entry.type === "post" ? excerpt : undefined, bodyText: bodyText(), featuredImage: featuredMediaId && entry.type === "post" ? PRESENT : null,
        entrySeo: with_, entryOgImage: with_.ogImageId ? PRESENT : null,
      },
      flags: { preview: false, indexingAllowed: seo.indexingAllowed },
    });
  const resolved = resolve(own);
  const inherited = resolve({ ...own, title: "", description: "", canonical: "", ogImageId: null });
  const canonicalError = own.canonical && !absoluteHttps.safeParse(own.canonical).success ? "Use a full address starting with https://." : null;
  const set = (change: Partial<EntrySeo>) => onChange({ ...own, ...change });
  const preview = (id: string | null) => (id ? images.images[id] : undefined);
  const ownImage = preview(own.ogImageId);

  const imageFrom =
    inherited.image.source === "derived" ? "the featured image" : inherited.image.source === "site" ? "the site's default social image" : null;
  const descriptionFrom =
    inherited.description.source === "derived"
      ? entry.type === "post" && excerpt.trim()
        ? "the excerpt"
        : "the first words of the text"
      : inherited.description.source === "site"
        ? "the site's default description"
        : inherited.description.source === "platform"
          ? "the site's tagline"
          : null;

  return (
    <div className="grid gap-5" data-testid="entry-seo">
      <div className="grid gap-1 rounded-lg border bg-muted/40 p-3" data-testid="seo-preview" aria-label="How it may look in search results">
        <span className="text-xs text-muted-foreground wrap-anywhere">{resolved.canonical.value || "This page's address"}</span>
        <span className="text-sm font-medium text-blue-900 wrap-anywhere">{resolved.title.value}</span>
        <span className="text-xs text-muted-foreground wrap-anywhere">{resolved.description.value || "No description: search engines choose one."}</span>
      </div>

      <div className="grid gap-1">
        <span className="flex items-baseline justify-between gap-2">
          <label htmlFor={ids.title} className="text-sm font-medium">
            SEO title
          </label>
          <Counter length={resolved.title.value.length} advised={SEO_TITLE_ADVISED} id={ids.titleCount} />
        </span>
        <input
          id={ids.title}
          value={own.title}
          maxLength={SEO_TITLE_MAX}
          placeholder={inherited.title.value}
          disabled={!editable}
          aria-describedby={`${ids.title}-hint ${ids.titleCount}`}
          onChange={(event) => set({ title: event.target.value })}
          className={`h-10 ${CONTROL}`}
        />
        <p id={`${ids.title}-hint`} className="text-xs text-muted-foreground" data-testid="seo-title-hint">
          {own.title ? "This page's own title, as it is." : `Inherited from ${FROM[inherited.title.source]}${isHome ? " (the home page shows the site's name)" : ""}.`}
        </p>
      </div>

      <div className="grid gap-1">
        <span className="flex items-baseline justify-between gap-2">
          <label htmlFor={ids.description} className="text-sm font-medium">
            Description
          </label>
          <Counter length={resolved.description.value.length} advised={SEO_DESCRIPTION_ADVISED} id={ids.descriptionCount} />
        </span>
        <textarea
          id={ids.description}
          value={own.description}
          maxLength={SEO_DESCRIPTION_MAX}
          rows={3}
          placeholder={inherited.description.value}
          disabled={!editable}
          aria-describedby={`${ids.description}-hint ${ids.descriptionCount}`}
          onChange={(event) => set({ description: event.target.value })}
          className={`py-2 ${CONTROL}`}
        />
        <p id={`${ids.description}-hint`} className="text-xs text-muted-foreground" data-testid="seo-description-hint">
          {own.description ? "This page's own description." : descriptionFrom ? `Inherited from ${descriptionFrom}.` : "None: search engines choose one from the page."}
        </p>
      </div>

      <div className="grid gap-1">
        <label htmlFor={ids.canonical} className="text-sm font-medium">
          Canonical address
        </label>
        <input
          id={ids.canonical}
          value={own.canonical}
          placeholder={inherited.canonical.value}
          disabled={!editable}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={canonicalError ? true : undefined}
          aria-describedby={`${ids.canonical}-hint`}
          onChange={(event) => set({ canonical: event.target.value.trim() })}
          className={`h-10 ${CONTROL}`}
        />
        <p id={`${ids.canonical}-hint`} className={canonicalError ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"} role={canonicalError ? "alert" : undefined}>
          {canonicalError ?? "Empty: this page's own address. Name another (https://…) only if this page repeats one published elsewhere."}
        </p>
      </div>

      <div className="grid gap-2" data-testid="seo-image">
        <span className="text-sm font-medium">Social image</span>
        {own.ogImageId ? (
          <div className="flex items-center gap-3">
            {ownImage?.thumbUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- the site's own thumbnail variant
              <img src={ownImage.thumbUrl} alt="" width={56} height={56} className="size-14 rounded-md border bg-muted object-cover" data-testid="seo-image-preview" />
            ) : null}
            <span className="min-w-0 text-sm wrap-anywhere">{ownImage ? ownImage.name : "This image is no longer usable: the page shows the one it inherits."}</span>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="seo-image-hint">
            {imageFrom ? `Inherited from ${imageFrom}.` : "None: links to this page are shared without an image."}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" className="h-9 px-3" disabled={!editable} onClick={() => setPicking(true)}>
            {own.ogImageId ? "Change image" : "Choose an image"}
          </Button>
          {own.ogImageId ? (
            <Button type="button" variant="ghost" className="h-9 px-3" disabled={!editable} onClick={() => set({ ogImageId: null })}>
              Remove image
            </Button>
          ) : null}
        </div>
        <MediaPicker
          orgSlug={orgSlug}
          siteSlug={siteSlug}
          open={picking}
          onOpenChange={setPicking}
          onPick={(picked) => {
            onImagePicked?.(picked);
            set({ ogImageId: picked.id });
            setPicking(false);
          }}
          title="Choose a social image"
          description="Shown when this page is shared. Wide images (1200 × 630 or larger) show best."
        />
      </div>

      <fieldset className="grid gap-1.5">
        <legend className="mb-1 text-sm font-medium">Search engines</legend>
        <label className="flex items-center gap-2 text-sm">
          <input id={ids.noindex} type="checkbox" className="size-4" checked={own.noindex} disabled={!editable} onChange={(event) => set({ noindex: event.target.checked })} />
          Don&rsquo;t show this page in search results (noindex)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input id={ids.nofollow} type="checkbox" className="size-4" checked={own.nofollow} disabled={!editable} onChange={(event) => set({ nofollow: event.target.checked })} />
          Don&rsquo;t follow its links (nofollow)
        </label>
        <ul className="grid gap-1 text-xs text-muted-foreground" data-testid="seo-robots-notes">
          {!seo.site.live ? <li>The site is Coming soon: no page is indexed until it is live.</li> : null}
          {seo.site.seo.discourageIndexing ? <li>The site asks search engines not to index it (its SEO settings).</li> : null}
          {!seo.indexingAllowed ? <li>This deployment is not production: no site it serves is indexed.</li> : null}
          {resolved.robots.index ? <li>Search engines may show this page.</li> : null}
        </ul>
      </fieldset>
    </div>
  );
}
