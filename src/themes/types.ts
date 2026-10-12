import type { ComponentType, ReactNode } from "react";
import type { z } from "zod";
import type { FooterVariant, HeaderVariant, KitSettings } from "./_kit/tokens";

/**
 * The contracts between themes and the rest of Forge (plan §7, ADR 0012).
 *
 * A theme is code in this repository: a definition (what the admin and the
 * settings validation need, ./registry.ts) and a manifest (that, plus the
 * React components the public renderer draws with, ./render.ts). Tenants
 * choose a theme and set its settings; they never supply code (D-25).
 */

/** What every theme must say about itself. Pure data: the admin's picker and the settings validation read only this. */
export type ThemeDefinition<K extends string = string> = {
  /** Stable: stored in `sites.theme_key`. */
  readonly key: K;
  readonly name: string;
  readonly description: string;
  /** The theme's own settings version, for a future `migrateSettings` (plan §7). */
  readonly version: number;
  /** The kit-level settings a site of this theme starts with. What the site has saved overrides them, value by value. */
  readonly defaults: KitSettings;
  /** The theme's own extra settings (`site_settings.theme.options[key]`). Strict: unknown keys are refused. */
  readonly options: z.ZodType<Record<string, unknown>>;
  /** The header and footer variants it draws. A saved variant it does not have falls back to the first. */
  readonly headerVariants: readonly [HeaderVariant, ...HeaderVariant[]];
  readonly footerVariants: readonly [FooterVariant, ...FooterVariant[]];
  /** How the picker sketches it: a business site or a publication. */
  readonly preview: "business" | "editorial";
};

/**
 * The templates every theme has (plan §7): M4-4's page, coming-soon and not-found, and M5-6's two other page
 * templates, the post, the blog index and the term archive. A theme may draw some with the kit's defaults
 * (`_kit/templates/`): Journal does for the blog's until M8-2 designs its own.
 */
export const TEMPLATE_KEYS = ["page", "page-full-width", "page-landing", "post", "blog-index", "term-archive", "coming-soon", "not-found"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

/**
 * The page templates an author may choose for a page (`entry_drafts.template`, M5-7's sidebar): the stored key and
 * the template it draws with. Null, or a key no theme has, is the default page template.
 */
export const PAGE_TEMPLATES = { default: "page", "full-width": "page-full-width", landing: "page-landing" } as const satisfies Record<string, TemplateKey>;
export type PageTemplateChoice = keyof typeof PAGE_TEMPLATES;

export function pageTemplateKey(stored: string | null | undefined): (typeof PAGE_TEMPLATES)[PageTemplateChoice] {
  return stored && Object.hasOwn(PAGE_TEMPLATES, stored) ? PAGE_TEMPLATES[stored as PageTemplateChoice] : "page";
}

/** A link in a menu. Menus arrive in M8-3; until then the lists are empty. */
export type NavItem = { readonly label: string; readonly href: string };

/**
 * Everything a theme may know when it draws a page, handed to it by the
 * renderer. Public data only: no session, no member, no organization id, no
 * database handle. Links are built from `basePath` (`/s/{address}` in V1, ""
 * on a site's own host later, ADR 0006).
 */
export type ThemeContext = {
  readonly site: {
    readonly name: string;
    readonly tagline: string;
    readonly language: string;
    readonly basePath: string;
    /** The site's social links (M4-2), already validated as `https` addresses. Drawn when `settings.footer.showSocial`. */
    readonly social: readonly NavItem[];
  };
  /** The site's settings for this theme, already read through the schema (./_kit/tokens.ts `readThemeSettings`). */
  readonly settings: KitSettings;
  readonly options: Readonly<Record<string, unknown>>;
  readonly menus: { readonly header: readonly NavItem[]; readonly footer: readonly NavItem[] };
};

/** A date as the site shows it: machine-readable for `<time dateTime>`, and written in the site's language and time zone. */
export type DateLabel = { readonly iso: string; readonly label: string };

/** A post in a list: its address is already the public one (with the site's base). */
export type PostCard = { readonly title: string; readonly href: string; readonly excerpt: string; readonly date: DateLabel | null };

/** Where a list is: page `page` of `pages`, and the neighbouring pages' addresses. */
export type Pagination = { readonly page: number; readonly pages: number; readonly previousHref?: string; readonly nextHref?: string };

export type TermLink = { readonly taxonomy: "category" | "tag"; readonly name: string; readonly href: string };

type PageProps = { context: ThemeContext; title: string; children?: ReactNode };

/** Every template's props. Content arrives rendered (`children`): a theme draws the frame around it, never the document itself. */
export type TemplateProps = {
  page: PageProps;
  "page-full-width": PageProps;
  "page-landing": PageProps;
  post: { context: ThemeContext; title: string; date: DateLabel | null; terms: readonly TermLink[]; blogHref: string; children?: ReactNode };
  "blog-index": { context: ThemeContext; title: string; posts: readonly PostCard[]; pagination: Pagination };
  "term-archive": {
    context: ThemeContext; taxonomy: "category" | "tag"; name: string; description: string; blogHref: string; posts: readonly PostCard[]; pagination: Pagination;
  };
  "coming-soon": { context: ThemeContext };
  "not-found": { context: ThemeContext };
};

/** A definition, with what the public renderer draws: the frame of every page, and each template. */
export type ThemeManifest<K extends string = string> = ThemeDefinition<K> & {
  readonly Layout: ComponentType<{ context: ThemeContext; children: ReactNode }>;
  readonly templates: { readonly [T in TemplateKey]: ComponentType<TemplateProps[T]> };
};
