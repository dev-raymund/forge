import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { NoAccess, OrganizationSuspended } from "@/components/admin/page-notice";
import { PageSkeleton } from "@/components/admin/page-skeleton";
import { canCreateEntry, canSetHomepage, entryListPath, listPages, newEntryPath, NewEntryForm, type PageListItem } from "@/modules/content";
import { requireSitePage } from "@/modules/tenancy";
import { PAGE_TEMPLATES } from "@/themes/types";

export const metadata: Metadata = { title: "New page" };

const TEMPLATE_LABELS: Record<keyof typeof PAGE_TEMPLATES, string> = { default: "Default", "full-width": "Full width", landing: "Landing page" };

/** The new-page form (plan §19 `/…/pages/new`; M5-7): Owner–Editor. Creating happens on submit, never on GET. */
export default function NewPagePage({ params, searchParams }: PageProps<"/[orgSlug]/sites/[siteSlug]/pages/new">) {
  return (
    <Suspense fallback={<PageSkeleton narrow />}>
      <NewPage params={params} searchParams={searchParams} />
    </Suspense>
  );
}

/** The pages in tree order, each indented under its parent: the "Under" choices. */
function treeOrder(pages: PageListItem[]): { id: string; label: string }[] {
  const children = new Map<string | null, PageListItem[]>();
  for (const page of pages) children.set(page.parentId, [...(children.get(page.parentId) ?? []), page]);
  const ids = new Set(pages.map((page) => page.id));
  const out: { id: string; label: string }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const page of children.get(parentId) ?? []) {
      out.push({ id: page.id, label: `${" ".repeat(depth)}${page.title || "Untitled"} (${page.path})` });
      walk(page.id, depth + 1);
    }
  };
  walk(null, 0);
  // Pages whose parent is not in the list (none in practice) still appear.
  for (const page of pages) if (page.parentId && !ids.has(page.parentId)) out.push({ id: page.id, label: `${page.title || "Untitled"} (${page.path})` });
  return out;
}

async function NewPage({ params, searchParams }: PageProps<"/[orgSlug]/sites/[siteSlug]/pages/new">) {
  const { orgSlug, siteSlug } = await params;
  const access = await requireSitePage(orgSlug, siteSlug, (org, site) => newEntryPath(org, site, "page"));
  if (access.status === "suspended") return <OrganizationSuspended message={access.message} />;
  const { ctx } = access;
  const back = entryListPath(ctx.org.slug, ctx.site.slug, "page");
  if (!canCreateEntry(ctx, "page")) {
    return (
      <NoAccess>
        <p>Creating pages is for the Owners, Admins and Editors of {ctx.site.name}.</p>
        <p>
          <Link href={back}>Back to the pages</Link>
        </p>
      </NoAccess>
    );
  }
  const [{ items }, query] = await Promise.all([listPages(ctx), searchParams]);
  const hasHome = items.some((page) => page.isHome);
  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">New page</h1>
      <p className="mt-2 mb-8 text-sm text-muted-foreground">On {ctx.site.name}. It starts as a draft: nothing is public until you publish it.</p>
      <NewEntryForm
        orgSlug={ctx.org.slug}
        siteSlug={ctx.site.slug}
        type="page"
        cancelHref={back}
        parents={treeOrder(items)}
        templates={Object.keys(PAGE_TEMPLATES).map((key) => ({ value: key === "default" ? "" : key, label: TEMPLATE_LABELS[key as keyof typeof PAGE_TEMPLATES] }))}
        home={{ offered: canSetHomepage(ctx), checked: query.home === "1" || !hasHome }}
      />
    </main>
  );
}
