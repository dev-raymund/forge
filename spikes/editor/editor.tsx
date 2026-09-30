"use client";

import "./editor.css";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createAutosave, type AutosaveStatus } from "./autosave";
import { createDemoServer } from "./demo-server";
import { parseDocument } from "./document";
import { forgeExtensions } from "./extensions";
import { ENTRY_ID, MEDIA_ID, sampleDocument } from "./fixtures";
import { withNodeViews } from "./node-views";
import { renderDocument, type RenderContext } from "./render";

/** Manual test page for spike S3 (ADR 0003). Not the product editor shell. */

const DEMO_IMAGE =
  "data:image/svg+xml;utf8," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600"><rect width="100%" height="100%" fill="#e5e7eb"/><text x="50%" y="50%" font-size="48" text-anchor="middle" fill="#6b7280">Demo image</text></svg>');

const previewContext: RenderContext = {
  resolveMedia: (id) => (id === MEDIA_ID ? { src: DEMO_IMAGE, width: 1200, height: 600, alt: "Demo image" } : undefined),
  resolveEntryHref: (id) => (id === ENTRY_ID ? "/services" : undefined),
};

const INSERTS: [string, (e: Editor) => boolean][] = [
  ["Heading", (e) => e.chain().focus().toggleHeading({ level: 2 }).run()],
  ["Quote", (e) => e.chain().focus().toggleBlockquote().run()],
  ["Bullets", (e) => e.chain().focus().toggleBulletList().run()],
  ["Numbers", (e) => e.chain().focus().toggleOrderedList().run()],
  ["Divider", (e) => e.chain().focus().setHorizontalRule().run()],
  ["Image", (e) => e.chain().focus().insertContent({ type: "image", attrs: { mediaId: MEDIA_ID, size: "content" } }).run()],
  ["Button", (e) => e.chain().focus().insertContent({ type: "button", attrs: { label: "Contact us", href: "/contact" } }).run()],
  ["Columns", (e) =>
    e.chain().focus().insertContent({
      type: "columns",
      attrs: { count: 2, ratio: "1:1" },
      content: [
        { type: "column", content: [{ type: "paragraph" }] },
        { type: "column", content: [{ type: "paragraph" }] },
      ],
    }).run()],
  ["Embed", (e) =>
    e.chain().focus().insertContent({ type: "embed", attrs: { provider: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } }).run()],
  ["Spacer", (e) => e.chain().focus().insertContent({ type: "spacer", attrs: { size: "md" } }).run()],
];

const MARKS: [string, (e: Editor) => boolean][] = [
  ["B", (e) => e.chain().focus().toggleBold().run()],
  ["I", (e) => e.chain().focus().toggleItalic().run()],
  ["U", (e) => e.chain().focus().toggleUnderline().run()],
  ["S", (e) => e.chain().focus().toggleStrike().run()],
  ["Code", (e) => e.chain().focus().toggleCode().run()],
  ["Link", (e) => e.chain().focus().setLink({ href: "/about" }).run()],
];

function statusText(s: AutosaveStatus): string {
  switch (s.state) {
    case "saved": return `Saved · v${s.version} · ${s.at.toLocaleTimeString()}`;
    case "conflict": return `Conflict: someone saved v${s.currentVersion}`;
    case "invalid": return `Invalid: ${(s.issues ?? []).join("; ")}`;
    case "error": return `Error: ${s.message}`;
    default: return s.state === "idle" ? "No changes" : s.state === "pending" ? "Unsaved changes…" : "Saving…";
  }
}

export function EditorSpike() {
  const server = useMemo(() => createDemoServer(sampleDocument), []);
  const [status, setStatus] = useState<AutosaveStatus>({ state: "idle" });
  const autosave = useMemo(
    () =>
      createAutosave<unknown>({
        entryId: "spike",
        version: server.version,
        save: (expected, doc) => server.save(expected, doc),
        storage: typeof window === "undefined" ? undefined : window.localStorage,
        onStatus: setStatus,
      }),
    [server],
  );
  useEffect(() => () => autosave.dispose(), [autosave]);
  const extensions = useMemo(() => withNodeViews(forgeExtensions), []);

  const editor = useEditor({
    extensions,
    content: sampleDocument.doc,
    immediatelyRender: false,
    editorProps: { attributes: { "aria-label": "Content editor", "data-testid": "editor" } },
    onUpdate: ({ editor }) => autosave.change(editor.getJSON()),
  });
  const json = useEditorState({ editor, selector: ({ editor }) => editor?.getJSON() ?? null });
  const parsed = useMemo(() => (json ? parseDocument({ v: 1, doc: json }) : null), [json]);
  const lastSaved = useRef(server.document);

  if (!editor) return <p>Loading editor…</p>;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="forge-editor rounded-md border">
        <div className="flex flex-wrap gap-1 border-b p-2 text-sm" role="toolbar" aria-label="Blocks">
          {INSERTS.map(([label, run]) => (
            <button key={label} type="button" className="rounded border px-2 py-0.5" onClick={() => run(editor)}>
              {label}
            </button>
          ))}
          <span className="mx-1 border-l" />
          {MARKS.map(([label, run]) => (
            <button key={label} type="button" className="rounded border px-2 py-0.5" onClick={() => run(editor)}>
              {label}
            </button>
          ))}
          <span className="mx-1 border-l" />
          <button type="button" className="rounded border px-2 py-0.5" onClick={() => editor.chain().focus().moveBlockUp().run()}>
            Move up
          </button>
          <button type="button" className="rounded border px-2 py-0.5" onClick={() => editor.chain().focus().moveBlockDown().run()}>
            Move down
          </button>
          <button type="button" className="rounded border px-2 py-0.5" onClick={() => editor.chain().focus().undo().run()}>
            Undo
          </button>
        </div>
        <DragHandle editor={editor}>
          <div className="forge-drag-handle" data-testid="drag-handle" aria-label="Drag to reorder">
            ⠿
          </div>
        </DragHandle>
        <EditorContent editor={editor} />
        <div className="flex flex-wrap items-center gap-2 border-t p-2 text-sm">
          <span data-testid="autosave-status">{statusText(status)}</span>
          <button type="button" className="rounded border px-2 py-0.5" onClick={() => server.simulateOtherTab()}>
            Simulate a save from another tab
          </button>
          {status.state === "conflict" ? (
            <>
              <button
                type="button"
                className="rounded border px-2 py-0.5"
                onClick={() => {
                  lastSaved.current = server.document;
                  editor.commands.setContent(server.document.doc, { emitUpdate: false });
                  autosave.resume(server.version);
                  setStatus({ state: "idle" });
                }}
              >
                Reload latest
              </button>
              <button type="button" className="rounded border px-2 py-0.5" onClick={() => autosave.resume(server.version)}>
                Overwrite
              </button>
            </>
          ) : null}
        </div>
      </section>
      <section className="grid gap-4">
        <div className="forge-preview rounded-md border p-4" data-testid="preview">
          {parsed?.ok ? renderDocument(parsed.document, previewContext) : <p>Invalid document: {parsed?.ok === false && parsed.error}</p>}
        </div>
        <pre className="max-h-96 overflow-auto rounded-md border p-2 text-xs" data-testid="json">
          {JSON.stringify(parsed?.ok ? parsed.document : json, null, 1)}
        </pre>
      </section>
    </div>
  );
}
