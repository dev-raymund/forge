import type { Pagination as PaginationProps } from "../../types";

/** Newer and older pages of a list, in a navigation landmark of its own. Nothing when the list fits on one page. */
export function Pagination({ pagination }: { pagination: PaginationProps }) {
  const { page, pages, previousHref, nextHref } = pagination;
  if (pages <= 1) return null;
  return (
    <nav className="forge-pagination" aria-label="Pages of posts">
      {previousHref ? (
        <a href={previousHref} rel="prev" className="forge-pagination__link">
          ← Newer posts
        </a>
      ) : (
        <span />
      )}
      <p className="forge-pagination__where">
        Page {page} of {pages}
      </p>
      {nextHref ? (
        <a href={nextHref} rel="next" className="forge-pagination__link">
          Older posts →
        </a>
      ) : (
        <span />
      )}
    </nav>
  );
}
