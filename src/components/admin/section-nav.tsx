"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * The row of links under the header for the pages of one organization (and,
 * since M4-1, of one site). Which links exist is decided on the server, from
 * the member's permissions; this only marks the one for the page that is open:
 * the link whose address is the longest that the page's own begins with, so
 * "Sites" stays marked on every page of a site.
 */
export function currentHref(pathname: string, hrefs: readonly string[]): string | undefined {
  const within = hrefs.filter((href) => pathname === href || pathname.startsWith(`${href}/`));
  return within.sort((a, b) => b.length - a.length)[0];
}

export function SectionNav({ label, items }: { label: string; items: { href: string; label: string }[] }) {
  const pathname = usePathname();
  const open = currentHref(pathname, items.map((item) => item.href));
  return (
    <nav aria-label={label} className="border-b">
      <ul className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-2 sm:px-4">
        {items.map((item) => {
          const current = item.href === open;
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
