/**
 * From a public URL to what it may name (M5-6, plan §10): pure. The URL's path
 * below the site's base (`/s/{address}` in V1) is the canonical path itself;
 * there is no second spelling of any address.
 *
 *   /                                        the Home page (the entry stored at `/`)
 *   /{blogPath}                              the blog index          …/page/{n}  its page n (n ≥ 2)
 *   /{blogPath}/category/{slug}              a category's archive    …/page/{n}
 *   /{blogPath}/tag/{slug}                   a tag's archive         …/page/{n}
 *   anything else                            the entry stored at exactly that path (a page, or a post at /{blogPath}/{slug})
 *
 * Every segment must be a slug as entries store them (lowercase letters and
 * digits in hyphen-separated groups), so `/About`, `/about%20us` or
 * `/blog/page/01` name nothing: the only spelling of a page is its stored path.
 * Page 1 of a list is the list's own address (`…/page/1` names nothing).
 * Posts are found by the path they were published at, so a post published
 * before the blog's path changed is still found at its old path.
 */

export type RouteCandidate =
  | { kind: "path"; path: string }
  | { kind: "blog-index"; page: number }
  | { kind: "term-archive"; taxonomy: "category" | "tag"; slug: string; page: number };

const SEGMENT = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Page 2 to 99,999 as written: no leading zero, no sign. */
const PAGE = /^[1-9][0-9]{0,4}$/;
/** Deeper or longer than any stored path could be: not looked up at all. */
const MAX_SEGMENTS = 16;
const MAX_LENGTH = 1_024;

const pageNumber = (segment: string | undefined): number | null => (segment !== undefined && PAGE.test(segment) && Number(segment) >= 2 ? Number(segment) : null);

export function routeFor(segments: readonly string[], blogPath: string): RouteCandidate | null {
  if (segments.length > MAX_SEGMENTS || segments.join("/").length > MAX_LENGTH) return null;
  if (!segments.every((segment) => SEGMENT.test(segment))) return null;
  if (segments.length === 0) return { kind: "path", path: "/" };

  if (segments[0] === blogPath) {
    const [, first, second, third, fourth] = segments;
    if (segments.length === 1) return { kind: "blog-index", page: 1 };
    if (segments.length === 3 && first === "page") {
      const page = pageNumber(second);
      return page ? { kind: "blog-index", page } : null;
    }
    if (first === "category" || first === "tag") {
      if (segments.length === 3) return { kind: "term-archive", taxonomy: first, slug: second!, page: 1 };
      if (segments.length === 5 && third === "page") {
        const page = pageNumber(fourth);
        return page ? { kind: "term-archive", taxonomy: first, slug: second!, page } : null;
      }
    }
  }
  return { kind: "path", path: `/${segments.join("/")}` };
}

/** Where page `page` of a list lives: the list's own address for page 1. */
export const listPageHref = (listHref: string, page: number): string => (page <= 1 ? listHref : `${listHref}/page/${page}`);
