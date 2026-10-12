import { Container } from "../components/container";
import { Pagination } from "../components/pagination";
import { PostList } from "../components/post-list";
import { Prose } from "../components/prose";
import { TermLinks } from "../components/term-links";
import type { TemplateProps } from "../../types";

/**
 * The kit's own post, blog index and archive templates (M5-6): plain, drawn with the kit's variables, for a theme that
 * has not designed its own. Journal uses them until M8-2 gives it blog templates of its own.
 */

export function KitPost({ title, date, terms, blogHref, children }: TemplateProps["post"]) {
  return (
    <article className="forge-post">
      <Container>
        <header className="forge-post__header">
          <p className="forge-post__eyebrow">
            <a href={blogHref}>Blog</a>
          </p>
          <h1>{title}</h1>
          {date ? (
            <p className="forge-post__meta">
              <time dateTime={date.iso}>{date.label}</time>
            </p>
          ) : null}
        </header>
        <Prose>{children}</Prose>
        <TermLinks terms={terms} />
      </Container>
    </article>
  );
}

export function KitBlogIndex({ title, posts, pagination }: TemplateProps["blog-index"]) {
  return (
    <section className="forge-archive" aria-labelledby="archive-title">
      <Container>
        <h1 id="archive-title" className="forge-archive__title">
          {title}
        </h1>
        <PostList posts={posts} />
        <Pagination pagination={pagination} />
      </Container>
    </section>
  );
}

export function KitTermArchive({ taxonomy, name, description, blogHref, posts, pagination }: TemplateProps["term-archive"]) {
  return (
    <section className="forge-archive" aria-labelledby="archive-title">
      <Container>
        <p className="forge-post__eyebrow">
          <a href={blogHref}>Blog</a> · {taxonomy === "category" ? "Category" : "Tag"}
        </p>
        <h1 id="archive-title" className="forge-archive__title">
          {name}
        </h1>
        {description ? <p className="forge-archive__description">{description}</p> : null}
        <PostList posts={posts} empty="No posts here yet." />
        <Pagination pagination={pagination} />
      </Container>
    </section>
  );
}
