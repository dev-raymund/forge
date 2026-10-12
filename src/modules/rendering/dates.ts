import type { DateLabel } from "@/themes/types";

/**
 * A date as a site shows it (M5-6): written in the site's language and time zone, with the exact instant for
 * `<time dateTime>`. A language or zone the platform does not know falls back to English and UTC rather than failing
 * the page.
 */
export function dateLabel(iso: string | null, language: string, timeZone: string): DateLabel | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  let label: string;
  try {
    label = new Intl.DateTimeFormat(language, { dateStyle: "long", timeZone }).format(date);
  } catch {
    label = new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" }).format(date);
  }
  return { iso: date.toISOString(), label };
}
