import { Plus } from "lucide-react";
import Link from "next/link";
import { FormAlert } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ENTRY_STATUS_FILTERS, hasListFilters, type PageListQuery } from "../list-query";
import type { PageListItem } from "../queries";
import { PagesTree } from "./pages-tree";
import { TrashList, type TrashItem } from "./trash-list";

/**
 * A site's pages (M5-7; plan §19 `/…/pages`): the tree, a search by title and a status filter (a GET form, as the
 * posts list's), and the way to a new page. A site without a Home page (made before M5-3, or whose Home page went to
 * the trash later) says so here, with the way to make one for those who may set the homepage: nothing is created
 * until someone does.
 */

const CONTROL =
  "h-10 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-foreground focus-visible:ring-3 focus-visible:ring-foreground/25 md:text-sm";
const LINK = "rounded-sm font-medium underline underline-offset-4 outline-none hover:no-underline focus-visible:ring-3 focus-visible:ring-foreground/25";
const STATUS_LABELS: Record<string, string> = { draft: "Drafts", published: "Published", scheduled: "Scheduled", trash: "In the trash" };

export type PagesViewProps = {
  orgSlug: string;
  siteSlug: string;
  basePath: string;
  query: PageListQuery;
  pages: PageListItem[];
  truncated: boolean;
  /** Whether the site has a Home page at all (looked for without the filters). */
  hasHome: boolean;
  newHref: string | null;
  /** The new-page form with "make it the home page" ticked, for those who may set the homepage. */
  newHomeHref: string | null;
  canArrange: boolean;
};

export function PagesView({ orgSlug, siteSlug, basePath, query, pages, truncated, hasHome, newHref, newHomeHref, canArrange }: PagesViewProps) {
  const filtered = hasListFilters(query);
  const inTrash = query.status === "trash";
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Pages</h1>
        {newHref ? (
          <Button asChild className="h-10 px-4">
            <Link href={newHref}>
              <Plus aria-hidden="true" className="size-4" />
              New page
            </Link>
          </Button>
        ) : null}
      </div>
      <p className="mt-2 max-w-prose text-sm text-muted-foreground">
        The site&rsquo;s pages, each under the page above it. {canArrange ? "Drag a page by its handle, or use its menu, to change its place." : null}{" "}
        {inTrash ? (
          <Link href={basePath} className={LINK}>
            Back to the pages
          </Link>
        ) : (
          <Link href={`${basePath}?status=trash`} className={LINK}>
            Trash
          </Link>
        )}
      </p>

      {!hasHome ? (
        <FormAlert tone="info" className="mt-6">
          <p data-testid="no-home-page">
            This site has no home page: its address shows the site&rsquo;s name and tagline.{" "}
            {newHomeHref ? (
              <>
                <Link href={newHomeHref}>Create the home page</Link>, or open a page and choose &ldquo;Set as home page&rdquo;.
              </>
            ) : (
              "An Owner or Admin can make one."
            )}
          </p>
        </FormAlert>
      ) : null}

      <form key={JSON.stringify(query)} method="get" action={basePath} className="mt-6 grid gap-4 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end" aria-label="Filter pages">
        <div className="grid gap-2">
          <Label htmlFor="pages-q">Title</Label>
          <input id="pages-q" name="q" type="search" defaultValue={query.q ?? ""} className={CONTROL} placeholder="Find a page by its title" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="pages-status">Status</Label>
          <select id="pages-status" name="status" defaultValue={query.status ?? ""} className={CONTROL}>
            <option value="">Any status</option>
            {ENTRY_STATUS_FILTERS.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-4">
          <Button type="submit" className="h-10 px-4 focus-visible:ring-foreground/40">
            Apply
          </Button>
          {filtered ? (
            <Link href={basePath} className={`${LINK} text-sm`}>
              Clear
            </Link>
          ) : null}
        </div>
      </form>

      {inTrash ? (
        <TrashList orgSlug={orgSlug} siteSlug={siteSlug} type="page" items={pages.filter((page): page is PageListItem & { trash: TrashItem["trash"] } => Boolean(page.trash))} />
      ) : pages.length ? (
        <PagesTree
          orgSlug={orgSlug}
          siteSlug={siteSlug}
          pages={pages}
          canArrange={canArrange}
          filtered={filtered}
        />
      ) : (
        <div className="mt-6 grid gap-3 rounded-lg border border-dashed p-6 text-sm text-muted-foreground" data-testid="no-pages">
          <p>{filtered ? "No pages match these filters." : "This site has no pages yet."}</p>
          {!filtered && newHref ? (
            <p>
              <Link href={newHref} className={LINK}>
                Create the first page
              </Link>
            </p>
          ) : null}
        </div>
      )}
      {truncated ? <p className="mt-4 text-sm text-muted-foreground">Only the first 1,000 pages are shown. Search by title to find the others.</p> : null}
    </main>
  );
}
