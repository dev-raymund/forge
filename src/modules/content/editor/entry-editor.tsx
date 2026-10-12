"use client";

import "./editor.css";
import type { JSONContent } from "@tiptap/core";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { Bold, Code, Italic, Link2, Strikethrough, Underline } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FormAlert } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { IDLE } from "@/platform/forms";
import { TEXT_NODE_TYPES, textNodeExtensions } from "@/blocks/text-nodes/extensions";
import { publishEntryAction, saveDraftAction } from "../actions";
import { documentProblem, parseDocument } from "../document/parse";
import { DOCUMENT_VERSION } from "../document/schema";
import type { EditorEntry } from "../queries";
import { clearBuffer, createAutosave, readBuffer, type AutosaveStatus, type SaveResult } from "./autosave";
import { dedupeIds } from "./dedupe-ids";
import { LinkDialog } from "./link-dialog";
import { saveResultOf } from "./save-result";
import { filterCommands, slashMatch, type SlashCommand, type SlashRange } from "./slash";

/**
 * The entry editor (M5-4; plan §6.3; ADR 0003): the title, the document, the
 * slash menu, the link picker, autosave with its status, the conflict dialog
 * and the Publish button. Client-only and lazy-loaded (./lazy.tsx).
 *
 * Everything it writes goes through the M5-3 Server Actions, which decide who
 * may and what is valid: what this screen shows or hides is a convenience, not
 * a rule. A save is shown as saved only once the server has answered with the
 * new version; a refused or failed save is shown as not saved.
 */

type DraftPayload = { title: string; doc: JSONContent };

export type EntryEditorProps = {
  orgSlug: string;
  siteSlug: string;
  entry: EditorEntry;
  /** `/s/{address}`: where the entry's path is on the public site. */
  publicPrefix: string | null;
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

type SlashState = { query: string; range: SlashRange; active: number; top: number; left: number };

export function EntryEditor({ orgSlug, siteSlug, entry, publicPrefix }: EntryEditorProps) {
  const unsupported = useMemo(() => [...nodeTypesOf(entry.draft.content)].filter((type) => !TEXT_NODE_TYPES.has(type)), [entry.draft.content]);
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
  const [publishing, setPublishing] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(
    restored ? { tone: "success", text: "Changes that had not been saved were restored. They are being saved now." } : null,
  );
  const [slash, setSlash] = useState<SlashState | null>(null);
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
        data.set("draft", JSON.stringify({ title: draft.title, content: parsed.document }));
        return saveResultOf(await saveDraftAction(orgSlug, siteSlug, entry.id, IDLE, data));
      },
    });
    autosaveRef.current = controller;
    return () => controller.dispose();
  }, [entry.id, entry.draft.version, storage, orgSlug, siteSlug]);

  const payload = (editor: Editor): DraftPayload => ({ title: titleRef.current, doc: editor.getJSON() });
  const changed = (editor: Editor) => autosaveRef.current?.change(payload(editor));

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
    command.run(editor, menu.range);
  }

  const editor = useEditor({
    extensions: textNodeExtensions,
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
        const items = filterCommands(menu.query);
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
      if (restored) changed(editor);
    },
    onUpdate: ({ editor }) => {
      changed(editor);
      updateSlash(editor);
    },
    onSelectionUpdate: ({ editor }) => updateSlash(editor),
    onBlur: () => showSlash(null),
  });

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
  const upToDate = isLive && live.version === savedVersion && (status.state === "idle" || status.state === "saved");
  const address = publicPrefix ? `${publicPrefix}${live.path === "/" ? "" : live.path}` : live.path;
  const items = slash ? filterCommands(slash.query) : [];

  return (
    <div className="forge-entry-editor mx-auto grid w-full max-w-3xl gap-4 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          data-testid="entry-status"
          className={cn(
            "inline-flex h-6 items-center rounded-full border px-2.5 text-xs font-medium",
            isLive ? "border-emerald-700/30 bg-emerald-50 text-emerald-900" : "border-amber-700/30 bg-amber-50 text-amber-900",
          )}
        >
          {isLive ? (upToDate ? "Published" : "Published, with unpublished changes") : "Draft"}
        </span>
        {entry.isHome ? <span className="text-sm text-muted-foreground">Home page</span> : null}
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
          {canEdit && entry.canPublish ? (
            <Button type="button" className="h-9 px-4" onClick={publish} aria-busy={publishing || undefined} disabled={publishing || conflict}>
              {publishing ? "Publishing…" : isLive ? "Publish changes" : "Publish"}
            </Button>
          ) : null}
        </span>
      </div>

      {notice ? <FormAlert tone={notice.tone}>{notice.text}</FormAlert> : null}
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
          <span className="ml-auto hidden self-center text-xs text-muted-foreground sm:inline">Type / for headings, lists, quotes and dividers</span>
        </div>
      ) : null}

      <div ref={surface} className="relative">
        {editor && !unsupported.length ? <EditorContent editor={editor} /> : null}
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

      {editor && editable ? <LinkDialog editor={editor} open={linkOpen} onOpenChange={setLinkOpen} orgSlug={orgSlug} siteSlug={siteSlug} /> : null}

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
