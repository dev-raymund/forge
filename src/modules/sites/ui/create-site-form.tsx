"use client";

import { useState, useSyncExternalStore } from "react";
import { Field, FormAlert, SelectField, SubmitButton, useActionForm } from "@/components/admin/form";
import { createSiteAction } from "../actions";
import { suggestSiteAddress } from "../address";
import { DEFAULT_SITE_LANGUAGE, DEFAULT_SITE_TIME_ZONE, SITE_LANGUAGES } from "../locale";
import { publicSitePath } from "../paths";
import { createSiteSchema } from "../validation";

/**
 * The create-site form (plan §3, step 2; `/{orgSlug}/sites/new`): the site's
 * name, its public address, its language and its time zone. The address is
 * suggested from the name until the user types in it. The rules are the shared
 * schema's: checked here for immediate feedback, and again by the server,
 * which decides, and whose database decides whether the address is free.
 *
 * The time zone starts as the browser's own, when it is one of the list.
 */

const LANGUAGE_OPTIONS = SITE_LANGUAGES.map((language) => ({ value: language.code, label: language.label }));

const noSubscription = () => () => {};
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const serverZone = () => null;

export function CreateSiteForm({ orgSlug, timeZones }: { orgSlug: string; timeZones: readonly string[] }) {
  const { state, pending, fieldErrors, message, formProps } = useActionForm(createSiteAction.bind(null, orgSlug), createSiteSchema);
  const [name, setName] = useState(state.values?.name ?? "");
  const [address, setAddress] = useState(state.values?.address ?? "");
  const [addressEdited, setAddressEdited] = useState(false);
  const [zone, setZone] = useState<string | null>(state.values?.timezone ?? null);
  // Read after hydration: the server cannot know it, and both renders must agree first.
  const local = useSyncExternalStore(noSubscription, browserZone, serverZone);
  const timezone = zone ?? (local && timeZones.includes(local) ? local : DEFAULT_SITE_TIME_ZONE);
  const shown = address.trim().toLowerCase();

  return (
    <form {...formProps} className="grid gap-5" aria-label="Create a site">
      {message ? <FormAlert tone="error">{message}</FormAlert> : null}
      <Field
        name="name"
        label="Site name"
        required
        maxLength={80}
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          if (!addressEdited) setAddress(suggestSiteAddress(event.target.value));
        }}
        hint="Shown as the site’s title. You can change it later."
        errors={fieldErrors.name}
      />
      <Field
        name="address"
        label="Site address"
        required
        maxLength={63}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={address}
        onChange={(event) => {
          setAddress(event.target.value);
          setAddressEdited(true);
        }}
        hint={`Lowercase letters, numbers and hyphens. Your site will be at ${publicSitePath(shown || "your-site")}`}
        errors={fieldErrors.address}
      />
      <div className="grid gap-5 sm:grid-cols-2">
        <SelectField
          name="language"
          label="Language"
          options={LANGUAGE_OPTIONS}
          defaultValue={state.values?.language ?? DEFAULT_SITE_LANGUAGE}
          errors={fieldErrors.language}
        />
        <SelectField
          name="timezone"
          label="Time zone"
          options={timeZones.map((value) => ({ value, label: value.replaceAll("_", " ") }))}
          value={timezone}
          onChange={(event) => setZone(event.target.value)}
          errors={fieldErrors.timezone}
        />
      </div>
      <p className="text-sm text-muted-foreground">New sites start as Coming soon. You publish a site when it is ready.</p>
      <SubmitButton pending={pending} pendingLabel="Creating…">
        Create site
      </SubmitButton>
    </form>
  );
}
