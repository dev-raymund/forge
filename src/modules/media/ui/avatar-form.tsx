"use client";

import { ImageUp, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { FormAlert } from "@/components/admin/form";
import { completeAvatarUploadAction, requestAvatarUploadAction } from "../actions";

type Phase = { status: "idle" | "working" | "done" | "error"; message?: string };

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("") || "?";

/**
 * The account picture (M6-2) on /account. The file goes from the browser straight to storage, then the server
 * checks it, makes a square of it and shows it. The browser only says which file; it never names the picture's URL.
 */
export function AvatarForm({ name, avatarUrl }: { name: string; avatarUrl: string | null }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [phase, setPhase] = useState<Phase>({ status: "idle" });

  async function upload(file: File) {
    setPhase({ status: "working" });
    try {
      const requested = await requestAvatarUploadAction({ name: file.name, size: file.size, type: file.type });
      if (!requested.ok) return setPhase({ status: "error", message: requested.error });
      const { upload: target, avatarId } = requested.data;
      const sent = await fetch(target.url, { method: target.method, headers: target.headers, body: file }).catch(() => null);
      if (!sent?.ok) return setPhase({ status: "error", message: "The picture did not reach storage. Try again." });
      const done = await completeAvatarUploadAction(avatarId);
      if (!done.ok) return setPhase({ status: "error", message: done.error });
      setPhase({ status: "done", message: "Picture updated." });
      router.refresh();
    } catch {
      setPhase({ status: "error", message: "Something went wrong. Try again." });
    } finally {
      if (input.current) input.current.value = "";
    }
  }

  const working = phase.status === "working";
  return (
    <div className="grid max-w-sm gap-4" aria-label="Picture" role="group">
      {phase.message ? <FormAlert tone={phase.status === "error" ? "error" : "success"}>{phase.message}</FormAlert> : null}
      <div className="flex items-center gap-4">
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- served as it is by /media; no optimizer in between
          <img src={avatarUrl} alt="Your picture" width={64} height={64} data-testid="avatar-preview" className="size-16 rounded-full object-cover" />
        ) : (
          <span aria-hidden="true" data-testid="avatar-initials" className="flex size-16 items-center justify-center rounded-full bg-primary text-lg font-medium text-primary-foreground">
            {initials(name)}
          </span>
        )}
        <div className="grid gap-1">
          <label
            htmlFor={inputId}
            aria-disabled={working}
            className="inline-flex h-9 w-fit cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm font-medium outline-none hover:bg-muted focus-within:ring-3 focus-within:ring-foreground/25 aria-disabled:pointer-events-none aria-disabled:opacity-60"
          >
            {working ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> : <ImageUp aria-hidden="true" className="size-4" />}
            {working ? "Uploading…" : avatarUrl ? "Change picture" : "Upload a picture"}
            <input
              ref={input}
              id={inputId}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="sr-only"
              disabled={working}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void upload(file);
              }}
            />
          </label>
          <p className="text-xs text-muted-foreground">JPEG, PNG, WebP or GIF, up to 20 MB. It is cropped to a square.</p>
        </div>
      </div>
    </div>
  );
}
