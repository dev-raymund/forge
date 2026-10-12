import type { Metadata } from "next";
import { Suspense } from "react";
import { OrganizationSuspended } from "@/components/admin/page-notice";
import { PageSkeleton } from "@/components/admin/page-skeleton";
import { EntryEditorPage, entryEditorPath } from "@/modules/content";
import { requireSitePage } from "@/modules/tenancy";

export const metadata: Metadata = { title: "Edit post" };

/** A post's editor (plan §19; M5-4). */
export default function EditPost({ params }: PageProps<"/[orgSlug]/sites/[siteSlug]/posts/[entryId]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Editor params={params} />
    </Suspense>
  );
}

async function Editor({ params }: Pick<PageProps<"/[orgSlug]/sites/[siteSlug]/posts/[entryId]">, "params">) {
  const { orgSlug, siteSlug } = await params;
  const { entryId } = await params;
  const access = await requireSitePage(orgSlug, siteSlug, (org, site) => entryEditorPath(org, site, "post", entryId));
  if (access.status === "suspended") return <OrganizationSuspended message={access.message} />;
  return <EntryEditorPage ctx={access.ctx} entryId={entryId} type="post" />;
}
