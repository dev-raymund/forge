"use client";

import { Building2, Check, ChevronsUpDown } from "lucide-react";
import Link from "next/link";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { orgSitesPath } from "../paths";

export type SwitcherOrganization = { slug: string; name: string; suspended: boolean };

/**
 * The organization switcher in the admin header. It is a list of links:
 * choosing an organization goes to its URL, and the URL is what says which
 * organization a page is about (D-08). Nothing is remembered here. The list
 * and the current slug both come from the server, for the signed-in user.
 */
export function OrgSwitcher({ organizations, currentSlug }: { organizations: SwitcherOrganization[]; currentSlug?: string }) {
  const current = organizations.find((organization) => organization.slug === currentSlug);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={current ? `Switch organization. Current: ${current.name}` : "Switch organization"}
        className="flex h-10 min-w-0 items-center gap-2 rounded-lg px-2 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-foreground/25 aria-expanded:bg-muted"
      >
        <Building2 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate" data-testid="current-organization">
          {current?.name ?? "Organizations"}
        </span>
        <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Your organizations</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {organizations.map((organization) => {
          const isCurrent = organization.slug === currentSlug;
          return (
            <DropdownMenuItem key={organization.slug} asChild>
              <Link href={orgSitesPath(organization.slug)} aria-current={isCurrent ? "true" : undefined}>
                <span className="min-w-0 flex-1 truncate">{organization.name}</span>
                {organization.suspended ? <span className="text-xs text-muted-foreground">Suspended</span> : null}
                {isCurrent ? <Check aria-hidden="true" /> : null}
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
