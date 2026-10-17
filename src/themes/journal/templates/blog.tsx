import { Fragment } from "react";
import { Container } from "../../_kit/components/container";
import { FeaturedImage } from "../../_kit/components/featured-image";
import { Pagination } from "../../_kit/components/pagination";
import { Prose } from "../../_kit/components/prose";
import type { PostCard, TemplateProps, TermLink } from "../../types";

/**
 * Journal's blog (M8-2; plan §7: blog first). Editorial: a centred masthead for each post (its categories above the
 * title as a kicker, the date under it), the featured image across the wide column, the text at a reading measure,
 * and what it is filed under at the end; lists of posts as a column of entries, the newest on the first page set as
 * the lead; archives that say what they are.
 *
 * Drawn from what the renderer hands over and nothing else (ADR 0017): titles and dates as text, addresses already
 * public, the document already rendered by the closed renderer (`children`), images already resolved to their stored
 * widths (`ResponsiveImage`). What a post does not have (an image, an excerpt, a date, terms) leaves nothing behind.
 */

export function JournalPost({ title, date, terms, blogHref, featuredImage, children }: TemplateProps["post"]) {
  const categories = terms.filter((term) => term.taxonomy === "category");
  return (
    <article className="journal-post">
      <header className="journal-post__header">
        <Container>
          <p className="journal-kicker">
            {categories.length ? (
              categories.map((category, index) => (
                <Fragment key={category.href}>
                  {index > 0 ? <span aria-hidden="true"> · </span> : null}
                  <a href={category.href}>{category.name}</a>
                </Fragment>
              ))
            ) : (
              <a href={blogHref}>Blog</a>
            )}
          </p>
          <h1 className="journal-post__title">{title || "Untitled"}</h1>
          {date ? (
            <p className="journal-post__date">
              <time dateTime={date.iso}>{date.label}</time>
            </p>
          ) : null}
        </Container>
      </header>
      {featuredImage ? (
        <Container wide className="journal-post__image">
          <FeaturedImage image={featuredImage} />
        </Container>
      ) : null}
      <Container>
        <Prose className="journal-post__body">{children}</Prose>
        <JournalTerms terms={terms} />
        <p className="journal-post__back">
          <a href={blogHref}>
            <span aria-hidden="true">← </span>All posts
          </a>
        </p>
      </Container>
    </article>
  );
}

/** What a post is filed under: its categories and its tags, each a link to its archive. Nothing when it has none. */
export function JournalTerms({ terms }: { terms: readonly TermLink[] }) {
  const groups = [
    { label: "Filed under", items: terms.filter((term) => term.taxonomy === "category") },
    { label: "Tagged", items: terms.filter((term) => term.taxonomy === "tag") },
  ].filter((group) => group.items.length > 0);
  if (groups.length === 0) return null;
  return (
    <footer className="journal-terms">
      {groups.map((group) => (
        <div key={group.label} className="journal-terms__group">
          <p className="journal-terms__label" id={`terms-${group.label === "Tagged" ? "tags" : "categories"}`}>
            {group.label}
          </p>
          <ul aria-labelledby={`terms-${group.label === "Tagged" ? "tags" : "categories"}`}>
            {group.items.map((term) => (
              <li key={term.href}>
                <a href={term.href}>{term.name}</a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </footer>
  );
}

/**
 * A column of posts: each one's date, its title as the one link (an `h2`: the page's own title is the `h1`) and its
 * excerpt, between hairlines. The first on a list's first page is the lead, set larger. An empty list says so.
 */
export function JournalPostList({ posts, lead, empty }: { posts: readonly PostCard[]; lead: boolean; empty: string }) {
  if (posts.length === 0) return <p className="journal-empty">{empty}</p>;
  return (
    <ol className="journal-entries">
      {posts.map((post, index) => (
        <li key={post.href} className={lead && index === 0 ? "journal-entry journal-entry--lead" : "journal-entry"}>
          <article>
            {post.date ? (
              <p className="journal-entry__date">
                <time dateTime={post.date.iso}>{post.date.label}</time>
              </p>
            ) : null}
            <h2 className="journal-entry__title">
              <a href={post.href}>{post.title || "Untitled"}</a>
            </h2>
            {post.excerpt ? <p className="journal-entry__excerpt">{post.excerpt}</p> : null}
          </article>
        </li>
      ))}
    </ol>
  );
}

export function JournalBlogIndex({ title, posts, pagination }: TemplateProps["blog-index"]) {
  return (
    <section className="journal-archive" aria-labelledby="archive-title">
      <Container>
        <header className="journal-archive__header">
          <h1 id="archive-title" className="journal-archive__title">
            {title}
          </h1>
          {pagination.pages > 1 ? (
            <p className="journal-archive__where">
              Page {pagination.page} of {pagination.pages}
            </p>
          ) : null}
        </header>
        <JournalPostList posts={posts} lead={pagination.page === 1} empty="Nothing has been published here yet." />
        <Pagination pagination={pagination} />
      </Container>
    </section>
  );
}

export function JournalTermArchive({ taxonomy, name, description, blogHref, posts, pagination }: TemplateProps["term-archive"]) {
  return (
    <section className="journal-archive" aria-labelledby="archive-title">
      <Container>
        <header className="journal-archive__header">
          <p className="journal-kicker">
            <a href={blogHref}>Blog</a>
            <span aria-hidden="true"> · </span>
            {taxonomy === "category" ? "Category" : "Tag"}
          </p>
          <h1 id="archive-title" className="journal-archive__title">
            {name}
          </h1>
          {description ? <p className="journal-archive__description">{description}</p> : null}
          {pagination.pages > 1 ? (
            <p className="journal-archive__where">
              Page {pagination.page} of {pagination.pages}
            </p>
          ) : null}
        </header>
        <JournalPostList posts={posts} lead={false} empty={`Nothing is filed under ${name} yet.`} />
        <Pagination pagination={pagination} />
      </Container>
    </section>
  );
}
