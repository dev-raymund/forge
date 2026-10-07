"use client";

import { LoaderCircle } from "lucide-react";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { signOutAction } from "../actions";

/**
 * Logs out, then goes to `then` (a path on this app, given by the server
 * component that renders the button) as a full page load. For a page that can
 * only be used by a different account than the one signed in: an invitation
 * sent to another address.
 */
export function SwitchAccountButton({ then, children }: { then: string; children: React.ReactNode }) {
  const [leaving, startLeaving] = useTransition();
  return (
    <Button
      type="button"
      variant="outline"
      aria-disabled={leaving || undefined}
      aria-busy={leaving || undefined}
      className="h-10 w-full focus-visible:ring-foreground/40 aria-disabled:pointer-events-none aria-disabled:opacity-70"
      onClick={() => {
        if (leaving) return;
        startLeaving(async () => {
          await signOutAction();
          window.location.assign(then);
          await new Promise(() => {}); // stay busy until the page unloads
        });
      }}
    >
      {leaving ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> : null}
      {children}
    </Button>
  );
}
