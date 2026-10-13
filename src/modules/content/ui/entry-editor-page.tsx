import "server-only";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getSite, publicSitePath } from "@/modules/sites";
import { listMembers, type SiteContext } from "@/modules/tenancy";
import { isAppError } from "@/platform/errors";
import { EntryEditorLazy } from "../editor/lazy";
import { getEntryForEditor, listPages, listTerms } from "../queries";
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
  // What the sidebar offers (M5-7): the pages a page may go under, the members an entry may be credited to, the
  // site's categories and tags. Only what the member may use is loaded; the actions check every choice again.
  const { settings } = entry;
  const [site, pages, members, terms] = await Promise.all([
    getSite(ctx),
    type === "page" ? listPages(ctx).then(({ items }) => items) : [],
    settings.canChangeAuthor ? listMembers(ctx) : [],
    type === "post" ? listTerms(ctx) : [],
  ]);
  return (
    <main className="flex-1">
      <EntryEditorLazy
        orgSlug={ctx.org.slug}
        siteSlug={ctx.site.slug}
        entry={entry}
        publicPrefix={site.address ? publicSitePath(site.address) : null}
        choices={{
          pages: pages.map((page) => ({ id: page.id, title: page.title, path: page.path, status: page.status, parentId: page.parentId })),
          members: members.map((member) => ({ userId: member.userId, name: member.name })),
          terms,
        }}
      />
    </main>
  );
}
