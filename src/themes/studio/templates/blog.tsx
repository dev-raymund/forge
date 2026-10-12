import { Container } from "../../_kit/components/container";
import { Pagination } from "../../_kit/components/pagination";
import { PostList } from "../../_kit/components/post-list";
import { Prose } from "../../_kit/components/prose";
import { TermLinks } from "../../_kit/components/term-links";
import type { TemplateProps } from "../../types";

/** Studio's blog (M5-6): a post, the blog index and a category's or tag's archive, under Studio's title band. */

export function StudioPost({ title, date, terms, blogHref, children }: TemplateProps["post"]) {
  return (
    <article className="studio-page studio-post">
      <header className="studio-page__header">
        <Container>
          <p className="studio-eyebrow">
            <a href={blogHref}>Blog</a>
          </p>
          <h1>{title}</h1>
          {date ? (
            <p className="studio-post__date">
              <time dateTime={date.iso}>{date.label}</time>
            </p>
          ) : null}
        </Container>
      </header>
      <Container>
        <Prose>{children}</Prose>
        <TermLinks terms={terms} />
      </Container>
    </article>
  );
}

export function StudioBlogIndex({ title, posts, pagination }: TemplateProps["blog-index"]) {
  return (
    <section className="studio-page studio-archive" aria-labelledby="archive-title">
      <header className="studio-page__header">
        <Container>
          <h1 id="archive-title">{title}</h1>
        </Container>
      </header>
      <Container>
        <PostList posts={posts} />
        <Pagination pagination={pagination} />
      </Container>
    </section>
  );
}

export function StudioTermArchive({ taxonomy, name, description, blogHref, posts, pagination }: TemplateProps["term-archive"]) {
  return (
    <section className="studio-page studio-archive" aria-labelledby="archive-title">
      <header className="studio-page__header">
        <Container>
          <p className="studio-eyebrow">
            <a href={blogHref}>Blog</a> · {taxonomy === "category" ? "Category" : "Tag"}
          </p>
          <h1 id="archive-title">{name}</h1>
          {description ? <p className="studio-lede">{description}</p> : null}
        </Container>
      </header>
      <Container>
        <PostList posts={posts} empty="No posts here yet." />
        <Pagination pagination={pagination} />
      </Container>
    </section>
  );
}
