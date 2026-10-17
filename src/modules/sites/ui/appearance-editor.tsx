"use client";

import { ExternalLink } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { FormAlert } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { IDLE } from "@/platform/forms";
import { PREVIEW_FRAME_SANDBOX } from "@/platform/routing/preview-frame";
import { FONT_CHOICES } from "@/themes/_kit/font-choices";
import { contrastWarnings, CORNER_RADII, type FooterVariant, type HeaderVariant, type KitSettings } from "@/themes/_kit/tokens";
import { appearancePreviewAction, updateAppearanceAction } from "../actions";

/**
 * The appearance editor (M8-1; plan §7; ADR 0028), below the theme picker: the site's colours (with a contrast warning),
 * fonts, header, footer and layout, and a live preview of what is not saved yet.
 *
 * What the person changes stays here, marked "Unsaved changes", until they save it or discard it. Saving sends every
 * group (the server's schema wants them all, and refuses anything it does not know); success is shown only once the
 * server has answered. The preview is the site's home page drawn with the unsaved settings, through a 15-minute
 * preview token that carries them (ADR 0027's route): it saves nothing.
 */

type Draft = {
  colors: Record<"primary" | "accent" | "background" | "text", string>;
  fonts: KitSettings["tokens"]["fonts"];
  header: { variant: HeaderVariant; sticky: boolean; cta: boolean; ctaLabel: string; ctaHref: string };
  footer: KitSettings["footer"];
  layout: KitSettings["layout"];
};

const draftOf = (settings: KitSettings): Draft => ({
  colors: { ...settings.tokens.colors },
  fonts: { ...settings.tokens.fonts },
  header: { variant: settings.header.variant, sticky: settings.header.sticky, cta: settings.header.cta !== null, ctaLabel: settings.header.cta?.label ?? "", ctaHref: settings.header.cta?.href ?? "" },
  footer: { ...settings.footer },
  layout: { ...settings.layout },
});

/** What is sent: the kit's settings, whole. */
const settingsOf = (draft: Draft) => ({
  tokens: { colors: draft.colors, fonts: draft.fonts },
  header: { variant: draft.header.variant, sticky: draft.header.sticky, cta: draft.header.cta ? { label: draft.header.ctaLabel, href: draft.header.ctaHref } : null },
  footer: draft.footer,
  layout: draft.layout,
});

const HEX = /^#[0-9a-fA-F]{6}$/;
const COLOR_FIELDS = [
  { key: "primary", label: "Primary", hint: "Buttons, links and highlights." },
  { key: "accent", label: "Accent", hint: "Labels and secondary highlights." },
  { key: "background", label: "Background", hint: "The page behind everything." },
  { key: "text", label: "Text", hint: "Headings and body text." },
] as const;
const HEADER_WORDS: Record<HeaderVariant, { label: string; hint: string }> = {
  classic: { label: "Classic", hint: "The name on the left, the menu and button on the right." },
  centered: { label: "Centred", hint: "The name and tagline centred, the menu and button under them." },
  minimal: { label: "Minimal", hint: "A slim bar; the button is a plain link." },
};
const FOOTER_WORDS: Record<FooterVariant, { label: string; hint: string }> = {
  simple: { label: "Simple", hint: "One line: name and copyright, menu, social links." },
  columns: { label: "Columns", hint: "Three columns: name and copyright, menu, social links." },
};
const WIDTHS = [
  { value: "narrow", label: "Narrow" },
  { value: "normal", label: "Normal" },
  { value: "wide", label: "Wide" },
] as const;
const DENSITIES = [
  { value: "compact", label: "Compact" },
  { value: "normal", label: "Normal" },
  { value: "relaxed", label: "Relaxed" },
] as const;
const RADIUS_WORDS: Record<(typeof CORNER_RADII)[number], string> = { none: "None (square)", small: "Small", medium: "Medium", large: "Large" };

const INPUT =
  "h-10 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-foreground focus-visible:ring-3 focus-visible:ring-foreground/25 aria-invalid:border-destructive md:text-sm";

type Preview = { state: "idle" | "loading" } | { state: "ready"; path: string } | { state: "error"; text: string };

