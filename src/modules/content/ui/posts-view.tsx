import { Plus } from "lucide-react";
import Link from "next/link";
import { Moment } from "@/components/admin/local-day";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { entryEditorPath } from "../admin-paths";
import { ENTRY_STATUS_FILTERS, hasListFilters, listHref, POST_SORTS, type PostListQuery } from "../list-query";
import type { PostList, TermOption } from "../queries";
import { StatusBadge } from "./status-badge";

/**
 * A site's posts (M5-7; plan §19 `/…/posts`): newest edits first by default, filtered by status, category, author
 * and title, sorted, 25 a page. The filters are an ordinary GET form, as on the activity page: the list is what the
 * URL says, and works without JavaScript. What the member may see was decided on the server: an Author's list holds
 * their own posts only, and has no author filter.
 */

const CONTROL =
  "h-10 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-foreground focus-visible:ring-3 focus-visible:ring-foreground/25 md:text-sm";
const LINK = "rounded-sm font-medium underline underline-offset-4 outline-none hover:no-underline focus-visible:ring-3 focus-visible:ring-foreground/25";
const STATUS_LABELS: Record<string, string> = { draft: "Drafts", published: "Published", scheduled: "Scheduled" };

export type PostsViewProps = {
  orgSlug: string;
  siteSlug: string;
  basePath: string;
  query: PostListQuery;
  list: PostList;
  categories: TermOption[];
  /** Who can be chosen as the author filter (user id and name); empty for an Author, whose list is theirs only. */
  authors: { userId: string; name: string }[];
  newHref: string | null;
};

export function PostsView({ orgSlug, siteSlug, basePath, query, list, categories, authors, newHref }: PostsViewProps) {
  const filtered = hasListFilters(query);
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Posts</h1>
        {newHref ? (
          <Button asChild className="h-10 px-4">
            <Link href={newHref}>
              <Plus aria-hidden="true" className="size-4" />
              New post
            </Link>
          </Button>
        ) : null}
      </div>
      <p className="mt-2 max-w-prose text-sm text-muted-foreground">
        {list.onlyOwn ? "Your posts on this site." : "Everything published on the blog, and the drafts on their way there."}
      </p>

      <form key={listHref("", { ...query, page: 1 })} method="get" action={basePath} className="mt-8 grid gap-4 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Filter posts">
        <div className="grid gap-2 sm:col-span-2 lg:col-span-3">
          <Label htmlFor="posts-q">Title</Label>
          <input id="posts-q" name="q" type="search" defaultValue={query.q ?? ""} className={CONTROL} placeholder="Find a post by its title" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="posts-status">Status</Label>
          <select id="posts-status" name="status" defaultValue={query.status ?? ""} className={CONTROL}>
            <option value="">Any status</option>
            {ENTRY_STATUS_FILTERS.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="posts-category">Category</Label>
          <select id="posts-category" name="category" defaultValue={query.category ?? ""} className={CONTROL}>
            <option value="">Any category</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
        {authors.length ? (
          <div className="grid gap-2">
            <Label htmlFor="posts-author">Author</Label>
            <select id="posts-author" name="author" defaultValue={query.author ?? ""} className={CONTROL}>
              <option value="">Anyone</option>
              {authors.map((author) => (
                <option key={author.userId} value={author.userId}>
                  {author.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="grid gap-2">
          <Label htmlFor="posts-sort">Sort</Label>
          <select id="posts-sort" name="sort" defaultValue={query.sort} className={CONTROL}>
            {Object.entries(POST_SORTS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-4 sm:col-span-2 lg:col-span-3">
          <Button type="submit" className="h-10 px-4 focus-visible:ring-foreground/40">
            Apply
          </Button>
          {filtered || query.sort !== "updated" ? (
            <Link href={basePath} className={`${LINK} text-sm`}>
              Clear
            </Link>
          ) : null}
        </div>
      </form>

      {list.items.length > 0 ? (
        <ul className="mt-8 divide-y rounded-lg border" data-testid="posts">
          {list.items.map((post) => (
            <li key={post.id} data-testid="post-row" className="grid gap-1.5 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4 sm:p-4">
              <div className="grid min-w-0 gap-1">
                <Link href={entryEditorPath(orgSlug, siteSlug, "post", post.id)} className={`${LINK} wrap-anywhere`}>
                  {post.title || "Untitled"}
                </Link>
                <p className="text-sm text-muted-foreground wrap-anywhere">
                  {post.path}
                  {post.authorName ? ` · ${post.authorName}` : post.authorId ? " · A former member" : ""}
                  {post.categories.length ? ` · ${post.categories.join(", ")}` : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  Edited <Moment iso={post.updatedAt.toISOString()} />
                  {post.publishedAt ? (
                    <>
                      {" "}
                      · Published <Moment iso={post.publishedAt.toISOString()} />
                    </>
                  ) : null}
                </p>
              </div>
              <StatusBadge status={post.status} changed={post.changed} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-8 grid gap-3 rounded-lg border border-dashed p-6 text-sm text-muted-foreground" data-testid="no-posts">
          {filtered ? (
            <p>No posts match these filters.</p>
          ) : (
            <>
              <p>{list.onlyOwn ? "You have not written a post on this site yet." : "This site has no posts yet."}</p>
              {newHref ? (
                <p>
                  <Link href={newHref} className={LINK}>
                    Write the first one
                  </Link>
                </p>
              ) : null}
            </>
          )}
        </div>
      )}

      {list.pages > 1 ? (
        <nav aria-label="Pages of posts" className="mt-6 flex flex-wrap items-center justify-between gap-4 text-sm">
          {list.page > 1 ? (
            <Link href={listHref(basePath, query, { page: list.page - 1 })} className={LINK} rel="prev">
              Previous page
            </Link>
          ) : (
            <span />
          )}
          <span className="text-muted-foreground">
            Page {list.page} of {list.pages} · {list.total} posts
          </span>
          {list.page < list.pages ? (
            <Link href={listHref(basePath, query, { page: list.page + 1 })} className={LINK} rel="next">
              Next page
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </main>
  );
}
