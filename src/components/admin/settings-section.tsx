import { useId } from "react";

/** One block of a settings page (account, organization): a heading, an optional line of explanation, the content. */
export function SettingsSection({ title, description, children }: { title: string; description?: React.ReactNode; children: React.ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid gap-4 border-t py-8 first:border-t-0 first:pt-0">
      <div className="grid gap-1">
        <h2 id={id} className="text-base font-semibold tracking-tight">
          {title}
        </h2>
        {description ? <p className="max-w-prose text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}