export function AppearanceEditor({
  orgSlug, siteSlug, themeName, settings, version, variants,
}: {
  orgSlug: string;
  siteSlug: string;
  themeName: string;
  settings: KitSettings;
  version: number;
  variants: { header: readonly HeaderVariant[]; footer: readonly FooterVariant[] };
}) {
  const ids = { heading: useId(), body: useId(), ctaLabel: useId(), ctaHref: useId(), copyright: useId(), radius: useId() };
  const [saved, setSaved] = useState<{ draft: Draft; version: number }>(() => ({ draft: draftOf(settings), version }));
  const [draft, setDraft] = useState<Draft>(() => draftOf(settings));
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [preview, setPreview] = useState<Preview>({ state: "idle" });
  const asked = useRef(0);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved.draft);
  const colorsValid = COLOR_FIELDS.every(({ key }) => HEX.test(draft.colors[key]));
  const warnings = colorsValid ? contrastWarnings(draft.colors) : [];
  const ctaIncomplete = draft.header.cta && (!draft.header.ctaLabel.trim() || !draft.header.ctaHref.trim());
  const sendable = colorsValid && !ctaIncomplete;
  const errorOf = (path: string) => errors[path]?.[0];
  const update = (change: (current: Draft) => Draft) => {
    setNotice(null);
    setDraft(change);
  };

  // The live preview: the unsaved settings, drawn by the site's theme, a moment after the last change.
  const previewKey = JSON.stringify(settingsOf(draft));
  useEffect(() => {
    if (!sendable) return;
    const ask = ++asked.current;
    const timer = setTimeout(async () => {
      setPreview({ state: "loading" });
      try {
        const data = new FormData();
        data.set("settings", previewKey);
        const result = await appearancePreviewAction(orgSlug, siteSlug, data);
        if (ask !== asked.current) return; // a newer change asked again meanwhile
        setPreview(result.ok ? { state: "ready", path: result.data.path } : { state: "error", text: Object.values(result.fieldErrors ?? {}).flat()[0] ?? result.error });
      } catch {
        if (ask === asked.current) setPreview({ state: "error", text: "The preview could not be updated: the connection failed." });
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [previewKey, sendable, orgSlug, siteSlug]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (pending || !sendable) return;
    setPending(true);
    setNotice(null);
    setErrors({});
    try {
      const data = new FormData();
      data.set("settings", JSON.stringify(settingsOf(draft)));
      data.set("version", String(saved.version));
      const result = await updateAppearanceAction(orgSlug, siteSlug, IDLE, data);
      if (result.status === "success") {
        setSaved({ draft, version: Number(result.values?.version ?? saved.version) });
        setNotice({ tone: "success", text: result.message ?? "Appearance saved." });
      } else {
        setErrors(result.fieldErrors ?? {});
        setNotice({ tone: "error", text: result.message ?? "The appearance was not saved." });
      }
    } catch {
      setNotice({ tone: "error", text: "The appearance was not saved: the connection failed. Your changes are still here; try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] xl:items-start">
      <form onSubmit={save} className="grid gap-6" aria-label="Appearance settings" data-testid="appearance-form" noValidate>
        <fieldset className="grid gap-3">
          <legend className="mb-1 text-base font-semibold">Colours</legend>
          {COLOR_FIELDS.map(({ key, label, hint }) => {
            const value = draft.colors[key];
            const error = errorOf(`tokens.colors.${key}`) ?? (HEX.test(value) ? undefined : "Use a colour like #1d4ed8.");
            return (
              <div key={key} className="grid gap-1">
                <label htmlFor={`color-${key}`} className="text-sm font-medium">
                  {label} <span className="font-normal text-muted-foreground">· {hint}</span>
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={`${label} colour picker`}
                    value={HEX.test(value) ? value.toLowerCase() : "#000000"}
                    onChange={(event) => update((current) => ({ ...current, colors: { ...current.colors, [key]: event.target.value } }))}
                    className="size-10 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-1"
                  />
                  <input
                    id={`color-${key}`}
                    value={value}
                    maxLength={7}
                    spellCheck={false}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `color-${key}-error` : undefined}
                    onChange={(event) => update((current) => ({ ...current, colors: { ...current.colors, [key]: event.target.value.trim() } }))}
                    className={`${INPUT} font-mono`}
                  />
                </div>
                {error ? (
                  <p id={`color-${key}-error`} className="text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
              </div>
            );
          })}
          <div aria-live="polite" className="grid gap-2 empty:hidden" data-testid="contrast-warnings">
            {warnings.map((warning) => (
              <p key={warning.pair} className="rounded-lg border border-amber-700/30 bg-amber-50 px-3 py-2 text-sm text-amber-950" data-testid="contrast-warning">
                {warning.message}
              </p>
            ))}
          </div>
        </fieldset>

        <fieldset className="grid gap-3">
          <legend className="mb-1 text-base font-semibold">Fonts</legend>
          {(["heading", "body"] as const).map((which) => (
            <div key={which} className="grid gap-1">
              <label htmlFor={ids[which]} className="text-sm font-medium">
                {which === "heading" ? "Headings" : "Body text"}
              </label>
              <select
                id={ids[which]}
                value={draft.fonts[which]}
                onChange={(event) => update((current) => ({ ...current, fonts: { ...current.fonts, [which]: event.target.value as Draft["fonts"]["heading"] } }))}
                className={INPUT}
              >
                {(["sans", "serif"] as const).map((kind) => (
                  <optgroup key={kind} label={kind === "sans" ? "Sans serif" : "Serif"}>
                    {FONT_CHOICES.filter((font) => font.kind === kind).map((font) => (
                      <option key={font.key} value={font.key}>
                        {font.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          ))}
        </fieldset>

        <fieldset className="grid gap-3">
          <legend className="mb-1 text-base font-semibold">Header</legend>
          <Choices
            name="header-variant"
            legend="Style"
            value={draft.header.variant}
            options={variants.header.map((variant) => ({ value: variant, ...HEADER_WORDS[variant] }))}
            note={variants.header.length === 1 ? `${themeName} has one header style.` : undefined}
            onChange={(variant) => update((current) => ({ ...current, header: { ...current.header, variant } }))}
          />
          <Check label="Stay at the top while scrolling" checked={draft.header.sticky} onChange={(sticky) => update((current) => ({ ...current, header: { ...current.header, sticky } }))} />
          <Check label="Show a button (a call to action)" checked={draft.header.cta} onChange={(cta) => update((current) => ({ ...current, header: { ...current.header, cta } }))} />
          {draft.header.cta ? (
            <div className="grid gap-3 border-l-2 pl-3">
              <div className="grid gap-1">
                <label htmlFor={ids.ctaLabel} className="text-sm font-medium">
                  Button label
                </label>
                <input
                  id={ids.ctaLabel}
                  value={draft.header.ctaLabel}
                  maxLength={40}
                  placeholder="Book a visit"
                  aria-invalid={errorOf("header.cta.label") || !draft.header.ctaLabel.trim() ? true : undefined}
                  onChange={(event) => update((current) => ({ ...current, header: { ...current.header, ctaLabel: event.target.value } }))}
                  className={INPUT}
                />
                {errorOf("header.cta.label") ? <p className="text-sm text-destructive">{errorOf("header.cta.label")}</p> : null}
              </div>
              <div className="grid gap-1">
                <label htmlFor={ids.ctaHref} className="text-sm font-medium">
                  Button link
                </label>
                <input
                  id={ids.ctaHref}
                  value={draft.header.ctaHref}
                  maxLength={500}
                  placeholder="/contact or https://…"
                  aria-invalid={errorOf("header.cta.href") || !draft.header.ctaHref.trim() ? true : undefined}
                  aria-describedby={`${ids.ctaHref}-hint`}
                  onChange={(event) => update((current) => ({ ...current, header: { ...current.header, ctaHref: event.target.value } }))}
                  className={INPUT}
                />
                <p id={`${ids.ctaHref}-hint`} className={errorOf("header.cta.href") ? "text-sm text-destructive" : "text-xs text-muted-foreground"}>
                  {errorOf("header.cta.href") ?? "A page of the site, like /contact, or a full address starting with https://."}
                </p>
              </div>
            </div>
          ) : null}
        </fieldset>

        <fieldset className="grid gap-3">
          <legend className="mb-1 text-base font-semibold">Footer</legend>
          <Choices
            name="footer-variant"
            legend="Style"
            value={draft.footer.variant}
            options={variants.footer.map((variant) => ({ value: variant, ...FOOTER_WORDS[variant] }))}
            note={variants.footer.length === 1 ? `${themeName} has one footer style.` : undefined}
            onChange={(variant) => update((current) => ({ ...current, footer: { ...current.footer, variant } }))}
          />
          <div className="grid gap-1">
            <label htmlFor={ids.copyright} className="text-sm font-medium">
              Copyright line <span className="font-normal text-muted-foreground">· after “© {"{"}site name{"}"}”, optional</span>
            </label>
            <input
              id={ids.copyright}
              value={draft.footer.copyright}
              maxLength={200}
              placeholder="All rights reserved"
              aria-invalid={errorOf("footer.copyright") ? true : undefined}
              onChange={(event) => update((current) => ({ ...current, footer: { ...current.footer, copyright: event.target.value } }))}
              className={INPUT}
            />
            {errorOf("footer.copyright") ? <p className="text-sm text-destructive">{errorOf("footer.copyright")}</p> : null}
          </div>
          <Check
            label="Show the site’s social links"
            hint="The links themselves are in the site’s settings."
            checked={draft.footer.showSocial}
            onChange={(showSocial) => update((current) => ({ ...current, footer: { ...current.footer, showSocial } }))}
          />
        </fieldset>

        <fieldset className="grid gap-3">
          <legend className="mb-1 text-base font-semibold">Layout</legend>
          <Choices
            name="layout-width"
            legend="Content width"
            value={draft.layout.width}
            options={WIDTHS.map((width) => ({ ...width }))}
            inline
            onChange={(width) => update((current) => ({ ...current, layout: { ...current.layout, width } }))}
          />
          <div className="grid gap-1">
            <label htmlFor={ids.radius} className="text-sm font-medium">
              Corners
            </label>
            <select
              id={ids.radius}
              value={draft.layout.radius}
              onChange={(event) => update((current) => ({ ...current, layout: { ...current.layout, radius: event.target.value as Draft["layout"]["radius"] } }))}
              className={INPUT}
            >
              {CORNER_RADII.map((radius) => (
                <option key={radius} value={radius}>
                  {RADIUS_WORDS[radius]}
                </option>
              ))}
            </select>
          </div>
          <Choices
            name="layout-density"
            legend="Spacing"
            value={draft.layout.density}
            options={DENSITIES.map((density) => ({ ...density }))}
            inline
            onChange={(density) => update((current) => ({ ...current, layout: { ...current.layout, density } }))}
          />
        </fieldset>

        <div className="sticky bottom-0 z-10 grid gap-3 border-t bg-background py-3">
          <div aria-live="polite" className="empty:hidden">
            {notice ? <FormAlert tone={notice.tone}>{notice.text}</FormAlert> : null}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" className="h-10 px-4" disabled={pending || !dirty || !sendable} aria-busy={pending || undefined}>
              {pending ? "Saving…" : "Save appearance"}
            </Button>
            {dirty ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  className="h-10 px-4"
                  disabled={pending}
                  onClick={() => {
                    setDraft(saved.draft);
                    setErrors({});
                    setNotice(null);
                  }}
                >
                  Discard changes
                </Button>
                <span className="text-sm text-muted-foreground" data-testid="appearance-unsaved">
                  Unsaved changes
                </span>
              </>
            ) : null}
          </div>
        </div>
      </form>

      <section aria-label="Live preview" className="grid gap-2 xl:sticky xl:top-4" data-testid="appearance-preview">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Live preview</h2>
          <span role="status" className="text-sm text-muted-foreground">
            {!sendable ? "Fix the highlighted settings to update the preview." : preview.state === "loading" || preview.state === "idle" ? "Updating…" : dirty ? "With your unsaved changes" : "As saved"}
          </span>
        </div>
        {preview.state === "error" ? <FormAlert tone="error">{preview.text}</FormAlert> : null}
        {preview.state === "ready" ? (
          <>
            <iframe
              src={preview.path}
              title="Live preview of the site's home page"
              data-testid="appearance-preview-frame"
              sandbox={PREVIEW_FRAME_SANDBOX}
              referrerPolicy="no-referrer"
              className="h-[70dvh] w-full rounded-lg border bg-white"
            />
            <p className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>The site&rsquo;s home page. The preview link works for 15 minutes, for you only.</span>
              <a href={preview.path} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4">
                Open in a new tab
                <ExternalLink aria-hidden="true" className="size-3.5" />
              </a>
            </p>
          </>
        ) : null}
      </section>
    </div>
  );
}

function Choices<T extends string>({
  name, legend, value, options, note, inline, onChange,
}: {
  name: string;
  legend: string;
  value: T;
  options: { value: T; label: string; hint?: string }[];
  note?: string;
  inline?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <div className={inline ? "flex flex-wrap gap-2" : "grid gap-2"}>
        {options.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm has-checked:border-foreground has-checked:ring-2 has-checked:ring-foreground/15 has-focus-visible:ring-3 has-focus-visible:ring-foreground/40"
          >
            <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} className="mt-0.5" />
            <span className="grid">
              <span className="font-medium">{option.label}</span>
              {option.hint ? <span className="text-muted-foreground">{option.hint}</span> : null}
            </span>
          </label>
        ))}
      </div>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </fieldset>
  );
}

function Check({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 size-4" />
      <span className="grid">
        <span className="font-medium">{label}</span>
        {hint ? <span className="text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}
