import { z } from "zod";
import { isSiteTimeZone, SITE_LANGUAGE_CODES } from "./locale";

/**
 * A site's settings (M4-2, plan §4 `site_settings`, ADR 0014): what each group
 * holds, the rules for what is submitted, and how what is stored is read.
 * Pure and client-safe.
 *
 *   general     sites.name, sites.default_locale, sites.timezone (columns)
 *               + site_settings.general: { tagline, social: { [network]: url } }
 *   reading     site_settings.reading:   { blogPath, postsPerPage }
 *   analytics   site_settings.analytics: { ga4MeasurementId, plausibleDomain }
 *
 * Submitted values are checked strictly (an unknown key or a bad value is
 * refused, and nothing is saved). Stored values are read leniently, value by
 * value: whatever passes its rule is used, everything else is the default, so
 * a damaged row never breaks a page.
 */

// ── Social links ─────────────────────────────────────────────────────────────

/** The networks a site can link to, in the order themes show them. */
export const SOCIAL_NETWORKS = [
  { key: "facebook", label: "Facebook" },
  { key: "instagram", label: "Instagram" },
  { key: "x", label: "X" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "youtube", label: "YouTube" },
  { key: "tiktok", label: "TikTok" },
] as const;

export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number]["key"];
export const SOCIAL_KEYS = SOCIAL_NETWORKS.map((network) => network.key) as [SocialNetwork, ...SocialNetwork[]];

/** A social link: an `https` address, nothing else (no `javascript:`, no other scheme, no spaces or quotes). */
const socialUrl = z
  .string()
  .trim()
  .max(300, "Use at most 300 characters.")
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname.includes(".") && !/[\s"'<>]/.test(value);
    } catch {
      return false;
    }
  }, "Use a full address starting with https://.");

/** Empty means "no link": the form's empty fields are not errors. */
const optional = <T extends z.ZodType>(schema: T) => z.union([z.literal("").transform(() => undefined), schema]).optional();

// ── General ──────────────────────────────────────────────────────────────────

const name = z.string().trim().min(1, "Enter a name for the site.").max(80, "Use at most 80 characters.");
const tagline = z.string().trim().max(200, "Use at most 200 characters.");

/** The general form's fields: the site's columns, its tagline, and one field per social network. */
export const generalSettingsSchema = z.strictObject({
  name,
  tagline,
  language: z.enum(SITE_LANGUAGE_CODES, "Choose a language."),
  timezone: z.string("Choose a time zone.").refine(isSiteTimeZone, "Choose a time zone from the list."),
  facebook: optional(socialUrl),
  instagram: optional(socialUrl),
  x: optional(socialUrl),
  linkedin: optional(socialUrl),
  youtube: optional(socialUrl),
  tiktok: optional(socialUrl),
});

export type GeneralSettings = {
  name: string;
  tagline: string;
  language: string;
  timezone: string;
  social: Partial<Record<SocialNetwork, string>>;
};

// ── Reading ──────────────────────────────────────────────────────────────────

export const DEFAULT_BLOG_PATH = "blog";
export const DEFAULT_POSTS_PER_PAGE = 10;
export const POSTS_PER_PAGE_MAX = 50;

/** One path segment: where the blog lives (`/s/{address}/{blogPath}`). Lowercase letters, digits, single hyphens. */
const blogPath = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Enter a path for the blog, like blog.")
  .max(40, "Use at most 40 characters.")
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens, like news or journal.");

const postsPerPage = z.coerce
  .number("Enter a number.")
  .int("Enter a whole number.")
  .min(1, "Show at least 1 post a page.")
  .max(POSTS_PER_PAGE_MAX, `Show at most ${POSTS_PER_PAGE_MAX} posts a page.`);

export const readingSettingsSchema = z.strictObject({ blogPath, postsPerPage });
export type ReadingSettings = { blogPath: string; postsPerPage: number };

// ── Analytics ────────────────────────────────────────────────────────────────

/**
 * A GA4 measurement ID (`G-` and letters or digits). Stored in capitals. It is
 * all the GA4 snippet needs, and the only thing of it a page ever contains.
 */
const ga4MeasurementId = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^G-[A-Z0-9]{4,16}$/, "Use a GA4 measurement ID like G-ABC123XYZ9.");

/** The domain the site is registered under at Plausible: a hostname, no scheme, no path. */
const plausibleDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253, "Use at most 253 characters.")
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Use the domain as it is set up at Plausible, like example.com.");

export const analyticsSettingsSchema = z.strictObject({ ga4MeasurementId: optional(ga4MeasurementId), plausibleDomain: optional(plausibleDomain) });
export type AnalyticsSettings = { ga4MeasurementId?: string; plausibleDomain?: string };

// ── Reading what is stored ───────────────────────────────────────────────────

const pick = <T>(schema: z.ZodType<T>, value: unknown, fallback: T): T => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
};
const field = (group: unknown, key: string): unknown =>
  typeof group === "object" && group !== null && !Array.isArray(group) ? (group as Record<string, unknown>)[key] : undefined;

/** `site_settings.general`: the tagline and the social links that pass their rules. */
export function readGeneral(stored: unknown): { tagline: string; social: Partial<Record<SocialNetwork, string>> } {
  const socialStored = field(stored, "social");
  const social: Partial<Record<SocialNetwork, string>> = {};
  for (const key of SOCIAL_KEYS) {
    const value = pick(socialUrl.optional(), field(socialStored, key), undefined);
    if (value) social[key] = value;
  }
  return { tagline: pick(tagline, field(stored, "tagline"), ""), social };
}

/** `site_settings.reading`, with the plan's defaults (`blog`, 10). */
export function readReading(stored: unknown): ReadingSettings {
  return {
    blogPath: pick(blogPath, field(stored, "blogPath"), DEFAULT_BLOG_PATH),
    postsPerPage: pick(postsPerPage, field(stored, "postsPerPage"), DEFAULT_POSTS_PER_PAGE),
  };
}

/** `site_settings.analytics`: only IDs that pass their rules; anything else is "not set". */
export function readAnalytics(stored: unknown): AnalyticsSettings {
  const ga4 = pick(ga4MeasurementId.optional(), field(stored, "ga4MeasurementId"), undefined);
  const plausible = pick(plausibleDomain.optional(), field(stored, "plausibleDomain"), undefined);
  return { ...(ga4 ? { ga4MeasurementId: ga4 } : {}), ...(plausible ? { plausibleDomain: plausible } : {}) };
}

/** The social links a theme draws, in the networks' order. */
export function socialLinks(social: Partial<Record<SocialNetwork, string>>): { network: SocialNetwork; label: string; href: string }[] {
  return SOCIAL_NETWORKS.flatMap(({ key, label }) => (social[key] ? [{ network: key, label, href: social[key]! }] : []));
}
