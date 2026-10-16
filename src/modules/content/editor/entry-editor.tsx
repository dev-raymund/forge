"use client";

import "./editor.css";
import type { JSONContent } from "@tiptap/core";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { Bold, Code, GripVertical, Italic, Link2, MoreHorizontal, Rows3, Strikethrough, Underline } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FormAlert } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ImagePreviews, type ImagePreviewData } from "@/blocks/image/preview-context";
import { image as imageBlock } from "@/blocks/image/schema";
import { MediaPicker, type PickedImage } from "@/modules/media/shared";
import { IDLE } from "@/platform/forms";
import { publishEntryAction, saveDraftAction } from "../actions";
import { documentProblem, parseDocument } from "../document/parse";
import { DOCUMENT_VERSION } from "../document/schema";
import type { EditorEntry } from "../queries";
import { clearBuffer, createAutosave, readBuffer, type AutosaveStatus, type SaveResult } from "./autosave";
import { dedupeIds } from "./dedupe-ids";
import { EmbedDialog } from "./embed-dialog";
import { EntrySettings, type DraftFields, type EntryPlace, type SidebarChoices } from "./entry-settings";
import { EDITOR_NODE_TYPES, editorExtensions } from "./extensions";
import { TrashSection, UnpublishButton } from "./lifecycle-controls";
import { ScheduleButton, ScheduledControls } from "./schedule-controls";
import { LinkDialog } from "./link-dialog";
import { currentBlock, PropertiesPanel, type CurrentBlock } from "./panel/properties-panel";
import { runBlockAction, topLevelIndexAt, type BlockAction } from "./reorder";
import { saveResultOf } from "./save-result";
import { commandsAt, filterCommands, slashMatch, type SlashCommand, type SlashRange } from "./slash";

/**
 * The entry editor (M5-4, M5-5; plan §6.3; ADR 0003): the title, the
 * document with the text nodes and the registry's custom blocks, the slash
 * menu, the link picker, the properties panel, reordering (drag handle,
 * Alt+↑/↓, the block menu), autosave with its status, the conflict dialog and
 * the Publish button. Client-only and lazy-loaded (./lazy.tsx).
 *
 * Everything it writes goes through the M5-3 Server Actions, which decide who
 * may and what is valid: what this screen shows or hides is a convenience, not
 * a rule. A save is shown as saved only once the server has answered with the
 * new version; a refused or failed save is shown as not saved.
 */

/** What autosave saves: the title, the document, and the sidebar's draft fields that have been changed (M5-7). */
export type DraftPayload = { title: string; doc: JSONContent; fields?: DraftFields };

export type EntryEditorProps = {
  orgSlug: string;
  siteSlug: string;
  entry: EditorEntry;
  /** `/s/{address}`: where the entry's path is on the public site. */
  publicPrefix: string | null;
  /** What the sidebar offers (M5-7): pages to go under, members to credit, the site's terms. */
  choices?: SidebarChoices;
};

const ENTRY_TITLE_MAX = 200;

function storageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null; // private mode, blocked storage: autosave works, the crash buffer does not
  }
}

/** The node types of a stored document. One this editor does not have means it would be lost on saving: such a document is not edited here. */
export function nodeTypesOf(content: unknown): Set<string> {
  const types = new Set<string>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const { type, content: children } = node as { type?: unknown; content?: unknown };
    if (typeof type === "string") types.add(type);
    if (Array.isArray(children)) children.forEach(walk);
  };
  walk((content as { doc?: unknown } | null)?.doc);
  return types;
}

/**
 * A draft as it would be stored, for telling an edit from a transaction that changes nothing saved: the empty
 * paragraph the editor keeps after a final block (Tiptap's TrailingNode, added on the first interaction) is not
 * content, and saving drops it (`parseDocument`).
 */
export function draftShape(draft: DraftPayload): string {
  const content = [...(draft.doc.content ?? [])];
  while (content.length > 1 && content.at(-1)!.type === "paragraph" && !content.at(-1)!.content?.length) content.pop();
  return JSON.stringify([draft.title, content, draft.fields ?? {}]);
}

