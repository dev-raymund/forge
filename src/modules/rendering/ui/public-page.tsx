import "server-only";
import { sitePath } from "@/blocks/render-context";
import { env } from "@/platform/config/env";
import type { SiteLocator } from "@/platform/routing/hosts";
import { themeFor } from "@/themes/render";
import { pageTemplateKey, type PostCard, type TermLink } from "@/themes/types";
import { dateLabel } from "../dates";
import { renderDocument } from "../document";
import { htmlLang, renderableSite } from "../public-site";
import type { ListPage, PublicPage } from "../public-page";
import type { PublicSite } from "../queries";
import { listPageHref } from "../routes";

/**
 * A live site's page, drawn by its theme (M5-6). The theme gets public words and public addresses only (ADR 0013 §5):
 * titles, dates as text, links with the site's base. Never an id, a draft, or the stored document: the document is
 * rendered here, by the closed renderer, and handed over as the template's content.
 */
export function PublicPageView({ page, site, locator }: { page: PublicPage; site: PublicSite; locator: SiteLocator }) {
  const { theme, context } = themeFor(renderableSite(site, locator));
  const base = context.site.basePath;
  const blogHref = sitePath(base, `/${site.reading.blogPath}`);
  const date = (iso: string | null) => dateLabel(iso, htmlLang(site), site.timezone);
  const cards = (list: ListPage): PostCard[] => list.posts.map((post) => ({ title: post.title, href: sitePath(base, post.path), excerpt: post.excerpt, date: date(post.publishedAt) }));
  const pagination = (list: ListPage, listHref: string) => ({
    page: list.page,
    pages: list.pages,
    previousHref: list.page > 1 ? listPageHref(listHref, list.page - 1) : undefined,
    nextHref: list.page < list.pages ? listPageHref(listHref, list.page + 1) : undefined,
  });

  switch (page.kind) {
    case "site-home": {
      const Page = theme.templates.page;
      return (
        <Page context={context} title={site.name}>
          {site.tagline ? <p>{site.tagline}</p> : null}
        </Page>
      );
    }
    case "entry": {
      const { entry, links } = page;
      // What is not drawn is logged when the entry is read (./content.ts `reportUndrawable`), not on every request.
      const content = renderDocument(entry.content, {
        basePath: base,
        resolveEntryHref: (id) => (Object.hasOwn(links, id) ? sitePath(base, links[id]!) : undefined),
        blockedHosts: [appHost()],
      });
      if (entry.type === "post") {
        const Post = theme.templates.post;
        const terms: TermLink[] = entry.terms.map((term) => ({ taxonomy: term.taxonomy, name: term.name, href: `${blogHref}/${term.taxonomy}/${term.slug}` }));
        return (
          <Post context={context} title={entry.title} date={date(entry.publishedAt)} terms={terms} blogHref={blogHref}>
            {content}
          </Post>
        );
      }
      const Page = theme.templates[pageTemplateKey(entry.template)];
      return (
        <Page context={context} title={entry.title}>
          {content}
        </Page>
      );
    }
    case "blog-index": {
      const BlogIndex = theme.templates["blog-index"];
      return <BlogIndex context={context} title="Blog" posts={cards(page)} pagination={pagination(page, blogHref)} />;
    }
    case "term-archive": {
      const TermArchive = theme.templates["term-archive"];
      const listHref = `${blogHref}/${page.taxonomy}/${page.term.slug}`;
      return (
        <TermArchive
          context={context}
          taxonomy={page.taxonomy}
          name={page.term.name}
          description={page.term.description}
          blogHref={blogHref}
          posts={cards(page)}
          pagination={pagination(page, listHref)}
        />
      );
    }
  }
}

/** The page's title: the site's name for its home, otherwise what the page is, then the site's name. */
export function publicPageTitle(page: PublicPage | null, site: PublicSite): string {
  const of = (title: string, list?: ListPage) => `${title}${list && list.page > 1 ? ` · Page ${list.page}` : ""} · ${site.name}`;
  if (!page) return of("Page not found");
  switch (page.kind) {
    case "site-home":
      return site.name;
    case "entry":
      return page.entry.path === "/" ? site.name : of(page.entry.title || "Untitled");
    case "blog-index":
      return of("Blog", page);
    case "term-archive":
      return of(page.term.name, page);
  }
}

/** The app's own host: a site never frames it (as `modules/content/references.ts` refuses on save and publish). */
const appHost = () => new URL(env("core").APP_ORIGIN).hostname;
