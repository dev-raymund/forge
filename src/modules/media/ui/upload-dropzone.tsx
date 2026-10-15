"use client";

import { CircleCheck, CircleX, FileText, ImageIcon, LoaderCircle, RotateCw, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/modules/billing/shared";
import { completeUploadAction, requestUploadsAction } from "../actions";
import { ACCEPTED_LABEL } from "../policy";
import { afterComplete, afterLateConflict, afterRequest, afterSend, batchesOf, itemOf, linkValid, summaryOf, type QueueItem, type Target } from "./upload-queue";

/**
 * The library's dropzone (M6-3): files chosen or dropped are checked here (a warning only), requested from the server
 * in groups of at most 20 (each all or nothing), sent straight to storage with progress, and completed one by one on
 * the server, which checks them and processes images. A file is shown ready only when the server says it is.
 * Retrying does only what the upload's state allows (./upload-queue.ts).
 */

const PARALLEL_SENDS = 3;
const STATUS_LABEL: Record<QueueItem["status"], string> = {
  waiting: "Waiting",
  requesting: "Preparing",
  sending: "Uploading",
  finishing: "Finishing",
  ready: "Ready",
  failed: "Failed",
  refused: "Refused",
};

/** Sends the file to its target, with progress. Resolves with the storage's HTTP status (0: no answer at all). */
function put(target: Target, file: File, onProgress: (fraction: number) => void): Promise<number> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open(target.method, target.url);
    for (const [name, value] of Object.entries(target.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => resolve(xhr.status);
    xhr.onerror = () => resolve(0);
    xhr.onabort = () => resolve(0);
    xhr.ontimeout = () => resolve(0);
    xhr.send(file);
  });
}

const noSubscription = () => () => {};

