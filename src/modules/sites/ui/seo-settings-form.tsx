"use client";

import { useId, useState } from "react";
import { FormAlert } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { MediaPicker } from "@/modules/media/shared";
import { applyTitleTemplate, SEO_DESCRIPTION_ADVISED, SEO_DESCRIPTION_MAX, TITLE_TEMPLATE_MAX, type SiteSeo } from "@/modules/seo/shared";
import { IDLE } from "@/platform/forms";
import { updateSeoSettingsAction } from "../actions";

/**
 * A site's SEO defaults (M8-4; plan §10, §19 `/…/seo`; ADR 0031): the title template, the default description, the
 * default social image (the media picker, M6-4), "ask search engines not to index", and the Search Console token.
 * What is typed stays here until it is saved; success is shown once the server has answered; errors at their field.
 */

const INPUT =
  "h-10 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-foreground focus-visible:ring-3 focus-visible:ring-foreground/25 aria-invalid:border-destructive md:text-sm";

function Counter({ value, advised, id }: { value: string; advised: number; id: string }) {
  const over = value.length > advised;
  return (
    <span id={id} className={over ? "text-xs font-medium text-amber-800" : "text-xs text-muted-foreground"}>
      {value.length} / {advised}
      {over ? " · longer ones are cut in search results" : ""}
    </span>
  );
}

