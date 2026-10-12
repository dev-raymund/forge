import "server-only";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getSite, publicSitePath } from "@/modules/sites";
import type { SiteContext } from "@/modules/tenancy";
import { isAppError } from "@/platform/errors";
import { EntryEditorLazy } from "../editor/lazy";
import { getEntryForEditor } from "../queries";
import type { ContentTypeKey } from "../types/definition";

/**
 * The editor page of a page or a post (M5-4; plan §19 `/…/pages/[entryId]`,
 * `/…/posts/[entryId]`), for the context the route resolved itself
 * (`requireSitePage`: the member, the organization and the site from the
 * session and the URL). The entry is looked up in that site only: an id of
 * another site, of the other type, in the trash, or that is not even an id,
 * is the 404 page. Every member may open it (reading is `entries.{type}.read`);
 * what they may change is the services' answer, shown read-only when it is no.
 */
export async function EntryEditorPage({ ctx, entryId, type }: { ctx: SiteContext; entryId: string; type: ContentTypeKey }) {
  if (!z.uuid().safeParse(entryId).success) notFound();
  let entry;
  try {
    entry = await getEntryForEditor(ctx, entryId, type);
  } catch (error) {
    if (isAppError(error) && error.kind === "NotFound") notFound();
    throw error;
  }
  const site = await getSite(ctx);
  return (
    <main className="flex-1">
      <EntryEditorLazy orgSlug={ctx.org.slug} siteSlug={ctx.site.slug} entry={entry} publicPrefix={site.address ? publicSitePath(site.address) : null} />
    </main>
  );
}
