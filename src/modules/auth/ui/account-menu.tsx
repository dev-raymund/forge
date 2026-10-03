"use client";

import { ChevronDown, LoaderCircle, LogOut } from "lucide-react";
import { useTransition } from "react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOutAction } from "../actions";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("") || "?";

/**
 * The signed-in user's menu in the admin header. Logging out runs a Server
 * Action: the session row is deleted, the cookie cleared, then the login page.
 */
export function AccountMenu({ name, email }: { name: string; email: string }) {
  const [leaving, startLeaving] = useTransition();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account menu"
        className="flex h-10 items-center gap-2 rounded-lg px-2 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-foreground/25 aria-expanded:bg-muted"
      >
        <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
          {initials(name)}
        </span>
        <span className="hidden max-w-40 truncate sm:inline">{name}</span>
        <ChevronDown aria-hidden="true" className="size-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="grid gap-0.5">
          <span className="truncate text-sm font-medium text-foreground">{name}</span>
          <span className="truncate text-xs font-normal text-muted-foreground">{email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={leaving}
          onSelect={(event) => {
            event.preventDefault(); // keep the menu open until the redirect arrives
            startLeaving(async () => {
              // A full page load: nothing of the signed-in screens stays in the tab.
              const { redirectTo } = await signOutAction();
              window.location.assign(redirectTo ?? "/login");
              await new Promise(() => {}); // stay "leaving" until the page unloads
            });
          }}
        >
          {leaving ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <LogOut aria-hidden="true" />}
          {leaving ? "Logging out…" : "Log out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
