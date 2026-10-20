import { z } from "zod";

/**
 * What a site and an entry may say about themselves to search engines (M8-4; plan §10; ADR 0031). Client-safe.
 *
 *   site   (`site_settings.seo`)   title template, default description, default social image, discourage indexing,
 *                                  Search Console token
 *   entry  (`entry_drafts.seo`, published with the revision)   title, description, canonical, social image,
 *                                  noindex, nofollow
 *
 * Strict schemas for saving; lenient readers (value by value, defaults for the rest) for drawing, so a damaged or
 * older value never breaks a page.
 */

/** What the counters advise (search results cut longer ones), and what is stored at most. */
export const SEO_TITLE_ADVISED = 60;
export const SEO_TITLE_MAX = 120;
export const SEO_DESCRIPTION_ADVISED = 160;
export const SEO_DESCRIPTION_MAX = 320;
export const SEO_CANONICAL_MAX = 2048;
export const TITLE_TEMPLATE_MAX = 120;
export const SEARCH_CONSOLE_TOKEN_MAX = 100;

/** The platform's: `%title% · %site%`, the titles the site has had since M5-6. */
export const TITLE_SEPARATOR = "·";
export const DEFAULT_TITLE_TEMPLATE = "%title% %sep% %site%";
export const TITLE_TOKENS = ["%title%", "%site%", "%sep%"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const imageId = z.string().regex(UUID, "Choose an image of this site.");
const noControl = (value: string) => !/[\u0000-\u001f\u007f]/.test(value);

/** An absolute `https` address with a host and no credentials: the only canonical an entry may name. */
export const absoluteHttps = z
  .string()
  .trim()
  .max(SEO_CANONICAL_MAX, `Use at most ${SEO_CANONICAL_MAX} characters.`)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !!url.hostname && !url.username && !url.password && !/[\s<>"]/.test(value);
    } catch {
      return false;
    }
  }, "Use a full address starting with https://.");

const seoTitle = z.string().trim().max(SEO_TITLE_MAX, `Use at most ${SEO_TITLE_MAX} characters.`).refine(noControl, "Use plain text.");
const seoDescription = z.string().trim().max(SEO_DESCRIPTION_MAX, `Use at most ${SEO_DESCRIPTION_MAX} characters.`).refine(noControl, "Use plain text.");

/** An entry's own SEO, as the editor's SEO tab saves it: empty text and false mean "inherit". */
export const entrySeoSchema = z.strictObject({
  title: seoTitle,
  description: seoDescription,
  canonical: z.union([z.literal(""), absoluteHttps]),
  ogImageId: imageId.nullable(),
  noindex: z.boolean(),
  nofollow: z.boolean(),
});
export type EntrySeo = z.output<typeof entrySeoSchema>;
export const EMPTY_ENTRY_SEO: EntrySeo = { title: "", description: "", canonical: "", ogImageId: null, noindex: false, nofollow: false };

/**
 * A Google Search Console token, or the `<meta name="google-site-verification" content="…">` it is copied as (the
 * token is taken out of it). Letters, digits, `-` and `_` only: nothing that could leave the attribute.
 */
const searchConsoleToken = z.preprocess(
  (value) => (typeof value === "string" ? (value.match(/content\s*=\s*["']([^"']*)["']/i)?.[1] ?? value).trim() : value),
  z
    .string()
    .max(SEARCH_CONSOLE_TOKEN_MAX, `Use at most ${SEARCH_CONSOLE_TOKEN_MAX} characters.`)
    .regex(/^[A-Za-z0-9_-]*$/, "Paste the token Search Console gives you, or its whole meta tag."),
);

/** A title template: text with `%title%` (the page's title), and optionally `%site%` and `%sep%`. */
const titleTemplate = z
  .string()
  .trim()
  .min(1, "Enter a title template, like %title% %sep% %site%.")
  .max(TITLE_TEMPLATE_MAX, `Use at most ${TITLE_TEMPLATE_MAX} characters.`)
  .refine(noControl, "Use plain text.")
  .refine((value) => value.includes("%title%"), "Include %title%: it is where each page's title goes.")
  .refine((value) => (value.match(/%[a-z]+%/g) ?? []).every((token) => (TITLE_TOKENS as readonly string[]).includes(token)), "Use only %title%, %site% and %sep%.");

/** The site's SEO defaults, as `/…/seo` saves them. */
export const siteSeoSchema = z.strictObject({
  titleTemplate,
  defaultDescription: seoDescription,
  defaultOgImageId: imageId.nullable(),
  discourageIndexing: z.boolean(),
  searchConsoleToken,
});
export type SiteSeo = z.output<typeof siteSeoSchema>;
export const SITE_SEO_DEFAULTS: SiteSeo = { titleTemplate: DEFAULT_TITLE_TEMPLATE, defaultDescription: "", defaultOgImageId: null, discourageIndexing: false, searchConsoleToken: "" };

const field = <T>(schema: z.ZodType<T>, stored: unknown, key: string, fallback: T): T => {
  const value = stored && typeof stored === "object" ? (stored as Record<string, unknown>)[key] : undefined;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
};

/** A stored entry SEO value, read value by value. */
export function readEntrySeo(stored: unknown): EntrySeo {
  return {
    title: field(seoTitle, stored, "title", ""),
    description: field(seoDescription, stored, "description", ""),
    canonical: field(z.union([z.literal(""), absoluteHttps]), stored, "canonical", ""),
    ogImageId: field(imageId.nullable(), stored, "ogImageId", null),
    noindex: field(z.boolean(), stored, "noindex", false),
    nofollow: field(z.boolean(), stored, "nofollow", false),
  };
}

/** A stored site SEO value, read value by value. */
export function readSiteSeo(stored: unknown): SiteSeo {
  return {
    titleTemplate: field(titleTemplate, stored, "titleTemplate", DEFAULT_TITLE_TEMPLATE),
    defaultDescription: field(seoDescription, stored, "defaultDescription", ""),
    defaultOgImageId: field(imageId.nullable(), stored, "defaultOgImageId", null),
    discourageIndexing: field(z.boolean(), stored, "discourageIndexing", false),
    searchConsoleToken: field(searchConsoleToken, stored, "searchConsoleToken", ""),
  };
}

/** `%title% %sep% %site%` with its tokens filled; an empty title leaves no stray separator. */
export function applyTitleTemplate(template: string, values: { title: string; site: string }): string {
  const filled = template.replaceAll("%title%", values.title).replaceAll("%site%", values.site).replaceAll("%sep%", TITLE_SEPARATOR);
  return filled
    .replace(/\s+/g, " ")
    .trim()
    .replace(new RegExp(`^(\\s*\\${TITLE_SEPARATOR}\\s*)+|(\\s*\\${TITLE_SEPARATOR}\\s*)+$`, "g"), "")
    .trim();
}
