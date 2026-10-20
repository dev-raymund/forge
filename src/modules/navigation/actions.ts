"use server";

import { getCurrentActor } from "@/modules/auth";
import { currentRequestMeta, finish } from "@/modules/tenancy";
import type { FormState } from "@/platform/forms";
import { submitSaveMenu } from "./menu-forms";

/** The menus page (M8-3): one menu, saved as a whole. The location is bound by the page. */
export async function saveMenuAction(orgSlug: string, siteSlug: string, location: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitSaveMenu(await getCurrentActor(), orgSlug, siteSlug, location, formData, await currentRequestMeta()));
}
