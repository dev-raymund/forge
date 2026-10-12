import type { TermLink } from "../../types";

/** A post's categories and tags, each a link to its archive. Nothing when it has none. */
export function TermLinks({ terms }: { terms: readonly TermLink[] }) {
  const groups = [
    { label: "Categories", items: terms.filter((term) => term.taxonomy === "category") },
    { label: "Tags", items: terms.filter((term) => term.taxonomy === "tag") },
  ].filter((group) => group.items.length > 0);
  if (groups.length === 0) return null;
  return (
    <footer className="forge-terms">
      {groups.map((group) => (
        <p key={group.label}>
          <span className="forge-terms__label">{group.label}:</span>{" "}
          {group.items.map((term, index) => (
            <span key={term.href}>
              {index > 0 ? ", " : null}
              <a href={term.href}>{term.name}</a>
            </span>
          ))}
        </p>
      ))}
    </footer>
  );
}
