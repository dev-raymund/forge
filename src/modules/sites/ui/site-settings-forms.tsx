"use client";

import { z } from "zod";
import { Field, FormAlert, SelectField, SubmitButton, useActionForm } from "@/components/admin/form";
import type { FormState } from "@/platform/forms";
import { updateSiteSettingsAction } from "../actions";
import { SITE_LANGUAGES } from "../locale";
import { publicSitePath } from "../paths";
import { analyticsSettingsSchema, generalSettingsSchema, POSTS_PER_PAGE_MAX, readingSettingsSchema, SOCIAL_NETWORKS } from "../settings";

/**
 * The site's settings forms (M4-2): general, reading, analytics. Each saves
 * its own group through the same action, bound to the page's URL and to its
 * group. The page decides who sees them; the action decides who may save.
 * Each carries the settings' `version` as rendered, so a save over someone
 * else's newer one is refused.
 */

/**
 * The browser-side check: the group's rules, plus the version. Not strict: a
 * form bound to a Server Action also carries React's own hidden fields. The
 * server reads only the group's fields, and checks them strictly.
 */
const versioned = <S extends z.ZodObject>(schema: S) => z.object({ ...schema.shape, version: z.string() });
const LANGUAGE_OPTIONS = SITE_LANGUAGES.map((language) => ({ value: language.code, label: language.label }));
const BUTTON = "w-auto justify-self-start px-4";

function Outcome({ state, message }: { state: FormState; message: string | undefined }) {
  if (!message) return null;
  return <FormAlert tone={state.status === "error" ? "error" : "success"}>{message}</FormAlert>;
}

type Bound = { orgSlug: string; siteSlug: string; version: number };

export function GeneralSettingsForm({ orgSlug, siteSlug, version, values, timeZones }: Bound & { values: Record<string, string>; timeZones: readonly string[] }) {
  const { state, pending, fieldErrors, message, formProps } = useActionForm(
    updateSiteSettingsAction.bind(null, orgSlug, siteSlug, "general"),
    versioned(generalSettingsSchema),
  );
  const shown = state.status === "error" && state.values ? state.values : values;
  return (
    <form {...formProps} className="grid max-w-xl gap-5" aria-label="General settings">
      <Outcome state={state} message={message} />
      <input type="hidden" name="version" value={version} />
      <Field name="name" label="Site name" required maxLength={80} defaultValue={shown.name} errors={fieldErrors.name} />
      <Field name="tagline" label="Tagline" maxLength={200} defaultValue={shown.tagline} hint="A short line under the site’s name. Optional." errors={fieldErrors.tagline} />
      <div className="grid gap-5 sm:grid-cols-2">
        <SelectField name="language" label="Language" options={LANGUAGE_OPTIONS} defaultValue={shown.language} errors={fieldErrors.language} />
        <SelectField
          name="timezone"
          label="Time zone"
          options={timeZones.map((value) => ({ value, label: value.replaceAll("_", " ") }))}
          defaultValue={shown.timezone}
          hint="For the dates on your posts."
          errors={fieldErrors.timezone}
        />
      </div>
      <fieldset className="grid gap-4">
        <legend className="mb-1 text-sm font-medium">Social links</legend>
        <p className="-mt-2 text-sm text-muted-foreground">Shown in your site’s footer. Full addresses starting with https://. Leave empty for none.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {SOCIAL_NETWORKS.map((network) => (
            <Field
              key={network.key}
              name={network.key}
              label={network.label}
              type="url"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={300}
              defaultValue={shown[network.key] ?? ""}
              errors={fieldErrors[network.key]}
            />
          ))}
        </div>
      </fieldset>
      <SubmitButton pending={pending} pendingLabel="Saving…" className={BUTTON}>
        Save general settings
      </SubmitButton>
    </form>
  );
}

export function ReadingSettingsForm({ orgSlug, siteSlug, version, values, address }: Bound & { values: { blogPath: string; postsPerPage: number }; address: string }) {
  const { state, pending, fieldErrors, message, formProps } = useActionForm(
    updateSiteSettingsAction.bind(null, orgSlug, siteSlug, "reading"),
    versioned(readingSettingsSchema),
  );
  const shown = state.status === "error" && state.values ? state.values : { blogPath: values.blogPath, postsPerPage: String(values.postsPerPage) };
  return (
    <form {...formProps} className="grid max-w-xl gap-5" aria-label="Reading settings">
      <Outcome state={state} message={message} />
      <input type="hidden" name="version" value={version} />
      <p className="text-sm text-muted-foreground">These apply to your site’s posts, which arrive with the editor. Until then they are saved, and nothing on the site uses them.</p>
      <Field
        name="blogPath"
        label="Blog path"
        required
        maxLength={40}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        defaultValue={shown.blogPath}
        hint={`Your posts will be at ${publicSitePath(address)}/${shown.blogPath || "blog"}.`}
        errors={fieldErrors.blogPath}
      />
      <Field
        name="postsPerPage"
        label="Posts per page"
        type="number"
        inputMode="numeric"
        min={1}
        max={POSTS_PER_PAGE_MAX}
        required
        className="max-w-32"
        defaultValue={shown.postsPerPage}
        errors={fieldErrors.postsPerPage}
      />
      <SubmitButton pending={pending} pendingLabel="Saving…" className={BUTTON}>
        Save reading settings
      </SubmitButton>
    </form>
  );
}

export function AnalyticsSettingsForm({ orgSlug, siteSlug, version, values }: Bound & { values: { ga4MeasurementId: string; plausibleDomain: string } }) {
  const { state, pending, fieldErrors, message, formProps } = useActionForm(
    updateSiteSettingsAction.bind(null, orgSlug, siteSlug, "analytics"),
    versioned(analyticsSettingsSchema),
  );
  const shown = state.status === "error" && state.values ? state.values : values;
  return (
    <form {...formProps} className="grid max-w-xl gap-5" aria-label="Analytics settings">
      <Outcome state={state} message={message} />
      <input type="hidden" name="version" value={version} />
      <p className="text-sm text-muted-foreground">
        Forge adds the official tracking code of these two services to your site’s pages once the site is live. No other code can be added. Leave a field empty to turn that service off.
      </p>
      <Field
        name="ga4MeasurementId"
        label="Google Analytics 4 measurement ID"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        maxLength={20}
        defaultValue={shown.ga4MeasurementId}
        hint="Starts with G-, for example G-ABC123XYZ9."
        errors={fieldErrors.ga4MeasurementId}
      />
      <Field
        name="plausibleDomain"
        label="Plausible domain"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        maxLength={253}
        defaultValue={shown.plausibleDomain}
        hint="The domain the site is set up under at Plausible, for example example.com."
        errors={fieldErrors.plausibleDomain}
      />
      <SubmitButton pending={pending} pendingLabel="Saving…" className={BUTTON}>
        Save analytics settings
      </SubmitButton>
    </form>
  );
}
