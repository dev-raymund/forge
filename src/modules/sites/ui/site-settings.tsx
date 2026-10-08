"use client";

import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { Field, FormAlert, SubmitButton, useActionForm } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { changeSiteAddressAction, deleteSiteAction } from "../actions";
import { publicSitePath } from "../paths";
import { changeSiteAddressSchema } from "../validation";

/**
 * The forms of a site's settings page (M4-1: its address, and deleting it).
 * The page decides, on the server, which of them to render: these components
 * are never told a role. Each action is bound to the slugs in the page's URL,
 * and the server works out from the session what the caller may do there.
 */

export function SiteAddressForm({ orgSlug, siteSlug, address }: { orgSlug: string; siteSlug: string; address: string }) {
  const { state, pending, fieldErrors, message, formProps } = useActionForm(changeSiteAddressAction.bind(null, orgSlug, siteSlug), changeSiteAddressSchema);
  const current = state.status === "success" && state.values?.address ? state.values.address : address;
  return (
    <form {...formProps} className="grid max-w-sm gap-4" aria-label="Site address">
      {message ? <FormAlert tone={state.status === "error" ? "error" : "success"}>{message}</FormAlert> : null}
      <Field
        // Remounted when the address changes, so the field shows what was saved.
        key={current}
        name="address"
        label="Address"
        required
        maxLength={63}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        defaultValue={state.status === "error" ? (state.values?.address ?? current) : current}
        hint={`Now: ${publicSitePath(current)}. Lowercase letters, numbers and hyphens.`}
        errors={fieldErrors.address}
      />
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>Links to the old address stop working at once, and anyone can then claim it for another site.</span>
      </p>
      <SubmitButton pending={pending} pendingLabel="Changing…" className="w-auto justify-self-start px-4">
        Change address
      </SubmitButton>
    </form>
  );
}

/**
 * Deleting the site. It takes two deliberate things: opening this dialog and
 * typing the site's address. The server checks it again, and that the caller
 * is an Owner.
 */
export function DeleteSite({ orgSlug, siteSlug, siteName, confirmWith }: { orgSlug: string; siteSlug: string; siteName: string; confirmWith: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="destructive" className="h-10 justify-self-start px-4 focus-visible:ring-foreground/40">
          Delete site…
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {/* Mounted with the dialog, so a cancelled attempt leaves nothing typed behind. */}
        <DeleteForm orgSlug={orgSlug} siteSlug={siteSlug} siteName={siteName} confirmWith={confirmWith} onCancel={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function DeleteForm({ orgSlug, siteSlug, siteName, confirmWith, onCancel }: { orgSlug: string; siteSlug: string; siteName: string; confirmWith: string; onCancel: () => void }) {
  const schema = z.object({ confirm: z.string().refine((value) => value.trim().toLowerCase() === confirmWith, `Type ${confirmWith} to confirm.`) });
  const { pending, fieldErrors, message, formProps } = useActionForm(deleteSiteAction.bind(null, orgSlug, siteSlug), schema);
  return (
    <form {...formProps} className="grid gap-4" aria-label="Delete site">
      <DialogHeader>
        <DialogTitle>Delete {siteName}</DialogTitle>
        <DialogDescription>
          The site goes offline: <strong className="font-medium text-foreground">{publicSitePath(confirmWith)}</strong> stops showing it, and the address
          becomes free for anyone. It disappears from your sites. This cannot be undone here.
        </DialogDescription>
      </DialogHeader>
      {message ? <FormAlert tone="error">{message}</FormAlert> : null}
      <Field
        name="confirm"
        label={`Type ${confirmWith} to confirm`}
        required
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        errors={fieldErrors.confirm}
      />
      <DialogFooter>
        <Button type="button" variant="outline" className="h-10 px-4 focus-visible:ring-foreground/40" onClick={onCancel}>
          Cancel
        </Button>
        <SubmitButton pending={pending} pendingLabel="Deleting…" className="w-auto px-4">
          Delete site
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}
