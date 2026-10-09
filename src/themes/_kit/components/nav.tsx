import type { NavItem } from "../../types";

/**
 * A menu as a list of links in a navigation landmark. Draws nothing when the
 * menu is empty (menus arrive in M8-3), rather than an empty landmark.
 */
export function Nav({ items, label, className, rel }: { items: readonly NavItem[]; label: string; className?: string; rel?: string }) {
  if (items.length === 0) return null;
  return (
    <nav aria-label={label} className={["forge-nav", className ?? ""].filter(Boolean).join(" ")}>
      <ul>
        {items.map((item) => (
          <li key={`${item.href} ${item.label}`}>
            <a href={item.href} rel={rel}>
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
