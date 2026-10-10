import { z } from "zod";
import { fieldErrorsFrom, validationError } from "@/platform/errors";
import { checkSiteAddress } from "./address";
import { THEME_KEYS } from "@/themes/registry";
import { isSiteTimeZone, SITE_LANGUAGE_CODES } from "./locale";

/** Zod schemas of the sites module, shared by the forms (immediate feedback) and the services (the decision). */

const name = z.string().trim().min(1, "Enter a name for the site.").max(80, "Use at most 80 characters.");

/** Trimmed, lowercased, and held to the address rules (./address.ts). */
const address = z.string("Enter an address for the site.").transform((value, ctx) => {
  const checked = checkSiteAddress(value);
  if (checked.ok) return checked.address;
  ctx.addIssue({ code: "custom", message: checked.message });
  return z.NEVER;
});

const language = z.enum(SITE_LANGUAGE_CODES, "Choose a language.");
const timezone = z.string("Choose a time zone.").refine(isSiteTimeZone, "Choose a time zone from the list.");

export const createSiteSchema = z.object({ name, address, language, timezone });
export const changeSiteAddressSchema = z.object({ address });

/** A theme in the registry (M4-4): its key, exactly. Nothing else names a theme. */
export const chooseThemeSchema = z.object({ theme: z.enum(THEME_KEYS, "Choose one of the themes.") });

/** A status a member may ask for (M4-5): never `suspended`. */
export const setSiteStatusSchema = z.object({ status: z.enum(["coming_soon", "live"], "Choose Coming soon or Live.") });

/** What the services accept: the form's strings, unchecked. The schemas decide. */
export type CreateSiteInput = { name: string; address: string; language: string; timezone: string };
export type ChangeSiteAddressInput = { address: string };
export type ChooseThemeInput = { theme: string };

/** Parses service input with one of the schemas above, or throws `Validation` with the messages by field. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError(fieldErrorsFrom(result.error));
  return result.data;
}