export function UploadDropzone({
  orgSlug, siteSlug, folders, folderId, imagesOnly = false, refreshOnReady = true, onReady,
}: {
  orgSlug: string;
  siteSlug: string;
  folders: { id: string; name: string }[];
  folderId: string | null;
  /** In the picker (M6-4): only images are offered and accepted here; a PDF belongs in the library. */
  imagesOnly?: boolean;
  /** The library page re-renders after files are ready; the picker inside the editor asks its own list instead. */
  refreshOnReady?: boolean;
  onReady?: (mediaId: string) => void;
}) {
  const router = useRouter();
  // Files can be chosen only once this is running: a choice made before the page is interactive would be lost.
  const interactive = useSyncExternalStore(noSubscription, () => true, () => false);
  const inputId = useId();
  const folderSelectId = useId();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [folder, setFolder] = useState(folderId ?? "");
  const [over, setOver] = useState(false);
  const files = useRef(new Map<string, File>());
  const folderOf = useRef(new Map<string, string>());
  /** Files with a step in flight: a second click never starts a second request, send or completion for one file. */
  const busy = useRef(new Set<string>());
  const sends = useRef({ active: 0, queue: [] as (() => void)[] });
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const counter = useRef(0);

  // Opening another folder of the library makes it the default for the next files (those already queued keep theirs).
  const [shownFolder, setShownFolder] = useState(folderId);
  if (shownFolder !== folderId) {
    setShownFolder(folderId);
    setFolder(folderId ?? "");
  }
  useEffect(() => () => void (refreshTimer.current && clearTimeout(refreshTimer.current)), []);

  const change = (keys: string[], next: (item: QueueItem) => QueueItem) => setItems((list) => list.map((item) => (keys.includes(item.key) ? next(item) : item)));
  const replace = (updated: QueueItem[]) => setItems((list) => list.map((item) => updated.find((u) => u.key === item.key) ?? item));
  const showNew = () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => router.refresh(), 400);
  };

  async function slot<T>(work: () => Promise<T>): Promise<T> {
    if (sends.current.active >= PARALLEL_SENDS) await new Promise<void>((resolve) => sends.current.queue.push(resolve));
    sends.current.active++;
    try {
      return await work();
    } finally {
      sends.current.active--;
      sends.current.queue.shift()?.();
    }
  }

  async function complete(item: QueueItem, late = false) {
    if (!item.mediaId || busy.current.has(item.key)) return;
    busy.current.add(item.key);
    change([item.key], (i) => ({ ...i, status: "finishing", message: undefined, retry: undefined }));
    try {
      const answer = await completeUploadAction(orgSlug, siteSlug, item.mediaId).catch(() => ({ ok: false as const, code: "Internal", error: "" }));
      const next = late && !answer.ok && answer.code === "Conflict" ? afterLateConflict(item) : afterComplete(item, answer);
      replace([next]);
      if (next.status === "ready") {
        if (refreshOnReady) showNew();
        onReady?.(item.mediaId);
      }
    } finally {
      busy.current.delete(item.key);
    }
  }

  async function send(item: QueueItem) {
    const file = files.current.get(item.key);
    if (!file || !item.target || busy.current.has(item.key)) return;
    busy.current.add(item.key);
    let next: QueueItem;
    try {
      change([item.key], (i) => ({ ...i, status: "sending", progress: 0, message: undefined, retry: undefined }));
      // A link about to expire is not used: the send could not finish in time.
      const status = linkValid(item.target) ? await slot(() => put(item.target!, file, (p) => change([item.key], (i) => ({ ...i, progress: p })))) : 403;
      next = afterSend(item, status);
      replace([next]);
    } finally {
      busy.current.delete(item.key);
    }
    if (next.status === "finishing") await complete(next);
  }

  async function request(batch: QueueItem[]) {
    const keys = batch.map((item) => item.key).filter((key) => !busy.current.has(key));
    const group = batch.filter((item) => keys.includes(item.key));
    if (!group.length) return;
    keys.forEach((key) => busy.current.add(key));
    let accepted: QueueItem[] = [];
    try {
      change(keys, (i) => ({ ...i, status: "requesting", message: undefined, retry: undefined, progress: 0 }));
      const target = folderOf.current.get(group[0]!.key) || null;
      const answer = await requestUploadsAction(
        orgSlug,
        siteSlug,
        group.map((item) => {
          const file = files.current.get(item.key)!;
          return { name: file.name, size: file.size, type: item.type };
        }),
        target,
      ).catch(() => ({ ok: false as const, code: "Internal", error: "" }));
      const next = afterRequest(group, answer);
      replace(next);
      accepted = next.filter((item) => item.status === "sending");
    } finally {
      keys.forEach((key) => busy.current.delete(key));
    }
    await Promise.all(accepted.map((item) => send(item)));
  }

  function add(list: FileList | File[]) {
    const added: QueueItem[] = [];
    for (const file of Array.from(list)) {
      const key = `f${++counter.current}`;
      files.current.set(key, file);
      folderOf.current.set(key, folder);
      const item = itemOf({ name: file.name, size: file.size, type: file.type }, key);
      added.push(imagesOnly && item.kind === "document" ? { ...item, status: "refused", message: `${item.name} is a PDF: only images can be chosen here. Upload it in the media library.` } : item);
    }
    setItems((current) => [...added, ...current]);
    const waiting = added.filter((item) => item.status === "waiting");
    // Each group of at most 20 is its own request: one refused group does not stop the others.
    for (const batch of batchesOf(waiting)) void request(batch);
  }

  function retry(item: QueueItem) {
    if (item.retry === "request") void request([item]);
    else if (item.retry === "send") void send(item);
    else if (item.retry === "complete") void complete(item, !linkValid(item.target));
  }

  const done = items.filter((item) => item.status === "ready" || item.status === "refused");
  const summary = summaryOf(items);

  return (
    <section aria-labelledby={`${inputId}-title`} className="grid gap-3" data-testid="dropzone">
      <h2 id={`${inputId}-title`} className="sr-only">
        Upload files
      </h2>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          if (event.dataTransfer.files.length) add(event.dataTransfer.files);
        }}
        data-over={over || undefined}
        data-interactive={interactive || undefined}
        className="grid gap-3 rounded-lg border border-dashed p-4 text-sm data-over:border-foreground data-over:bg-muted sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
      >
        <div className="grid gap-1">
          <p className="flex items-center gap-2 font-medium">
            <Upload aria-hidden="true" className="size-4" />
            Drop files here, or choose them
          </p>
          <p className="text-muted-foreground">
            {imagesOnly ? "JPEG, PNG, WebP or GIF, up to 20 MiB each." : `${ACCEPTED_LABEL}: images up to 20 MiB, PDFs up to 25 MiB.`} Up to 20 are sent at a time.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {folders.length ? (
            <>
              <label htmlFor={folderSelectId} className="text-sm">
                Into
              </label>
              <select
                id={folderSelectId}
                value={folder}
                onChange={(event) => setFolder(event.target.value)}
                className="h-10 min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:ring-3 focus-visible:ring-foreground/25 md:text-sm"
              >
                <option value="">No folder</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          <label
            htmlFor={inputId}
            className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground outline-none focus-within:ring-3 focus-within:ring-foreground/25 hover:bg-primary/90"
          >
            Choose files
            <input
              id={inputId}
              type="file"
              multiple
              accept={imagesOnly ? "image/jpeg,image/png,image/webp,image/gif" : "image/jpeg,image/png,image/webp,image/gif,application/pdf"}
              className="sr-only"
              disabled={!interactive}
              onChange={(event) => {
                if (event.currentTarget.files?.length) add(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
            />
          </label>
        </div>
      </div>

      <p role="status" aria-live="polite" className="text-sm text-muted-foreground empty:hidden" data-testid="upload-summary">
        {summary}
      </p>

      {items.length ? (
        <ul className="divide-y rounded-lg border" aria-label="Uploads" data-testid="uploads">
          {items.map((item) => (
            <li key={item.key} data-testid="upload" data-status={item.status} data-name={item.name} className="grid gap-1 p-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="grid min-w-0 gap-1">
                <span className="flex min-w-0 items-center gap-2">
                  {item.kind === "document" ? <FileText aria-hidden="true" className="size-4 shrink-0" /> : <ImageIcon aria-hidden="true" className="size-4 shrink-0" />}
                  <span className="truncate font-medium">{item.name}</span>
                  <span className="shrink-0 text-muted-foreground">{formatBytes(item.size)}</span>
                </span>
                <span className="flex items-center gap-1.5" data-testid="upload-state">
                  {item.status === "ready" ? (
                    <CircleCheck aria-hidden="true" className="size-4 text-emerald-700" />
                  ) : item.status === "failed" || item.status === "refused" ? (
                    <CircleX aria-hidden="true" className="size-4 text-destructive" />
                  ) : (
                    <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
                  )}
                  <span>{item.status === "finishing" && item.kind === "image" ? "Processing" : STATUS_LABEL[item.status]}</span>
                  {item.message ? <span className="text-muted-foreground">· {item.message}</span> : null}
                </span>
                {item.status === "sending" ? (
                  <progress max={1} value={item.progress} aria-label={`Uploading ${item.name}`} className="h-1.5 w-full max-w-sm accent-foreground" />
                ) : null}
              </div>
              {item.retry ? (
                <Button type="button" variant="outline" className="h-9 justify-self-start px-3" onClick={() => retry(item)} aria-label={`Try again: ${item.name}`}>
                  <RotateCw aria-hidden="true" className="size-4" />
                  Try again
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {done.length ? (
        <Button
          type="button"
          variant="ghost"
          className="h-9 justify-self-start px-3"
          onClick={() => setItems((list) => list.filter((item) => item.status !== "ready" && item.status !== "refused"))}
        >
          Clear finished
        </Button>
      ) : null}
    </section>
  );
}