const docOf = (content: unknown): JSONContent =>
  ((content as { doc?: JSONContent } | null)?.doc ?? { type: "doc", content: [{ type: "paragraph" }] }) as JSONContent;

export function statusText(status: AutosaveStatus): string {
  switch (status.state) {
    case "idle":
      return "All changes saved";
    case "pending":
      return "Unsaved changes";
    case "saving":
      return "Saving…";
    case "saved":
      return `Saved at ${status.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    case "conflict":
      return "Not saved: changed somewhere else";
    case "invalid":
      return `Not saved: ${status.issues?.[0] ?? "this content cannot be saved"}`;
    case "error":
      return "Not saved: connection problem. Trying again…";
  }
}

type SlashState = { query: string; range: SlashRange; inColumn: boolean; active: number; top: number; left: number };

export function EntryEditor({ orgSlug, siteSlug, entry, publicPrefix, choices = { pages: [], members: [], terms: [] } }: EntryEditorProps) {
  const unsupported = useMemo(() => [...nodeTypesOf(entry.draft.content)].filter((type) => !EDITOR_NODE_TYPES.has(type)), [entry.draft.content]);
  const canEdit = entry.canEdit && unsupported.length === 0;
  const [storage] = useState(storageOrNull);
  // Changes typed here before a crash or a closed tab, not yet saved, for this very version of the draft.
  const [restored] = useState(() => (canEdit && storage ? readBuffer<DraftPayload>(storage, entry.id, entry.draft.version) : null));

  const [title, setTitle] = useState(restored?.title ?? entry.draft.title);
  const titleRef = useRef(title);
  const [status, setStatus] = useState<AutosaveStatus>({ state: "idle" });
  const statusRef = useRef(status);
  const [savedVersion, setSavedVersion] = useState(entry.draft.version);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [live, setLive] = useState({ status: entry.status, version: entry.publishedDraftVersion, path: entry.path });
  // Scheduling (M7-2): when it publishes, and why the last schedule failed (until it is scheduled or published again).
  const [scheduledAt, setScheduledAt] = useState<string | null>(entry.schedule.at);
  const [scheduleFailure, setScheduleFailure] = useState(entry.schedule.failure);
  // The sidebar (M5-7): draft fields changed here, and what its immediate actions changed.
  const [fields, setFields] = useState<DraftFields>(restored?.fields ?? {});
  const fieldsRef = useRef(fields);
  // The site's terms, with those added from the sidebar since the page loaded (M5-8).
  const [terms, setTerms] = useState(choices.terms);
  const [place, setPlace] = useState<EntryPlace>({
    path: entry.path, parentId: entry.settings.parentId, isHome: entry.isHome, authorId: entry.settings.authorId, authorName: entry.settings.authorName,
  });
  const [publishing, setPublishing] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(
    restored ? { tone: "success", text: "Changes that had not been saved were restored. They are being saved now." } : null,
  );
  const [slash, setSlash] = useState<SlashState | null>(null);
  // An embed asked for from the slash menu: where it goes once the address is given.
  const [embedAt, setEmbedAt] = useState<SlashRange | null>(null);
  // An image asked for from the slash menu (M6-4): where it goes once one is chosen in the picker.
  const [imageAt, setImageAt] = useState<SlashRange | null>(null);
  // What the editor knows of its images (M6-4): from the server when it opened, and each image chosen since.
  const [previews, setPreviews] = useState<Record<string, ImagePreviewData>>(entry.images);
  // Their thumbnails load only once asked for: "Show previews", or an image chosen in the picker (which shows them).
  const [previewsShown, setPreviewsShown] = useState(false);
  const learn = (picked: PickedImage) => {
    setPreviews((current) => ({ ...current, [picked.id]: { name: picked.name, altText: picked.altText, thumbUrl: picked.thumbUrl, width: picked.width, height: picked.height } }));
    setPreviewsShown(true);
  };
  const imagePreviews = useMemo(() => ({ images: previews, shown: previewsShown, show: () => setPreviewsShown(true) }), [previews, previewsShown]);
  const [handlePos, setHandlePos] = useState<number | null>(null);
  const slashRef = useRef<SlashState | null>(null);
  const dismissedAt = useRef<number | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);

  // One autosave controller for the life of the screen, for the entry and the version it was opened with. Made after
  // the first render (and before the editor exists, which is created in an effect declared below).
  const autosaveRef = useRef<ReturnType<typeof createAutosave<DraftPayload>> | null>(null);
  useEffect(() => {
    const controller = createAutosave<DraftPayload>({
      entryId: entry.id,
      version: entry.draft.version,
      storage: storage ?? undefined,
      onStatus: (next) => {
        statusRef.current = next;
        setStatus(next);
        if (next.state === "saved") setSavedVersion(next.version);
        if (next.state === "conflict") {
          editorRef.current?.setEditable(false);
          setConflictOpen(true);
        }
      },
      save: async (expected, draft): Promise<SaveResult> => {
        // Checked here first, so a broken document is reported at once; the server checks it again.
        const { document } = dedupeIds({ v: DOCUMENT_VERSION, doc: draft.doc });
        const parsed = parseDocument(document);
        if (!parsed.ok) return { ok: false, reason: "invalid", issues: [documentProblem(parsed)] };
        const data = new FormData();
        data.set("version", String(expected));
        data.set("draft", JSON.stringify({ title: draft.title, content: parsed.document, ...draft.fields }));
        return saveResultOf(await saveDraftAction(orgSlug, siteSlug, entry.id, IDLE, data));
      },
    });
    autosaveRef.current = controller;
    return () => controller.dispose();
  }, [entry.id, entry.draft.version, storage, orgSlug, siteSlug]);

  const payload = (editor: Editor): DraftPayload => ({ title: titleRef.current, doc: editor.getJSON(), fields: fieldsRef.current });
  // The draft as last handed to autosave (or as opened). A transaction that leaves it as it is (the trailing paragraph
  // after a final block, a click) is no edit: saving it would make a new version for nothing, and another open tab's
  // next save a conflict. Compared with what was last handed over, not with what was last saved, so undoing an edit
  // while it is being saved is still saved. What the editor does to the document while it is being made (ids, the
  // trailing paragraph) is not an edit either.
  const lastShape = useRef<string | null>(null);
  const opened = useRef(false);
  const changed = (editor: Editor) => {
    const next = payload(editor);
    const shape = draftShape(next);
    if (shape === lastShape.current) return;
    lastShape.current = shape;
    if (opened.current) autosaveRef.current?.change(next);
  };

  function updateSlash(editor: Editor) {
    const match = slashMatch(editor.state);
    if (!match) dismissedAt.current = null;
    if (!match || dismissedAt.current === match.range.from || !surface.current) return showSlash(null);
    const box = surface.current.getBoundingClientRect();
    const caret = editor.view.coordsAtPos(match.range.to);
    const previous = slashRef.current;
    showSlash({
      query: match.query,
      range: match.range,
      inColumn: match.inColumn,
      active: previous && previous.query === match.query ? previous.active : 0,
      top: caret.bottom - box.top + 4,
      left: Math.max(0, Math.min(caret.left - box.left, box.width - 240)),
    });
  }
  function showSlash(next: SlashState | null) {
    slashRef.current = next;
    setSlash(next);
  }
  function choose(command: SlashCommand) {
    const editor = editorRef.current;
    const menu = slashRef.current;
    if (!editor || !menu) return;
    showSlash(null);
    if (command.asks === "address") return setEmbedAt(menu.range);
    if (command.asks === "media") return setImageAt(menu.range);
    command.run(editor, menu.range);
  }

  const extensions = useMemo(() => editorExtensions(), []);
  const editor = useEditor({
    extensions,
    // A document with blocks this editor lacks is not loaded into it at all (ProseMirror cannot hold them): see the notice below.
    content: unsupported.length ? { type: "doc", content: [{ type: "paragraph" }] } : (restored?.doc ?? docOf(entry.draft.content)),
    editable: canEdit,
    immediatelyRender: false,
    editorProps: {
      attributes: { "aria-label": "Content", "aria-multiline": "true", "data-testid": "editor", class: "forge-entry-content" },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && editorRef.current?.isEditable) {
          event.preventDefault();
          setLinkOpen(true);
          return true;
        }
        const menu = slashRef.current;
        if (!menu) return false;
        const items = filterCommands(menu.query, commandsAt(menu.inColumn));
        if (event.key === "Escape") {
          dismissedAt.current = menu.range.from;
          showSlash(null);
          return true;
        }
        if (!items.length) return false;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const step = event.key === "ArrowDown" ? 1 : -1;
          showSlash({ ...menu, active: (menu.active + step + items.length) % items.length });
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          choose(items[Math.min(menu.active, items.length - 1)]!);
          return true;
        }
        return false;
      },
    },
    onCreate: ({ editor }) => {
      editorRef.current = editor;
      opened.current = true;
      lastShape.current = draftShape(payload(editor));
      // Restored from this browser's buffer: not on the server yet.
      if (restored) autosaveRef.current?.change(payload(editor));
    },
    onUpdate: ({ editor }) => {
      changed(editor);
      updateSlash(editor);
    },
    onSelectionUpdate: ({ editor }) => updateSlash(editor),
    onBlur: () => showSlash(null),
  });

  const block = useEditorState({
    editor,
    selector: ({ editor: current }) => (current ? currentBlock(current) : null),
    equalityFn: (a: CurrentBlock | null, b: CurrentBlock | null) => JSON.stringify(a) === JSON.stringify(b),
  });

  /** The sidebar's draft fields changed (M5-7): kept for the next autosave, which they join. */
  function updateFields(next: DraftFields) {
    fieldsRef.current = next;
    setFields(next);
    if (editor) changed(editor);
  }

  function blockAction(index: number | null, action: BlockAction) {
    if (editor && index !== null) runBlockAction(editor, index, action);
  }

  const marks = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current
        ? { bold: current.isActive("bold"), italic: current.isActive("italic"), underline: current.isActive("underline"), strike: current.isActive("strike"), code: current.isActive("code"), link: current.isActive("link") }
        : null,
  });

  async function publish() {
    const autosave = autosaveRef.current;
    if (!autosave) return;
    setPublishing(true);
    setNotice(null);
    try {
      await autosave.flush();
      const state = statusRef.current.state;
      if (state === "conflict") return setNotice({ tone: "error", text: "Not published: the draft was changed somewhere else." });
      if (state === "invalid" || state === "error" || state === "pending") return setNotice({ tone: "error", text: "Not published: the latest changes are not saved yet." });
      const data = new FormData();
      data.set("version", String(autosave.version));
      const result = await publishEntryAction(orgSlug, siteSlug, entry.id, IDLE, data);
      if (result.status === "success") {
        setLive({ status: "published", version: autosave.version, path: result.values?.path ?? live.path });
        setScheduleFailure(null);
        setNotice({ tone: "success", text: result.message ?? "Published." });
      } else {
        setNotice({ tone: "error", text: result.message ?? Object.values(result.fieldErrors ?? {}).flat()[0] ?? "Not published." });
      }
    } catch {
      setNotice({ tone: "error", text: "Not published: the connection failed. Try again." });
    } finally {
      setPublishing(false);
    }
  }

  async function copyMine() {
    if (!editor) return;
    try {
      await navigator.clipboard.writeText(`${titleRef.current}\n\n${editor.getText({ blockSeparator: "\n\n" })}`);
      setCopied("Your changes are copied. Load the latest version, then paste them where you want them.");
    } catch {
      setCopied("Copying is not allowed here. Select your text in the editor and copy it yourself.");
    }
  }

  function loadLatest() {
    // What this tab had not saved is given up (it was offered for copying first).
    if (storage) clearBuffer(storage, entry.id, autosaveRef.current?.version ?? entry.draft.version);
    window.location.reload();
  }

  const conflict = status.state === "conflict";
  const editable = canEdit && !conflict;
  const isLive = live.status === "published";
  const isScheduled = live.status === "scheduled" && scheduledAt !== null;
  const upToDate = isLive && live.version === savedVersion && (status.state === "idle" || status.state === "saved");
  const address = publicPrefix ? `${publicPrefix}${live.path === "/" ? "" : live.path}` : live.path;
  const items = slash ? filterCommands(slash.query, commandsAt(slash.inColumn)) : [];

  const panel =
    editable && editor && block ? (
      <PropertiesPanel key={`${block.type}:${String(block.attrs.id)}`} editor={editor} block={block} orgSlug={orgSlug} siteSlug={siteSlug} onImagePicked={learn} />
    ) : null;

  return (
    <div className="forge-entry-editor mx-auto grid w-full max-w-5xl gap-4 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          data-testid="entry-status"
          className={cn(
            "inline-flex h-6 items-center rounded-full border px-2.5 text-xs font-medium",
            isLive
              ? "border-emerald-700/30 bg-emerald-50 text-emerald-900"
              : isScheduled
                ? "border-sky-700/30 bg-sky-50 text-sky-900"
                : "border-amber-700/30 bg-amber-50 text-amber-900",
          )}
        >
          {isLive ? (upToDate ? "Published" : "Published, with unpublished changes") : isScheduled ? "Scheduled" : "Draft"}
        </span>
        {place.isHome ? <span className="text-sm text-muted-foreground">Home page</span> : null}
        {canEdit ? (
          <span role="status" aria-live="polite" data-testid="autosave-status" className={cn("text-sm", conflict || status.state === "invalid" ? "text-destructive" : "text-muted-foreground")}>
            {statusText(status)}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          {conflict ? (
            <Button type="button" variant="outline" className="h-9 px-3" onClick={() => setConflictOpen(true)}>
              Resolve…
            </Button>
          ) : null}
          {isLive && entry.lifecycle.canUnpublish ? (
            <UnpublishButton
              orgSlug={orgSlug}
              siteSlug={siteSlug}
              entry={entry}
              title={title}
              disabled={publishing}
              onDone={(result) => {
                if (result.ok) setLive((current) => ({ ...current, status: "draft" }));
                setNotice({ tone: result.ok ? "success" : "error", text: result.text });
              }}
            />
          ) : null}
          {isScheduled ? (
            <ScheduledControls
              orgSlug={orgSlug}
              siteSlug={siteSlug}
              entryId={entry.id}
              timeZone={entry.schedule.timeZone}
              scheduledAt={scheduledAt!}
              canChange={entry.canPublish}
              onChanged={(next, text) => {
                setScheduledAt(next);
                setNotice({ tone: "success", text });
              }}
              onCanceled={(text) => {
                setLive((current) => ({ ...current, status: "draft" }));
                setScheduledAt(null);
                setNotice({ tone: "success", text });
              }}
              onError={(text) => setNotice({ tone: "error", text })}
            />
          ) : null}
          {!isLive && !isScheduled && canEdit && entry.canPublish ? (
            <ScheduleButton
              orgSlug={orgSlug}
              siteSlug={siteSlug}
              entryId={entry.id}
              timeZone={entry.schedule.timeZone}
              disabled={publishing || conflict}
              beforeSchedule={async () => {
                // What is typed is saved first: the schedule freezes the version that is saved.
                const autosave = autosaveRef.current;
                if (!autosave) return { error: "The editor is not ready yet." };
                await autosave.flush();
                const state = statusRef.current.state;
                if (state === "conflict") return { error: "Not scheduled: the draft was changed somewhere else." };
                if (state === "invalid" || state === "error" || state === "pending") return { error: "Not scheduled: the latest changes are not saved yet." };
                return { version: autosave.version };
              }}
              onScheduled={(at, text) => {
                setLive((current) => ({ ...current, status: "scheduled" }));
                setScheduledAt(at);
                setScheduleFailure(null);
                setNotice({ tone: "success", text });
              }}
            />
          ) : null}
          {canEdit && entry.canPublish && !isScheduled ? (
            <Button type="button" className="h-9 px-4" onClick={publish} aria-busy={publishing || undefined} disabled={publishing || conflict}>
              {publishing ? "Publishing…" : isLive ? "Publish changes" : "Publish"}
            </Button>
          ) : null}
        </span>
      </div>

      {notice ? <FormAlert tone={notice.tone}>{notice.text}</FormAlert> : null}
      {scheduleFailure && !isLive && !isScheduled ? (
        <FormAlert tone="error">
          <span data-testid="schedule-failure">
            It was not published as scheduled ({new Date(scheduleFailure.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}): {scheduleFailure.reason} It is a draft
            again: publish it, or schedule it again.
          </span>
        </FormAlert>
      ) : null}
      {isScheduled && canEdit ? (
        <p className="text-sm text-muted-foreground" data-testid="scheduled-note">
          Changes you make now are saved to the draft, but are not part of the scheduled version. Cancel the schedule and schedule it again to include them.
        </p>
      ) : null}
      {isLive ? (
        <p className="text-sm text-muted-foreground" data-testid="entry-address">
          Address: <span className="font-medium text-foreground">{address}</span>
        </p>
      ) : null}
      {!entry.canEdit ? (
        <p className="rounded-lg border bg-muted px-3 py-2 text-sm" data-testid="read-only">
          You can read this {entry.type} but not change it.
        </p>
      ) : unsupported.length ? (
        <p className="rounded-lg border bg-muted px-3 py-2 text-sm" data-testid="unsupported-blocks">
          This {entry.type} contains blocks this editor cannot edit yet ({unsupported.join(", ")}), so it is not opened here and nothing is changed.
        </p>
      ) : null}

      <input
        aria-label="Title"
        data-testid="entry-title"
        className="w-full border-0 bg-transparent px-0 text-3xl font-semibold tracking-tight outline-none placeholder:text-muted-foreground/60 focus-visible:ring-0"
        placeholder="Untitled"
        value={title}
        maxLength={ENTRY_TITLE_MAX}
        readOnly={!editable}
        onChange={(event) => {
          titleRef.current = event.target.value;
          setTitle(event.target.value);
          if (editor) changed(editor);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            editor?.commands.focus("start");
          }
        }}
      />

      {editable && editor && marks ? (
        <div role="toolbar" aria-label="Formatting" className="sticky top-0 z-10 flex flex-wrap gap-1 border-b bg-background py-1">
          {(
            [
              ["bold", "Bold", Bold, () => editor.chain().focus().toggleBold().run()],
              ["italic", "Italic", Italic, () => editor.chain().focus().toggleItalic().run()],
              ["underline", "Underline", Underline, () => editor.chain().focus().toggleUnderline().run()],
              ["strike", "Strikethrough", Strikethrough, () => editor.chain().focus().toggleStrike().run()],
              ["code", "Code", Code, () => editor.chain().focus().toggleCode().run()],
            ] as const
          ).map(([key, label, Icon, run]) => (
            <Button key={key} type="button" variant="ghost" size="icon" aria-label={label} aria-pressed={marks[key]} title={label} onMouseDown={(event) => event.preventDefault()} onClick={run} className="aria-pressed:bg-muted">
              <Icon aria-hidden="true" />
            </Button>
          ))}
          <Button type="button" variant="ghost" size="icon" aria-label="Link" aria-pressed={marks.link} title="Link (Ctrl+K)" onClick={() => setLinkOpen(true)} className="aria-pressed:bg-muted">
            <Link2 aria-hidden="true" />
          </Button>
          <BlockMenu label="Block actions" editor={editor} indexOf={() => topLevelIndexAt(editor.state.doc, editor.state.selection.from)} onAction={blockAction}>
            <Button type="button" variant="ghost" size="icon" aria-label="Block actions" title="Block actions (move, duplicate, delete)">
              <Rows3 aria-hidden="true" />
            </Button>
          </BlockMenu>
          <span className="ml-auto hidden self-center text-xs text-muted-foreground sm:inline">Type / for headings, lists, columns, buttons, video…</span>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div ref={surface} className="relative lg:row-span-2">
          {editor && editable && !unsupported.length ? (
            <DragHandle editor={editor} onNodeChange={({ pos }) => setHandlePos(pos)}>
              <div className="forge-drag-handle" data-testid="drag-handle">
                <span className="forge-drag-grip" aria-hidden="true" title="Drag to move">
                  <GripVertical className="size-4" />
                </span>
                <BlockMenu label="Block menu" editor={editor} indexOf={() => (handlePos === null ? null : topLevelIndexAt(editor.state.doc, handlePos))} onAction={blockAction}>
                  <button type="button" className="forge-drag-menu" aria-label="Block menu" data-testid="block-menu-button">
                    <MoreHorizontal className="size-4" aria-hidden="true" />
                  </button>
                </BlockMenu>
              </div>
            </DragHandle>
          ) : null}
          {editor && !unsupported.length ? (
            <ImagePreviews.Provider value={imagePreviews}>
              <EditorContent editor={editor} />
            </ImagePreviews.Provider>
          ) : null}
          {slash && editable ? (
            <ul
              role="listbox"
              aria-label="Insert"
              data-testid="slash-menu"
              className="absolute z-20 grid w-60 gap-0.5 rounded-lg border bg-popover p-1 text-sm shadow-md"
              style={{ top: slash.top, left: slash.left }}
            >
              {items.length === 0 ? (
                <li className="px-2 py-1.5 text-muted-foreground">Nothing matches</li>
              ) : (
                items.map((command, index) => (
                  <li
                    key={command.key}
                    role="option"
                    aria-selected={index === slash.active}
                    className={cn("cursor-pointer rounded-md px-2 py-1.5", index === slash.active && "bg-muted font-medium")}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      choose(command);
                    }}
                  >
                    {command.label}
                  </li>
                ))
              )}
            </ul>
          ) : null}
        </div>
        {/* The selected block's settings: beside the text on a wide screen, kept in view at the bottom on a phone. */}
        {panel ? (
          <div className="max-lg:sticky max-lg:bottom-0 max-lg:z-20 max-lg:max-h-[45vh] max-lg:overflow-y-auto max-lg:bg-background lg:sticky lg:top-14 lg:self-start">
            <ImagePreviews.Provider value={imagePreviews}>{panel}</ImagePreviews.Provider>
          </div>
        ) : null}
        {/* The entry's own settings (M5-7): beside the text on a wide screen, after it on a phone. */}
        <div className="grid gap-4 lg:col-start-2 lg:self-start">
          <EntrySettings
            orgSlug={orgSlug}
            siteSlug={siteSlug}
            entry={entry}
            title={title}
            status={live.status}
            place={place}
            fields={fields}
            editable={editable && !unsupported.length}
            choices={{ ...choices, terms }}
            images={imagePreviews}
            onImagePicked={learn}
            onTermCreated={(term) => {
              setTerms((current) => [...current, term].sort((a, b) => a.name.localeCompare(b.name)));
              setNotice({ tone: "success", text: `${term.taxonomy === "category" ? "Category" : "Tag"} ${term.name} added.` });
              // Ticked from the draft fields as they are now: anything typed in the sidebar while the term was being made stays.
              const current = fieldsRef.current;
              updateFields({ ...current, termIds: [...(current.termIds ?? entry.settings.termIds), term.id] });
            }}
            onFields={updateFields}
            onPlace={(next, message) => {
              setPlace((current) => ({ ...current, ...next }));
              if (next.path) setLive((current) => ({ ...current, path: next.path! }));
              setNotice({ tone: "success", text: message });
            }}
          />
          {entry.lifecycle.canTrash && !unsupported.length ? (
            <TrashSection
              orgSlug={orgSlug}
              siteSlug={siteSlug}
              entry={entry}
              title={title}
              isLive={isLive}
              isScheduled={isScheduled}
              isHome={place.isHome}
              beforeTrash={async () => {
                // What is typed is saved first, so the trash keeps it; a draft that cannot be saved is not trashed.
                const autosave = autosaveRef.current;
                if (!autosave || !canEdit) return null;
                await autosave.flush();
                const state = statusRef.current.state;
                if (state === "conflict") return "Not moved: the draft was changed somewhere else. Load the latest version first.";
                if (state === "invalid" || state === "error" || state === "pending") return "Not moved: the latest changes are not saved yet.";
                return null;
              }}
              onTrashed={(trashPath) => {
                autosaveRef.current?.dispose();
                if (storage) clearBuffer(storage, entry.id, autosaveRef.current?.version ?? entry.draft.version);
                window.location.assign(trashPath);
              }}
            />
          ) : null}
        </div>
      </div>

      {editor && editable ? <LinkDialog editor={editor} open={linkOpen} onOpenChange={setLinkOpen} orgSlug={orgSlug} siteSlug={siteSlug} /> : null}
      {editor && editable ? (
        <MediaPicker
          orgSlug={orgSlug}
          siteSlug={siteSlug}
          open={imageAt !== null}
          onOpenChange={(open) => {
            if (!open) setImageAt(null);
          }}
          title="Insert an image"
          onPick={(picked) => {
            learn(picked);
            // Never an image without a media item: the block is inserted only now, with the one chosen.
            if (imageAt) editor.chain().focus().deleteRange(imageAt).insertContent({ type: "image", attrs: { ...imageBlock.defaults, mediaId: picked.id } }).run();
            setImageAt(null);
          }}
        />
      ) : null}
      {editor && editable ? (
        <EmbedDialog
          open={embedAt !== null}
          onOpenChange={(open) => {
            if (!open) setEmbedAt(null);
          }}
          onInsert={(attrs) => {
            if (embedAt) editor.chain().focus().deleteRange(embedAt).insertContent({ type: "embed", attrs }).run();
            setEmbedAt(null);
          }}
        />
      ) : null}

      <Dialog open={conflictOpen} onOpenChange={setConflictOpen}>
        <DialogContent className="sm:max-w-md" data-testid="conflict-dialog">
          <DialogHeader>
            <DialogTitle>This draft was changed somewhere else</DialogTitle>
            <DialogDescription>
              A newer version was saved in another tab or by someone else. Your latest changes have not been saved, and nothing you type now will be.
            </DialogDescription>
          </DialogHeader>
          {copied ? <FormAlert tone="success">{copied}</FormAlert> : null}
          <DialogFooter>
            <Button type="button" variant="outline" className="h-10 px-4" onClick={copyMine}>
              Copy my changes
            </Button>
            <Button type="button" className="h-10 px-4" onClick={loadLatest}>
              Load the latest version
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * The block menu (M5-5): move the block up or down, duplicate it, delete it. For the block under the drag handle, or the
 * one holding the caret; worked out when the menu opens, from the document as it is then.
 */
function BlockMenu({
  label, editor, indexOf, onAction, children,
}: { label: string; editor: Editor; indexOf: () => number | null; onAction: (index: number | null, action: BlockAction) => void; children: React.ReactNode }) {
  const [target, setTarget] = useState<{ index: number | null; count: number }>({ index: null, count: 0 });
  const { index, count } = target;
  return (
    <DropdownMenu onOpenChange={(open) => open && setTarget({ index: indexOf(), count: editor.state.doc.childCount })}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" aria-label={label}>
        <DropdownMenuItem disabled={index === null || index <= 0} onSelect={() => onAction(index, "up")}>
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem disabled={index === null || index >= count - 1} onSelect={() => onAction(index, "down")}>
          Move down
        </DropdownMenuItem>
        <DropdownMenuItem disabled={index === null} onSelect={() => onAction(index, "duplicate")}>
          Duplicate
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={index === null} variant="destructive" onSelect={() => onAction(index, "delete")}>
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
