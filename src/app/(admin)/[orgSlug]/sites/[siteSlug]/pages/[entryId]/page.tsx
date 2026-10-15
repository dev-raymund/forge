import type { Metadata } from "next";
import { Suspense } from "react";
import { OrganizationSuspended } from "@/components/admin/page-notice";
import { PageSkeleton } from "@/components/admin/page-skeleton";
import { EntryEditorPage, entryEditorPath } from "@/modules/content";
import { requireSitePage } from "@/modules/tenancy";

export const metadata: Metadata = { title: "Edit page" };

/**
 * Images uploaded from the media picker (M6-4) complete in this page's function, which processes them (M6-2): a minute
 * leaves room. It bounds the run only; Vercel's memory is its own, and nothing has been measured there.
 */
export const maxDuration = 60;

/** A page's editor (plan §19; M5-4). */
export default function EditPage({ params }: PageProps<"/[orgSlug]/sites/[siteSlug]/pages/[entryId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Editor params={params} />
    </Suspense>
  );
}

async function Editor({ params }: Pick<PageProps<"/[orgSlug]/sites/[siteSlug]/pages/[entryId]">, "params">) {
  const { orgSlug, siteSlug } = await params;
  const { entryId } = await params;
  const access = await requireSitePage(orgSlug, siteSlug, (org, site) => entryEditorPath(org, site, "page", entryId));
  if (access.status === "suspended") return <OrganizationSuspended message={access.message} />;
  return <EntryEditorPage ctx={access.ctx} entryId={entryId} type="page" />;
}
