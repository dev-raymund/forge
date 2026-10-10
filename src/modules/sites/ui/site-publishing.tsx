"use client";

import { ExternalLink, Globe, Info } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { z } from "zod";
import { FormAlert, SubmitButton, useActionForm } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { setSiteStatusAction } from "../actions";

/**
 * Publishing a site, and switching it back to Coming soon (M4-5, ADR 0015).
 * The page decides, on the server, whether to render this at all; the action
 * asks the server again. The form sends the status it asks for and nothing
 * else: the site comes from the URL, the permission from the session.
 */

export type SiteStatusControlProps = {
  orgSlug: string;
  siteSlug: string;
  siteName: string;
  status: "coming_soon" | "live";
  /** The site's public address, in full (APP_ORIGIN + /s/{address}). */
  publicUrl: string;
  /** The member may change the status but has not verified their email address: publishing waits for that. */
  mustVerifyEmail: boolean;
};

const schema = z.object({ status: z.enum(["coming_soon", "live"]) });

const BUTTON = "h-10 px-4 focus-visible:ring-foreground/40";

export function SiteStatusControl({ orgSlug, siteSlug, siteName, status, publicUrl, mustVerifyEmail }: SiteStatusControlProps) {
  const [open, setOpen] = useState(false);
  const { state, pending, message, formProps } = useActionForm(setSiteStatusAction.bind(null, orgSlug, siteSlug), schema);
  const done = useRef<HTMLDivElement>(null);

  // A new answer from the server: once it is a success, the dialog has done its job (the page re-renders with the new status).
  const [answered, setAnswered] = useState(state);
  // Set when the dialog closes because it succeeded: focus then goes to the message, not back to the (changed) button.
  const [announce, setAnnounce] = useState(false);
  if (state !== answered) {
    setAnswered(state);
    if (state.status === "success") {
      setOpen(false);
      setAnnounce(true);
    }
  }

  const publishing = status === "coming_soon";
  const target = publishing ? "live" : "coming_soon";
  const succeeded = state.status === "success" && message;

  return (
    <div id="publish" className="mt-5 grid gap-3" data-testid="site-publishing">
      {succeeded ? (
        <div ref={done}>
          <FormAlert tone="success">
            {message}{" "}
            {status === "live" ? (
              <a href={publicUrl} data-testid="published-link">
                View your site
              </a>
            ) : null}
          </FormAlert>
        </div>
      ) : null}

      {publishing && mustVerifyEmail ? (
        <p className="flex items-start gap-2 text-sm text-muted-foreground" data-testid="publish-needs-verification">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            Verify your email address to publish this site.{" "}
            <Link href="/verify-email" className="font-medium text-foreground underline underline-offset-4 hover:no-underline">
              Verify email
            </Link>
          </span>
        </p>
      ) : (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            {publishing ? (
              <Button className={`${BUTTON} justify-self-start`}>
                <Globe aria-hidden="true" className="size-4" />
                Publish site…
              </Button>
            ) : (
              <Button variant="outline" className={`${BUTTON} justify-self-start`}>
                Switch to Coming soon…
              </Button>
            )}
          </DialogTrigger>
          <DialogContent
            className="sm:max-w-md"
            onCloseAutoFocus={(event) => {
              // The button that opened the dialog is gone once the status changed: say what happened instead.
              const alert = announce ? done.current?.querySelector<HTMLElement>("[data-form-alert]") : null;
              setAnnounce(false);
              if (!alert) return;
              event.preventDefault();
              alert.focus();
            }}
          >
            <form {...formProps} className="grid gap-4" aria-label={publishing ? "Publish site" : "Switch to Coming soon"}>
              <input type="hidden" name="status" value={target} />
              <DialogHeader>
                <DialogTitle>{publishing ? `Publish ${siteName}?` : `Switch ${siteName} back to Coming soon?`}</DialogTitle>
                <DialogDescription>
                  {publishing ? "The site goes from Coming soon to live at " : "Visitors to "}
                  <strong className="font-medium break-all text-foreground" data-testid="publish-url">
                    {publicUrl}
                  </strong>
                  {publishing ? "." : " see the Coming soon page again. The address stays the same."}
                </DialogDescription>
              </DialogHeader>
              {publishing ? (
                <ul className="grid list-disc gap-1.5 pl-5 text-sm text-muted-foreground" data-testid="publish-consequences">
                  <li>Visitors see your site instead of the Coming soon page, and search engines may list it.</li>
                  <li>
                    For now, your site&rsquo;s home page shows its name and tagline in its theme. Adding pages and posts is not available yet.
                  </li>
                  <li>You can switch it back to Coming soon at any time.</li>
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Search engines are asked not to list the site while it is Coming soon.</p>
              )}
              {message && state.status === "error" ? <FormAlert tone="error">{message}</FormAlert> : null}
              <DialogFooter>
                <Button type="button" variant="outline" className={BUTTON} onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <SubmitButton pending={pending} pendingLabel={publishing ? "Publishing…" : "Switching…"} className="w-auto px-4">
                  {publishing ? "Publish site" : "Switch to Coming soon"}
                </SubmitButton>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}

      {status === "live" && !succeeded ? (
        <a href={publicUrl} className="inline-flex items-center gap-1.5 justify-self-start text-sm font-medium underline underline-offset-4 hover:no-underline" data-testid="view-site">
          View your site
          <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
        </a>
      ) : null}
    </div>
  );
}
