"use client";

import { useState } from "react";
import { Field, FormAlert, SubmitButton, useActionForm } from "@/components/admin/form";
import { createOrganizationAction } from "../actions";
import { orgPath } from "../paths";
import { suggestOrgSlug } from "../slugs";
import { createOrganizationSchema } from "../validation";

/**
 * Onboarding, step 1: name the organization and choose its URL. The URL is
 * suggested from the name until the user types in it themselves. The rules are
 * the shared schema's (./validation.ts): checked here for immediate feedback,
 * and again by the server, which decides.
 */
export function CreateOrganizationForm({ trialDays }: { trialDays: number }) {
  const { state, pending, fieldErrors, message, formProps } = useActionForm(createOrganizationAction, createOrganizationSchema);
  const [name, setName] = useState(state.values?.name ?? "");
  const [slug, setSlug] = useState(state.values?.slug ?? "");
  const [slugEdited, setSlugEdited] = useState(false);

  return (
    <form {...formProps} className="grid gap-5" aria-label="Create your organization">
      {message ? <FormAlert tone="error">{message}</FormAlert> : null}
      <Field
        name="name"
        label="Organization name"
        autoComplete="organization"
        required
        maxLength={80}
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          if (!slugEdited) setSlug(suggestOrgSlug(event.target.value));
        }}
        hint="Your company, agency or team. You can change it later."
        errors={fieldErrors.name}
      />
      <Field
        name="slug"
        label="URL"
        required
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={slug}
        onChange={(event) => {
          setSlug(event.target.value);
          setSlugEdited(true);
        }}
        hint={`Lowercase letters, numbers and hyphens. Your organization will be at ${orgPath(slug.trim().toLowerCase() || "your-organization")}`}
        errors={fieldErrors.slug}
      />
      <p className="text-sm text-muted-foreground">
        You will be the Owner. A {trialDays}-day Pro trial starts now, with no card needed.
      </p>
      <SubmitButton pending={pending} pendingLabel="Creating…">
        Create organization
      </SubmitButton>
    </form>
  );
}
