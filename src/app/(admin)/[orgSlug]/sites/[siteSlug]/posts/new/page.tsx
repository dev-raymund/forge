import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { NoAccess, OrganizationSuspended } from "@/components/admin/page-notice";
import { PageSkeleton } from "@/components/admin/page-skeleton";
import { canCreateEntry, canCreditOthers, entryListPath, newEntryPath, NewEntryForm } from "@/modules/content";
import { listMembers, requireSitePage } from "@/modules/tenancy";

export const metadata: Metadata = { title: "New post" };

/** The new-post form (plan §19 `/…/posts/new`; M5-7): Owner–Author. Crediting someone else is for Owner–Editor. */
export default function NewPostPage({ params }: PageProps<"/[orgSlug]/sites/[siteSlug]/posts/new">) {
  return (
    <Suspense fallback={<PageSkeleton narrow />}>
      <NewPost params={params} />
    </Suspense>
  );
}

async function NewPost({ params }: Pick<PageProps<"/[orgSlug]/sites/[siteSlug]/posts/new">, "params">) {
  const { orgSlug, siteSlug } = await params;
  const access = await requireSitePage(orgSlug, siteSlug, (org, site) => newEntryPath(org, site, "post"));
  if (access.status === "suspended") return <OrganizationSuspended message={access.message} />;
  const { ctx } = access;
  const back = entryListPath(ctx.org.slug, ctx.site.slug, "post");
  if (!canCreateEntry(ctx, "post")) {
    return (
      <NoAccess>
        <p>Writing posts is for the Owners, Admins, Editors and Authors of {ctx.site.name}.</p>
        <p>
          <Link href={back}>Back to the posts</Link>
        </p>
      </NoAccess>
    );
  }
  const members = canCreditOthers(ctx, "post") ? await listMembers(ctx) : [];
  const self = members.find((member) => member.userId === ctx.actor.userId);
  const authors = [...(self ? [self] : []), ...members.filter((member) => member.userId !== ctx.actor.userId)].map((member) => ({
    userId: member.userId,
    name: member.userId === ctx.actor.userId ? `${member.name} (you)` : member.name,
  }));
  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">New post</h1>
      <p className="mt-2 mb-8 text-sm text-muted-foreground">On {ctx.site.name}. It starts as a draft: nothing is public until you publish it.</p>
      <NewEntryForm orgSlug={ctx.org.slug} siteSlug={ctx.site.slug} type="post" cancelHref={back} authors={authors} />
    </main>
  );
}
