"use client";

import { FileText, LayoutGrid, List, Trash2 } from "lucide-react";
import Link from "next/link";
import { useId, useState, useTransition } from "react";
import { FormAlert } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { formatBytes, PLANS, type Allowance } from "@/modules/billing/shared";
import { moveMediaAction } from "../actions";
import { LIBRARY_KINDS, LIBRARY_SORTS, libraryHref, type LibraryQuery } from "../library-query";
import { FolderSidebar } from "./folder-sidebar";
import { MediaDrawer } from "./media-drawer";
import { UploadDropzone } from "./upload-dropzone";

/**
 * The media library (M6-3; plan §19 `/…/media`): the dropzone, the site's folders, and its files as a grid or a list,
 * searched, filtered by kind and folder, sorted; a file opens in a drawer. Everything shown comes from the server for
 * the URL's query, and every change is the server's to make; the page shows it afterwards.
 */

export type LibraryItemView = {
  id: string; kind: "image" | "document"; filename: string; title: string; altText: string; caption: string; mimeType: string; storedBytes: number; sizeBytes: number;
  width: number | null; height: number | null; thumbUrl: string | null; previewUrl: string; url: string; folderId: string | null; uploadedBy: string;
  createdAt: string; deletedAt: string | null; canEdit: boolean; canTrash: boolean;
};
export type LibraryFolderView = { id: string; name: string; files: number };

