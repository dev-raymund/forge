import type { NavItem } from "../../types";

/**
 * A menu as a list of links in a navigation landmark (M4-4; M8-3: two levels, new tabs). Draws nothing when the menu
 * is empty, rather than an empty landmark.
 *
 * The links under a link (`children`) are drawn one of two ways, without any script (site pages ship none, ADR 0029):
 *
 *   disclosure   (headers) a button beside the link opens them (`<summary>`): by keyboard (Enter or Space), by touch,
 *                and announced as expanded or collapsed. The list follows the `<details>` (shown while it is open), so
 *                it can take a row of its own on a phone and be a panel under the link from 48rem
 *   list         (footers) a list under the link, always shown
 *
 * A link that opens in a new tab says so to screen readers, and gives the new page no access back (`noopener`).
 */
export function Nav({
  items, label, className, rel, submenus = "list",
}: { items: readonly NavItem[]; label: string; className?: string; rel?: string; submenus?: "disclosure" | "list" }) {
  if (items.length === 0) return null;
  return (
    <nav aria-label={label} className={["forge-nav", `forge-nav--${submenus}`, className ?? ""].filter(Boolean).join(" ")}>
      <ul>
        {items.map((item, index) => (
          <li key={`${index} ${item.href}`} className={item.children?.length ? "forge-nav__parent" : undefined}>
            <NavLink item={item} rel={rel} />
            {item.children?.length ? (
              submenus === "disclosure" ? (
                <>
                  <details className="forge-nav__more">
                    <summary className="forge-nav__toggle">
                      <span className="forge-visually-hidden">More links under {item.label}</span>
                      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                        <path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </summary>
                  </details>
                  <SubList items={item.children} rel={rel} />
                </>
              ) : (
                <SubList items={item.children} rel={rel} />
              )
            ) : null}
          </li>
        ))}
      </ul>
    </nav>
  );
}

function SubList({ items, rel }: { items: readonly NavItem[]; rel?: string }) {
  return (
    <ul className="forge-nav__sub">
      {items.map((item, index) => (
        <li key={`${index} ${item.href}`}>
          <NavLink item={item} rel={rel} />
        </li>
      ))}
    </ul>
  );
}

function NavLink({ item, rel }: { item: NavItem; rel?: string }) {
  const rels = [...new Set([...(rel ?? "").split(" "), ...(item.newTab ? ["noopener", "noreferrer"] : [])].filter(Boolean))].join(" ");
  return (
    <a href={item.href} rel={rels || undefined} target={item.newTab ? "_blank" : undefined}>
      {item.label}
      {item.newTab ? <span className="forge-visually-hidden"> (opens in a new tab)</span> : null}
    </a>
  );
}
