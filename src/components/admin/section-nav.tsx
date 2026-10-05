"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * The row of links under the header for the pages of one organization. Which
 * links exist is decided on the server, from the member's permissions; this
 * only marks the one for the page that is open.
 */
export function SectionNav({ label, items }: { label: string; items: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="border-b">
      <ul className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-2 sm:px-4">
        {items.map((item) => {
          const current = pathname === item.href;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "-mb-px flex h-11 items-center border-b-2 border-transparent px-2 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-foreground/25",
                  current && "border-foreground font-medium text-foreground",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
