"use client";

import { useState, useTransition } from "react";
import { FormAlert } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { MediaPicker } from "@/modules/media/shared";
import { IDLE, type FormState } from "@/platform/forms";
import { setSiteImageAction } from "../actions";

/**
 * The site's logo or favicon in its settings (M6-4): what is set now, and a picker to choose another or remove it.
 * Choosing saves at once; the server checks the image (this site's, ready, an image with that role's variants) and
 * the page shows what it saved.
 */

type Preview = { name: string; thumbUrl: string | null };

const WORDS = {
  logo: { title: "Choose a logo", description: "Shown in the site's header in place of its name, fitted in 640 × 240.", none: "None. The header shows the site's name." },
  favicon: { title: "Choose a favicon", description: "The browser tab's icon, made square at 32 and 180 pixels. A square image works best.", none: "None. Browsers show their own." },
} as const;

const messageOf = (state: FormState, fallback: string) => (state.fieldErrors ? Object.values(state.fieldErrors).flat()[0] : undefined) ?? state.message ?? fallback;

export function SiteImageField({
  orgSlug, siteSlug, role, mediaId, preview,
}: { orgSlug: string; siteSlug: string; role: "logo" | "favicon"; mediaId: string | null; preview: Preview | null }) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const words = WORDS[role];
  const label = role === "logo" ? "logo" : "favicon";

  const save = (id: string | null) =>
    startTransition(async () => {
      const data = new FormData();
      if (id) data.set("mediaId", id);
      const state = await setSiteImageAction(orgSlug, siteSlug, role, IDLE, data);
      setNotice(state.status === "error" ? { tone: "error", text: messageOf(state, `The ${label} could not be saved.`) } : { tone: "success", text: state.message ?? "Saved." });
    });

  return (
    <div className="grid gap-3" data-testid={`site-${role}`}>
      <div aria-live="polite" className="empty:hidden">
        {notice ? <FormAlert tone={notice.tone}>{notice.text}</FormAlert> : null}
      </div>
      {mediaId ? (
        <div className="flex items-center gap-3">
          {preview?.thumbUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- the site's own thumbnail variant
            <img src={preview.thumbUrl} alt="" width={64} height={64} className="size-16 rounded-md border bg-muted object-contain" data-testid={`site-${role}-preview`} />
          ) : null}
          <span className="min-w-0 text-sm wrap-anywhere">{preview ? preview.name : `This image is no longer in the media library. The site shows no ${label}.`}</span>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{words.none}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" className="h-10 px-4" disabled={pending} aria-busy={pending || undefined} onClick={() => setOpen(true)}>
          {mediaId ? `Change ${label}` : words.title}
        </Button>
        {mediaId ? (
          <Button type="button" variant="ghost" className="h-10 px-4" disabled={pending} onClick={() => save(null)}>
            Remove {label}
          </Button>
        ) : null}
      </div>
      <MediaPicker orgSlug={orgSlug} siteSlug={siteSlug} open={open} onOpenChange={setOpen} onPick={(picked) => save(picked.id)} title={words.title} description={words.description} />
    </div>
  );
}