export function SeoSettingsForm({
  orgSlug, siteSlug, siteName, comingSoon, version, seo, defaultOgImage,
}: {
  orgSlug: string;
  siteSlug: string;
  siteName: string;
  comingSoon: boolean;
  version: number;
  seo: SiteSeo;
  /** The default social image's name and thumbnail, while it is a usable image of the site. */
  defaultOgImage: { name: string; thumbUrl: string | null } | null;
}) {
  const ids = { template: useId(), description: useId(), counter: useId(), token: useId(), discourage: useId() };
  const [saved, setSaved] = useState({ seo, version });
  const [draft, setDraft] = useState<SiteSeo>(seo);
  const [image, setImage] = useState<{ name: string; thumbUrl: string | null } | null>(defaultOgImage);
  const [picking, setPicking] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved.seo);
  const errorOf = (key: string) => errors[key]?.[0];
  const update = (change: Partial<SiteSeo>) => {
    setNotice(null);
    setDraft((current) => ({ ...current, ...change }));
  };

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (pending || !dirty) return;
    setPending(true);
    setNotice(null);
    setErrors({});
    try {
      const data = new FormData();
      data.set("seo", JSON.stringify(draft));
      data.set("version", String(saved.version));
      const result = await updateSeoSettingsAction(orgSlug, siteSlug, IDLE, data);
      if (result.status === "success") {
        setSaved({ seo: draft, version: Number(result.values?.version ?? saved.version) });
        setNotice({ tone: "success", text: result.message ?? "SEO settings saved." });
      } else {
        setErrors(result.fieldErrors ?? {});
        setNotice({ tone: "error", text: result.message ?? "The SEO settings were not saved." });
      }
    } catch {
      setNotice({ tone: "error", text: "The SEO settings were not saved: the connection failed. Your changes are still here; try again." });
    } finally {
      setPending(false);
    }
  }

  const example = draft.titleTemplate.includes("%title%") ? applyTitleTemplate(draft.titleTemplate, { title: "About us", site: siteName }) : null;

  return (
    <form onSubmit={save} className="grid gap-6" aria-label="SEO settings" data-testid="seo-form" noValidate>
      {comingSoon ? (
        <FormAlert tone="info">While the site is Coming soon, every page asks search engines not to index it, whatever these settings say.</FormAlert>
      ) : null}

      <div className="grid gap-1">
        <label htmlFor={ids.template} className="text-sm font-medium">
          Title template
        </label>
        <input
          id={ids.template}
          value={draft.titleTemplate}
          maxLength={TITLE_TEMPLATE_MAX}
          aria-invalid={errorOf("titleTemplate") ? true : undefined}
          aria-describedby={`${ids.template}-hint`}
          onChange={(event) => update({ titleTemplate: event.target.value })}
          className={INPUT}
        />
        <p id={`${ids.template}-hint`} className="text-sm text-muted-foreground">
          Each page&rsquo;s title in search results and browser tabs: %title% is the page&rsquo;s title, %site% the site&rsquo;s name, %sep% a dot. The home page shows the
          site&rsquo;s name. {example ? <span data-testid="seo-title-example">For example: {example}</span> : null}
        </p>
        {errorOf("titleTemplate") ? <p className="text-sm font-medium text-destructive">{errorOf("titleTemplate")}</p> : null}
      </div>

      <div className="grid gap-1">
        <span className="flex items-baseline justify-between gap-2">
          <label htmlFor={ids.description} className="text-sm font-medium">
            Default description
          </label>
          <Counter value={draft.defaultDescription} advised={SEO_DESCRIPTION_ADVISED} id={ids.counter} />
        </span>
        <textarea
          id={ids.description}
          value={draft.defaultDescription}
          maxLength={SEO_DESCRIPTION_MAX}
          rows={3}
          aria-invalid={errorOf("defaultDescription") ? true : undefined}
          aria-describedby={`${ids.description}-hint ${ids.counter}`}
          onChange={(event) => update({ defaultDescription: event.target.value })}
          className={`${INPUT} h-auto py-2`}
        />
        <p id={`${ids.description}-hint`} className="text-sm text-muted-foreground">
          For pages that have no description of their own, no excerpt and no text to take one from: the blog, its archives, the home page.
        </p>
        {errorOf("defaultDescription") ? <p className="text-sm font-medium text-destructive">{errorOf("defaultDescription")}</p> : null}
      </div>

      <div className="grid gap-2" data-testid="seo-default-image">
        <span className="text-sm font-medium">Default social image</span>
        <p className="text-sm text-muted-foreground">Shown when a page is shared, if it has no image of its own and no featured image.</p>
        {draft.defaultOgImageId ? (
          <div className="flex items-center gap-3">
            {image?.thumbUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- the site's own thumbnail variant
              <img src={image.thumbUrl} alt="" width={64} height={64} className="size-16 rounded-md border bg-muted object-cover" data-testid="seo-default-image-preview" />
            ) : null}
            <span className="min-w-0 text-sm wrap-anywhere">{image ? image.name : "This image is no longer in the media library. Pages show no default image."}</span>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">None.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" className="h-10 px-4" onClick={() => setPicking(true)}>
            {draft.defaultOgImageId ? "Change image" : "Choose an image"}
          </Button>
          {draft.defaultOgImageId ? (
            <Button type="button" variant="ghost" className="h-10 px-4" onClick={() => update({ defaultOgImageId: null })}>
              Remove image
            </Button>
          ) : null}
        </div>
        {errorOf("defaultOgImageId") ? <p className="text-sm font-medium text-destructive">{errorOf("defaultOgImageId")}</p> : null}
        <MediaPicker
          orgSlug={orgSlug}
          siteSlug={siteSlug}
          open={picking}
          onOpenChange={setPicking}
          onPick={(picked) => {
            setImage({ name: picked.name || picked.filename, thumbUrl: picked.thumbUrl });
            update({ defaultOgImageId: picked.id });
            setPicking(false);
          }}
          title="Choose a default social image"
          description="An image of this site's media library. Wide images (1200 × 630 or larger) show best."
        />
      </div>

      <div className="grid gap-1">
        <label className="flex items-start gap-2 text-sm">
          <input
            id={ids.discourage}
            type="checkbox"
            checked={draft.discourageIndexing}
            onChange={(event) => update({ discourageIndexing: event.target.checked })}
            className="mt-0.5 size-4"
            aria-describedby={`${ids.discourage}-hint`}
          />
          <span className="font-medium">Ask search engines not to index this site</span>
        </label>
        <p id={`${ids.discourage}-hint`} className="pl-6 text-sm text-muted-foreground">
          Every page says &ldquo;noindex&rdquo;, and the site&rsquo;s sitemap is not offered to search engines. Visitors can still open it.
        </p>
      </div>

      <div className="grid gap-1">
        <label htmlFor={ids.token} className="text-sm font-medium">
          Google Search Console verification
        </label>
        <input
          id={ids.token}
          value={draft.searchConsoleToken}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={errorOf("searchConsoleToken") ? true : undefined}
          aria-describedby={`${ids.token}-hint`}
          onChange={(event) => update({ searchConsoleToken: event.target.value })}
          className={INPUT}
        />
        <p id={`${ids.token}-hint`} className="text-sm text-muted-foreground">
          The token from Search Console&rsquo;s &ldquo;HTML tag&rdquo; method, or the whole &lt;meta&gt; tag: the token is taken out of it.
        </p>
        {errorOf("searchConsoleToken") ? <p className="text-sm font-medium text-destructive">{errorOf("searchConsoleToken")}</p> : null}
      </div>

      <div className="sticky bottom-0 z-10 grid gap-3 border-t bg-background py-3">
        <div aria-live="polite" className="empty:hidden">
          {notice ? <FormAlert tone={notice.tone}>{notice.text}</FormAlert> : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" className="h-10 px-4" disabled={pending || !dirty} aria-busy={pending || undefined}>
            {pending ? "Saving…" : "Save SEO settings"}
          </Button>
          {dirty ? (
            <>
              <span className="text-sm text-muted-foreground" data-testid="seo-unsaved">
                Unsaved changes
              </span>
              <Button
                type="button"
                variant="ghost"
                className="h-10 px-3"
                onClick={() => {
                  setDraft(saved.seo);
                  setErrors({});
                  setNotice(null);
                }}
              >
                Discard changes
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </form>
  );
}
