"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { embed, providerOf } from "@/blocks/embed/schema";

/**
 * Adding a video or an embedded page (M5-5): an embed is made from an address,
 * so it is asked for first and checked with the block's own schema (YouTube
 * and Vimeo through their privacy players; any other https page only if it is
 * URL-safe). Nothing is inserted until the address is valid: an empty embed
 * would make the whole document unsavable.
 */
const PLACEHOLDER_ID = "00000000-0000-7000-8000-000000000000";

export function EmbedDialog({ open, onOpenChange, onInsert }: { open: boolean; onOpenChange: (open: boolean) => void; onInsert: (attrs: Record<string, unknown>) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">{open ? <EmbedForm onInsert={onInsert} close={() => onOpenChange(false)} /> : null}</DialogContent>
    </Dialog>
  );
}

function EmbedForm({ onInsert, close }: { onInsert: (attrs: Record<string, unknown>) => void; close: () => void }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  return (
    <form
      className="grid gap-4"
      aria-label="Video or embed"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const attrs = { ...embed.defaults, provider: providerOf(url.trim()), url: url.trim() };
        const parsed = embed.attrs.safeParse({ ...attrs, id: PLACEHOLDER_ID });
        if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "That address cannot be embedded.");
        onInsert(attrs);
        close();
      }}
    >
      <DialogHeader>
        <DialogTitle>Video or embed</DialogTitle>
        <DialogDescription>A YouTube or Vimeo video, or an https:// page that allows being embedded (a map, a form).</DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor={id}>Address</Label>
        <Input
          id={id}
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            setError(null);
          }}
          placeholder="https://www.youtube.com/watch?v=…"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className="h-10"
          autoFocus
        />
        {error ? (
          <p id={`${id}-error`} className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" className="h-10 px-4" onClick={close}>
          Cancel
        </Button>
        <Button type="submit" className="h-10 px-4">
          Add
        </Button>
      </DialogFooter>
    </form>
  );
}
