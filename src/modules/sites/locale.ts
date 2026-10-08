/**
 * A site's language and time zone (plan §3, step 2). Pure and client-safe.
 *
 * The language is stored as a BCP 47 language subtag (`sites.default_locale`):
 * the site's `<html lang>`, and the language its dates are written in. The
 * list is the languages offered when a site is created; adding one is a line.
 * Languages written right to left are not offered yet: the themes do not lay
 * them out (ADR 0011).
 */
export const SITE_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "cs", label: "Czech" },
  { code: "da", label: "Danish" },
  { code: "de", label: "German" },
  { code: "es", label: "Spanish" },
  { code: "fil", label: "Filipino" },
  { code: "fi", label: "Finnish" },
  { code: "fr", label: "French" },
  { code: "id", label: "Indonesian" },
  { code: "it", label: "Italian" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "ms", label: "Malay" },
  { code: "nl", label: "Dutch" },
  { code: "nb", label: "Norwegian" },
  { code: "pl", label: "Polish" },
  { code: "pt", label: "Portuguese" },
  { code: "sv", label: "Swedish" },
  { code: "th", label: "Thai" },
  { code: "tr", label: "Turkish" },
  { code: "vi", label: "Vietnamese" },
  { code: "zh", label: "Chinese" },
] as const;

export type SiteLanguage = (typeof SITE_LANGUAGES)[number]["code"];
export const SITE_LANGUAGE_CODES = SITE_LANGUAGES.map((language) => language.code) as [SiteLanguage, ...SiteLanguage[]];
export const DEFAULT_SITE_LANGUAGE: SiteLanguage = "en";
export const DEFAULT_SITE_TIME_ZONE = "UTC";

export const languageLabel = (code: string): string => SITE_LANGUAGES.find((language) => language.code === code)?.label ?? code;

let zones: readonly string[] | undefined;

/** The IANA time zones this runtime knows, UTC first. */
export function siteTimeZones(): readonly string[] {
  zones ??= [DEFAULT_SITE_TIME_ZONE, ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== DEFAULT_SITE_TIME_ZONE)];
  return zones;
}

export const isSiteTimeZone = (value: unknown): value is string => typeof value === "string" && siteTimeZones().includes(value);
