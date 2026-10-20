import "server-only";
import type { Actor } from "@/modules/auth";
import { refusal, resolveSiteContext, type FormOutcome, type RequestMeta } from "@/modules/tenancy";
import { validationError } from "@/platform/errors";
import { text } from "@/platform/forms";
import { MENU_CONFLICT, saveMenu } from "./menus.service";
import { siteMenusPath } from "./paths";

/**
 * What the menus page's form does when it is submitted (M8-3). Who is asking comes from the session; the organization
 * and the site from the page's URL; the location is bound by the page. They name things and grant nothing: the
 * service asks for the permission and looks every destination up in the context's site.
 *
 * The form sends the menu as JSON (`items`) with the version the page opened (`version`). A success leaves the editor
 * as it is (it already shows what was saved) with the new version; the overview's checklist and the public site follow.
 */

const MODULE = "navigation";
/** Far more than 100 links can take: a bigger body is not a menu. */
const ITEMS_FIELD_MAX = 200_000;
const UNREADABLE = "This menu could not be read. Reload the page and try again.";

function itemsFrom(formData: FormData): unknown {
  const raw = text(formData.get("items"));
  if (raw.length > ITEMS_FIELD_MAX) throw validationError({ items: [UNREADABLE] });
  try {
    return JSON.parse(raw);
  } catch {
    throw validationError({ items: [UNREADABLE] });
  }
}

const LOCATION_WORDS: Record<string, string> = { header: "Header", footer: "Footer" };

export async function submitSaveMenu(actor: Actor, orgSlug: string, siteSlug: string, location: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const values = { version: text(formData.get("version")) };
  try {
    const items = itemsFrom(formData);
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const version = /^\d{1,9}$/.test(values.version) ? Number(values.version) : -1;
    const saved = await saveMenu(ctx, location, items, version);
    const what = `${LOCATION_WORDS[location] ?? "The"} menu`;
    return {
      state: {
        status: "success",
        message: saved.changed ? `${what} saved. The site shows it now.` : `Nothing to save: this is already the ${location} menu.`,
        values: { version: String(saved.version) },
      },
      // The overview's checklist ("Set up your menu"); the editor already shows what was saved.
      ...(saved.changed ? { revalidate: [`/${ctx.org.slug}/sites/${ctx.site.slug}`], invalidate: saved.events } : {}),
      refresh: false,
    };
  } catch (error) {
    return refusal(error, meta, values, siteMenusPath(orgSlug, siteSlug), { Conflict: MENU_CONFLICT }, MODULE);
  }
}
