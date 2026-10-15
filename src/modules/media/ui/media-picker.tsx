"use client";

import { ImageIcon, LoaderCircle } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { FormAlert } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { UploadDropzone } from "./upload-dropzone";

/**
 * The media picker (M6-4; plan §8 "the same library in a modal"): the site's images, searched and narrowed to a
 * folder, from `/api/app/media` (the library's own query: ready, untrashed images of this site only), and the
 * dropzone to upload new ones. Choosing an image returns it and changes nothing: no upload, no edit of the item.
 * Uploading puts files in the library, where they can then be chosen. Used by the image block, a post's featured
 * image, and the site's logo and favicon. The server checks every choice again where it is saved.
 */

export type PickedImage = { id: string; name: string; filename: string; altText: string; thumbUrl: string | null; width: number | null; height: number | null; folderId: string | null };
type Page = { items: PickedImage[]; hasMore: boolean; folders: { id: string; name: string; files: number }[]; canUpload: boolean };
type State = { status: "loading" } | { status: "error"; message: string } | ({ status: "ready" } & Page);

const SELECT = "h-10 min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:ring-3 focus-visible:ring-foreground/25 md:text-sm";

export function MediaPicker({
  orgSlug, siteSlug, open, onOpenChange, onPick, title = "Choose an image", description = "An image of this site's media library.",
}: {
  orgSlug: string;
  siteSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (image: PickedImage) => void;
  title?: string;
  description?: string;
}) {
  const ids = { search: useId(), folder: useId() };
  const [query, setQuery] = useState("");
  const [typed, setTyped] = useState("");
  const [folder, setFolder] = useState("");
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<State>({ status: "loading" });
  const [items, setItems] = useState<PickedImage[]>([]);

  // The search waits for typing to pause.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), 250);
    return () => clearTimeout(timer);
  }, [typed]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ org: orgSlug, site: siteSlug, page: String(page) });
    if (query) params.set("q", query);
    if (folder) params.set("folder", folder);
    fetch(`/api/app/media?${params}`, { signal: controller.signal, headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 403 ? "You can't choose media on this site." : "The media library could not be loaded.");
        const data = (await response.json()) as Page;
        setItems((current) => (page === 1 ? data.items : [...current, ...data.items.filter((item) => !current.some((c) => c.id === item.id))]));
        setState({ status: "ready", ...data });
      })
      .catch((error: Error) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: error.message || "The media library could not be loaded." });
      });
    return () => controller.abort();
  }, [open, orgSlug, siteSlug, query, folder, page, reload]);

  const restart = () => {
    setState({ status: "loading" });
    setPage(1);
    setReload((n) => n + 1);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl" data-testid="media-picker">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end gap-2">
          <div className="grid min-w-0 flex-1 gap-1">
            <label htmlFor={ids.search} className="text-sm font-medium">
              Search
            </label>
            <input
              id={ids.search}
              type="search"
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value);
                setPage(1);
              }}
              placeholder="Title, file name or alternative text"
              className={`${SELECT} w-full`}
            />
          </div>
          {state.status === "ready" && state.folders.length ? (
            <div className="grid gap-1">
              <label htmlFor={ids.folder} className="text-sm font-medium">
                Folder
              </label>
              <select
                id={ids.folder}
                value={folder}
                onChange={(event) => {
                  setFolder(event.target.value);
                  setPage(1);
                }}
                className={SELECT}
              >
                <option value="">All media</option>
                <option value="none">In no folder</option>
                {state.folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>

        {state.status === "error" ? (
          <div className="grid gap-2">
            <FormAlert tone="error">{state.message}</FormAlert>
            <Button type="button" variant="outline" className="h-9 justify-self-start px-3" onClick={restart}>
              Try again
            </Button>
          </div>
        ) : state.status === "loading" && !items.length ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
            Loading the images…
          </p>
        ) : items.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground" data-testid="picker-empty">
            {query || folder ? "No image matches." : "This site has no images yet. Upload one below."}
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Images" data-testid="picker-items">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(item);
                    onOpenChange(false);
                  }}
                  aria-label={`Choose ${item.name}`}
                  data-testid="picker-item"
                  data-name={item.name}
                  className="grid w-full gap-1 rounded-lg border p-1.5 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-foreground/25"
                >
                  {item.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- the square thumbnail variant, from /media
                    <img src={item.thumbUrl} alt="" width={400} height={400} loading="lazy" className="aspect-square w-full rounded-md bg-muted object-cover" />
                  ) : (
                    <span className="flex aspect-square w-full items-center justify-center rounded-md bg-muted">
                      <ImageIcon aria-hidden="true" className="size-8" />
                    </span>
                  )}
                  <span className="truncate text-xs">{item.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {state.status === "ready" && state.hasMore ? (
          <Button type="button" variant="outline" className="h-9 justify-self-start px-3" onClick={() => setPage((n) => n + 1)}>
            Show more
          </Button>
        ) : null}

        {state.status === "ready" && state.canUpload ? (
          <details className="rounded-lg border p-3">
            <summary className="cursor-pointer text-sm font-medium">Upload new images</summary>
            <div className="mt-3">
              <UploadDropzone
                orgSlug={orgSlug}
                siteSlug={siteSlug}
                folders={state.folders}
                folderId={folder && folder !== "none" ? folder : null}
                imagesOnly
                refreshOnReady={false}
                onReady={restart}
              />
            </div>
          </details>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
