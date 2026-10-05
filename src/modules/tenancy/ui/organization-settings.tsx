"use client";

import { TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { z } from "zod";
import { CONTROL, Field, FormAlert, SubmitButton, useActionForm } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { FormState } from "@/platform/forms";
import { changeOrganizationSlugAction, renameOrganizationAction, transferOwnershipAction } from "../actions";
import { orgPath } from "../paths";
import { createOrganizationSchema } from "../validation";

/**
 * The forms of an organization's settings page (M3-3). The page decides, on
 * the server, which of them to render: these components are never told a role.
 * Each action is bound to the slug in the page's URL, and the server works out
 * from the session what the caller may do there.
 */

// One field each, with the rules of the shared schema.
const nameSchema = createOrganizationSchema.pick({ name: true });
const slugSchema = createOrganizationSchema.pick({ slug: true });

function Outcome({ state, message }: { state: FormState; message: string | undefined }) {
  if (!message) return null;
  return <FormAlert tone={state.status === "error" ? "error" : "success"}>{message}</FormAlert>;
}

export function RenameOrganizationForm({ orgSlug, name }: { orgSlug: string; name: string }) {
  const { state, pending, fieldErrors, message, formProps } = useActionForm(renameOrganizationAction.bind(null, orgSlug), nameSchema);
  return (
    <form {...formProps} className="grid max-w-sm gap-4" aria-label="Organization name">
      <Outcome state={state} message={message} />
      <Field name="name" label="Name" autoComplete="organization" required maxLength={80} defaultValue={state.values?.name ?? name} errors={fieldErrors.name} />
      <SubmitButton pending={pending} pendingLabel="Saving…" className="w-auto justify-self-start px-4">
        Save name
      </SubmitButton>
    </form>
  );
}

export function ChangeOrganizationSlugForm({ orgSlug }: { orgSlug: string }) {
  const { state, pending, fieldErrors, message, formProps } = useActionForm(changeOrganizationSlugAction.bind(null, orgSlug), slugSchema);
  return (
    <form {...formProps} className="grid max-w-sm gap-4" aria-label="Organization URL">
      <Outcome state={state} message={message} />
      <Field
        name="slug"
        label="URL"
        required
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        defaultValue={state.values?.slug ?? orgSlug}
        hint={`Now: ${orgPath(orgSlug)}. Lowercase letters, numbers and hyphens.`}
        errors={fieldErrors.slug}
      />
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>Changing the URL breaks links and bookmarks to this organization&rsquo;s pages in Forge. Your published sites are not affected.</span>
      </p>
      <SubmitButton pending={pending} pendingLabel="Changing…" className="w-auto justify-self-start px-4">
        Change URL
      </SubmitButton>
    </form>
  );
}

export type TransferCandidate = { memberId: string; name: string; email: string; role: string };

/**
 * Handing the organization over. It takes three deliberate things: opening
 * this dialog, choosing the member, and typing the organization's URL. The
 * server checks all of it again, and that the caller is an Owner.
 */
export function TransferOwnership({ orgSlug, orgName, candidates }: { orgSlug: string; orgName: string; candidates: TransferCandidate[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="h-10 justify-self-start px-4 focus-visible:ring-foreground/40">
          Transfer ownership…
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {/* Mounted with the dialog, so a cancelled attempt leaves nothing typed behind. */}
        <TransferForm orgSlug={orgSlug} orgName={orgName} candidates={candidates} onCancel={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function TransferForm({ orgSlug, orgName, candidates, onCancel }: { orgSlug: string; orgName: string; candidates: TransferCandidate[]; onCancel: () => void }) {
  const schema = z.object({
    // A select left on its placeholder sends no value at all.
    memberId: z.string("Choose who will become the Owner.").min(1, "Choose who will become the Owner."),
    confirm: z.string().refine((value) => value.trim().toLowerCase() === orgSlug, `Type ${orgSlug} to confirm.`),
  });
  const { state, pending, fieldErrors, message, formProps } = useActionForm(transferOwnershipAction.bind(null, orgSlug), schema);
  const selectId = useId();
  const memberError = fieldErrors.memberId?.[0];

  return (
    <form {...formProps} className="grid gap-4" aria-label="Transfer ownership">
      <DialogHeader>
        <DialogTitle>Transfer ownership of {orgName}</DialogTitle>
        <DialogDescription>
          The person you choose becomes an Owner. <strong className="font-medium text-foreground">You will no longer be an Owner of this organization</strong>: you
          become an Admin, and can no longer rename it, change its URL, manage billing or transfer it. Only an Owner can make you one again.
        </DialogDescription>
      </DialogHeader>
      {message ? <FormAlert tone="error">{message}</FormAlert> : null}

      <div className="grid gap-2">
        <Label htmlFor={selectId}>New Owner</Label>
        <select
          id={selectId}
          name="memberId"
          required
          defaultValue={state.values?.memberId ?? ""}
          aria-invalid={memberError ? true : undefined}
          aria-describedby={memberError ? `${selectId}-error` : undefined}
          className={cn(
            "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:ring-3 aria-invalid:border-destructive md:text-sm",
            CONTROL,
          )}
        >
          <option value="" disabled>
            Choose a member
          </option>
          {candidates.map((candidate) => (
            <option key={candidate.memberId} value={candidate.memberId}>
              {candidate.name} ({candidate.email}), {candidate.role}
            </option>
          ))}
        </select>
        {memberError ? (
          <p id={`${selectId}-error`} className="text-sm font-medium text-destructive">
            {memberError}
          </p>
        ) : null}
      </div>

      <Field
        name="confirm"
        label={`Type ${orgSlug} to confirm`}
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
        <SubmitButton pending={pending} pendingLabel="Transferring…" className="w-auto px-4">
          Transfer ownership
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}
