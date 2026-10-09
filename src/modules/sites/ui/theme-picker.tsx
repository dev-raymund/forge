"use client";

import { useState } from "react";
import { FormAlert, SubmitButton, useActionForm } from "@/components/admin/form";
import { chooseThemeAction } from "../actions";
import type { ThemeChoice } from "../appearance.service";
import { chooseThemeSchema } from "../validation";
import { ThemeThumbnail } from "./theme-thumbnail";

/**
 * The theme picker (M4-4; onboarding's step 3 reuses it in M4-2): the
 * registry's themes as radio cards, the one the site uses marked. Rendered only
 * for someone who may choose; the action checks again, and accepts nothing but
 * a key from the registry.
 */
export function ThemePicker({ orgSlug, siteSlug, themes, active }: { orgSlug: string; siteSlug: string; themes: ThemeChoice[]; active: string }) {
  const { state, pending, fieldErrors, message, formProps } = useActionForm(chooseThemeAction.bind(null, orgSlug, siteSlug), chooseThemeSchema);
  const current = state.status === "success" && state.values?.theme ? state.values.theme : active;
  const [selected, setSelected] = useState(current);
  const error = fieldErrors.theme?.[0];

  return (
    <form {...formProps} className="grid gap-5" aria-label="Theme">
      {message ? <FormAlert tone={state.status === "error" ? "error" : "success"}>{message}</FormAlert> : null}
      <fieldset aria-invalid={error ? true : undefined} aria-describedby={error ? "theme-error" : undefined} className="grid gap-4 sm:grid-cols-2">
        <legend className="sr-only">Theme</legend>
        {themes.map((theme) => {
          const isCurrent = theme.key === current;
          return (
            <label
              key={theme.key}
              data-testid="theme-option"
              data-theme-key={theme.key}
              className="relative grid cursor-pointer gap-3 rounded-xl border p-4 transition-colors hover:border-foreground/40 has-checked:border-foreground has-checked:ring-2 has-checked:ring-foreground/15 has-focus-visible:ring-3 has-focus-visible:ring-foreground/40"
            >
              <input
                type="radio"
                name="theme"
                value={theme.key}
                checked={selected === theme.key}
                onChange={() => setSelected(theme.key)}
                aria-describedby={`theme-${theme.key}-description`}
                className="sr-only"
              />
              <ThemeThumbnail theme={theme} />
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{theme.name}</span>
                {isCurrent ? (
                  <span className="inline-flex h-6 items-center rounded-full border border-emerald-700/30 bg-emerald-50 px-2.5 text-xs font-medium text-emerald-900" data-testid="current-theme">
                    Current theme
                  </span>
                ) : null}
              </span>
              <span id={`theme-${theme.key}-description`} className="text-sm text-muted-foreground">
                {theme.description}
              </span>
            </label>
          );
        })}
      </fieldset>
      {error ? (
        <p id="theme-error" className="text-sm font-medium text-destructive">
          {error}
        </p>
      ) : null}
      <SubmitButton pending={pending} pendingLabel="Saving…" className="w-auto justify-self-start px-4">
        Use this theme
      </SubmitButton>
    </form>
  );
}