const LINK = "rounded-sm font-medium underline underline-offset-4 outline-none hover:no-underline focus-visible:ring-3 focus-visible:ring-foreground/25";
const CHIP = "inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-foreground/25 aria-[current=page]:bg-muted aria-[current=page]:font-medium";
const SELECT = "h-10 min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:ring-3 focus-visible:ring-foreground/25 md:text-sm";
const nameOf = (item: LibraryItemView) => item.title || item.filename;
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export function MediaLibrary({
  orgSlug, siteSlug, basePath, query, items, hasMore, folders, storage, canManageFolders, canUpload,
}: {
  orgSlug: string; siteSlug: string; basePath: string; query: LibraryQuery; items: LibraryItemView[]; hasMore: boolean; folders: LibraryFolderView[]; storage: Allowance;
  canManageFolders: boolean; canUpload: boolean;
}) {
  const ids = { search: useId(), kind: useId(), sort: useId(), move: useId() };
  const [open, setOpen] = useState<LibraryItemView | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [moving, startMoving] = useTransition();
  const href = (change: Partial<LibraryQuery>) => libraryHref(basePath, query, { page: 1, ...change });
  const folderName = (id: string | null) => (id ? (folders.find((f) => f.id === id)?.name ?? "") : "");
  const selectable = items.filter((item) => item.canEdit && !item.deletedAt);
  const toggle = (id: string) => setSelected((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  const currentFolder = query.folder && query.folder !== "none" ? query.folder : null;
  const heading = query.trash ? "Trash" : query.folder === "none" ? "Files in no folder" : currentFolder ? folderName(currentFolder) || "Media" : "All media";

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Media</h1>
          <p className="mt-1 text-sm text-muted-foreground" data-testid="storage-usage">
            {formatBytes(storage.used)} of {formatBytes(storage.limit)} used on the {PLANS[storage.plan].label} plan
          </p>
        </div>
        <Link href={query.trash ? basePath : href({ trash: true, folder: undefined })} className={CHIP} aria-current={query.trash ? "page" : undefined}>
          <Trash2 aria-hidden="true" className="size-4" />
          {query.trash ? "Back to the library" : "Trash"}
        </Link>
      </div>

      {canUpload && !query.trash ? (
        <div className="mt-6">
          <UploadDropzone orgSlug={orgSlug} siteSlug={siteSlug} folders={folders} folderId={currentFolder} />
        </div>
      ) : null}

      <div className="mt-8 grid gap-6 md:grid-cols-[14rem_minmax(0,1fr)]">
        <FolderSidebar orgSlug={orgSlug} siteSlug={siteSlug} folders={folders} query={query} basePath={basePath} canManage={canManageFolders} />

        <section aria-labelledby={`${ids.search}-heading`} className="grid min-w-0 content-start gap-4">
          <h2 id={`${ids.search}-heading`} className="text-lg font-semibold">
            {heading}
          </h2>
          {query.trash ? <p className="text-sm text-muted-foreground">Files in the trash are deleted for good after 30 days. Until then they can be restored.</p> : null}

          <form role="search" action={basePath} className="flex flex-wrap items-end gap-2" aria-label="Search the media">
            {query.trash ? <input type="hidden" name="trash" value="1" /> : null}
            {query.folder ? <input type="hidden" name="folder" value={query.folder} /> : null}
            {query.view === "list" ? <input type="hidden" name="view" value="list" /> : null}
            <div className="grid min-w-0 flex-1 gap-1">
              <label htmlFor={ids.search} className="text-sm font-medium">
                Search
              </label>
              <input id={ids.search} type="search" name="q" defaultValue={query.q ?? ""} placeholder="Title, file name or alternative text" className={`${SELECT} w-full`} />
            </div>
            <div className="grid gap-1">
              <label htmlFor={ids.kind} className="text-sm font-medium">
                Kind
              </label>
              <select id={ids.kind} name="kind" defaultValue={query.kind ?? ""} className={SELECT}>
                <option value="">Images and PDFs</option>
                {Object.entries(LIBRARY_KINDS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1">
              <label htmlFor={ids.sort} className="text-sm font-medium">
                Sort
              </label>
              <select id={ids.sort} name="sort" defaultValue={query.sort} className={SELECT}>
                {Object.entries(LIBRARY_SORTS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" variant="outline" className="h-10 px-4">
              Apply
            </Button>
          </form>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <nav aria-label="View" className="flex gap-2">
              <Link href={href({ view: "grid" })} className={CHIP} aria-current={query.view === "grid" ? "page" : undefined}>
                <LayoutGrid aria-hidden="true" className="size-4" /> Grid
              </Link>
              <Link href={href({ view: "list" })} className={CHIP} aria-current={query.view === "list" ? "page" : undefined}>
                <List aria-hidden="true" className="size-4" /> List
              </Link>
            </nav>
            {selected.length ? (
              <form
                className="flex flex-wrap items-center gap-2"
                aria-label="Move the selected files"
                onSubmit={(event) => {
                  event.preventDefault();
                  const target = String(new FormData(event.currentTarget).get("folderId") ?? "");
                  startMoving(async () => {
                    const state = await moveMediaAction(orgSlug, siteSlug, selected, target || null);
                    setNotice({ tone: state.status === "error" ? "error" : "success", text: state.message ?? (state.status === "error" ? "The files could not be moved." : "Moved.") });
                    if (state.status !== "error") setSelected([]);
                  });
                }}
              >
                <label htmlFor={ids.move} className="text-sm">
                  Move {selected.length} {selected.length === 1 ? "file" : "files"} to
                </label>
                <select id={ids.move} name="folderId" className={SELECT} defaultValue="">
                  <option value="">No folder</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
                <Button type="submit" className="h-10 px-4" disabled={moving} aria-busy={moving || undefined}>
                  {moving ? "Moving…" : "Move"}
                </Button>
                <Button type="button" variant="ghost" className="h-10 px-3" onClick={() => setSelected([])}>
                  Clear selection
                </Button>
              </form>
            ) : null}
          </div>

          <div aria-live="polite" className="empty:hidden">
            {notice ? <FormAlert tone={notice.tone}>{notice.text}</FormAlert> : null}
          </div>

          {items.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground" data-testid="no-media">
              {query.q || query.kind
                ? "Nothing matches. Try other words, or another kind."
                : query.trash
                  ? "The trash is empty."
                  : query.folder
                    ? "This folder is empty."
                    : canUpload
                      ? "No files yet. Upload the first ones above."
                      : "No files yet."}
            </p>
          ) : query.view === "list" ? (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-left text-sm" data-testid="media-list">
                <caption className="sr-only">{heading}</caption>
                <thead className="border-b bg-muted/50">
                  <tr>
                    <th scope="col" className="w-10 p-2">
                      <span className="sr-only">Select</span>
                    </th>
                    <th scope="col" className="p-2">Name</th>
                    <th scope="col" className="p-2">Kind</th>
                    <th scope="col" className="p-2">Size</th>
                    <th scope="col" className="hidden p-2 sm:table-cell">Folder</th>
                    <th scope="col" className="hidden p-2 sm:table-cell">{query.trash ? "Trashed" : "Uploaded"}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {items.map((item) => (
                    <tr key={item.id} data-testid="media-item" data-name={nameOf(item)}>
                      <td className="p-2">
                        {selectable.includes(item) ? (
                          <input type="checkbox" checked={selected.includes(item.id)} onChange={() => toggle(item.id)} aria-label={`Select ${nameOf(item)}`} className="size-4" />
                        ) : null}
                      </td>
                      <td className="p-2">
                        <button type="button" onClick={() => setOpen(item)} className={`${LINK} flex min-w-0 items-center gap-2 text-left`}>
                          {item.thumbUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element -- the square thumbnail variant, from /media
                            <img src={item.thumbUrl} alt="" width={32} height={32} loading="lazy" className="size-8 shrink-0 rounded object-cover" />
                          ) : (
                            <FileText aria-hidden="true" className="size-8 shrink-0 p-1" />
                          )}
                          <span className="wrap-anywhere">{nameOf(item)}</span>
                        </button>
                      </td>
                      <td className="p-2">{item.kind === "image" ? "Image" : "PDF"}</td>
                      <td className="p-2 whitespace-nowrap">{formatBytes(item.storedBytes)}</td>
                      <td className="hidden p-2 sm:table-cell">{folderName(item.folderId) || "—"}</td>
                      <td className="hidden p-2 whitespace-nowrap sm:table-cell">{day(item.deletedAt ?? item.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="media-grid">
              {items.map((item) => (
                <li key={item.id} data-testid="media-item" data-name={nameOf(item)} className="relative grid gap-1 rounded-lg border p-2">
                  <button
                    type="button"
                    onClick={() => setOpen(item)}
                    className="grid gap-1.5 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-foreground/25"
                    aria-label={`${nameOf(item)}, ${item.kind === "image" ? "image" : "PDF"}, ${formatBytes(item.storedBytes)}`}
                  >
                    {item.thumbUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- the square thumbnail variant, from /media
                      <img src={item.thumbUrl} alt="" width={400} height={400} loading="lazy" className="aspect-square w-full rounded-md bg-muted object-cover" data-testid="media-thumb" />
                    ) : (
                      <span className="flex aspect-square w-full items-center justify-center rounded-md bg-muted" data-testid="media-pdf">
                        <FileText aria-hidden="true" className="size-10" />
                        <span className="sr-only">PDF</span>
                      </span>
                    )}
                    <span className="truncate text-sm font-medium">{nameOf(item)}</span>
                    <span className="text-xs text-muted-foreground">
                      {item.kind === "image" ? "Image" : "PDF"} · {formatBytes(item.storedBytes)}
                    </span>
                  </button>
                  {selectable.includes(item) ? (
                    <input
                      type="checkbox"
                      checked={selected.includes(item.id)}
                      onChange={() => toggle(item.id)}
                      aria-label={`Select ${nameOf(item)}`}
                      className="absolute top-3 left-3 size-5"
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {query.page > 1 || hasMore ? (
            <nav aria-label="Pages" className="flex gap-2">
              {query.page > 1 ? (
                <Link href={libraryHref(basePath, query, { page: query.page - 1 })} className={CHIP}>
                  Previous page
                </Link>
              ) : null}
              {hasMore ? (
                <Link href={libraryHref(basePath, query, { page: query.page + 1 })} className={CHIP}>
                  Next page
                </Link>
              ) : null}
            </nav>
          ) : null}
        </section>
      </div>

      {open ? (
        <MediaDrawer
          key={open.id}
          orgSlug={orgSlug}
          siteSlug={siteSlug}
          item={items.find((item) => item.id === open.id) ?? open}
          folders={folders}
          onClose={() => setOpen(null)}
          onDone={(text) => setNotice({ tone: "success", text })}
        />
      ) : null}
    </main>
  );
}
