"use client";

import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { useId, useState } from "react";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RATIOS } from "@/blocks/columns/schema";
import { providerOf } from "@/blocks/embed/schema";
import { useImagePreview } from "@/blocks/image/preview-context";
import { blockSchema, EDITABLE_BLOCK_TYPES } from "@/blocks/schemas";
import { cn } from "@/lib/utils";
import { MediaPicker, type PickedImage } from "@/modules/media/shared";
import { useEntrySearch } from "../entry-search";
import { emptied, errorsFor, fieldsOf, type Field } from "./fields";

/**
 * The properties panel (plan §6.3; M5-5): the selected custom block's
 * attributes as a form generated from its registry schema. A change is
 * written into the document only when the whole block still passes its
 * schema; otherwise the field keeps what was typed, says why, and the block
 * keeps its last valid attributes (nothing is half-applied, nothing is
 * dropped). Everything else shows the document as it is, so an undo shows
 * here at once. Saving and the server check the document again.
 */

export type CurrentBlock = { type: string; pos: number; attrs: Record<string, unknown>; childCount: number; lastChildEmpty: boolean };

/** The custom block the panel is for: the selected one, or the columns block the caret is in. */
export function currentBlock(editor: Editor): CurrentBlock | null {
  const { selection } = editor.state;
  const describe = (node: NonNullable<ReturnType<typeof editor.state.doc.nodeAt>>, pos: number): CurrentBlock => ({
    type: node.type.name,
    pos,
    attrs: node.attrs as Record<string, unknown>,
    childCount: node.childCount,
    lastChildEmpty: node.childCount > 0 && node.lastChild!.textContent === "" && node.lastChild!.childCount <= 1,
  });
  if (selection instanceof NodeSelection && EDITABLE_BLOCK_TYPES.includes(selection.node.type.name) && selection.node.type.name !== "column") {
    return describe(selection.node, selection.from);
  }
  for (let depth = selection.$from.depth; depth > 0; depth--) {
    const node = selection.$from.node(depth);
    if (node.type.name === "columns") return describe(node, selection.$from.before(depth));
  }
  return null;
}

export function PropertiesPanel({
  editor, block, orgSlug, siteSlug, onImagePicked,
}: {
  editor: Editor;
  block: CurrentBlock;
  orgSlug: string;
  siteSlug: string;
  /** An image chosen in the picker (M6-4): the editor learns its preview before the block shows it. */
  onImagePicked?: (image: PickedImage) => void;
}) {
  const schema = blockSchema(block.type);
  // Only what was typed and does not validate yet; the rest is read from the document.
  const [pending, setPending] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<z.ZodError | undefined>();
  if (!schema) return null;

  const fields = fieldsOf(schema.attrs).map((field) =>
    // A columns block offers only the widths that fit its number of columns.
    block.type === "columns" && field.kind === "select" && field.key === "ratio"
      ? { ...field, options: field.options.filter((option) => (RATIOS[block.childCount as 2 | 3] ?? []).includes(option.value)) }
      : field,
  );

  function change(key: string, value: unknown) {
    const typed: Record<string, unknown> = { ...pending, [key]: emptied(schema!.attrs, key, value) };
    if (block.type === "embed" && key === "url") typed.provider = providerOf(String(value));
    const next = { ...block.attrs, ...typed };
    const parsed = schema!.attrs.safeParse(block.type === "columns" ? { ...next, count: block.childCount } : next);
    if (!parsed.success) {
      setPending(typed);
      return setError(parsed.error);
    }
    setPending({});
    setError(undefined);
    editor
      .chain()
      .command(({ tr }) => {
        tr.setNodeMarkup(block.pos, undefined, { ...block.attrs, ...(parsed.data as Record<string, unknown>) });
        return true;
      })
      .run();
  }

  function addColumn() {
    const node = editor.state.doc.nodeAt(block.pos);
    if (!node || node.childCount >= 3) return;
    const { column, paragraph } = editor.schema.nodes;
    editor.chain().command(({ tr }) => {
      tr.insert(block.pos + node.nodeSize - 1, column!.create(null, paragraph!.create()));
      return true;
    }).run();
  }
  function removeColumn() {
    const node = editor.state.doc.nodeAt(block.pos);
    if (!node || node.childCount <= 2 || !block.lastChildEmpty) return;
    const end = block.pos + node.nodeSize - 1;
    editor.chain().command(({ tr }) => {
      tr.delete(end - node.lastChild!.nodeSize, end);
      return true;
    }).run();
  }

  return (
    <aside aria-label="Block settings" data-testid="properties-panel" className="grid content-start gap-4 rounded-xl border p-4">
      <h2 className="text-sm font-semibold">{schema.label}</h2>
      {block.type === "columns" ? (
        <div className="grid gap-2">
          <p className="text-sm">
            {block.childCount} columns
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" className="h-9 px-3" disabled={block.childCount >= 3} onClick={addColumn}>
              Add a column
            </Button>
            <Button type="button" variant="outline" className="h-9 px-3" disabled={block.childCount <= 2 || !block.lastChildEmpty} onClick={removeColumn}>
              Remove the last column
            </Button>
          </div>
          {block.childCount > 2 && !block.lastChildEmpty ? <p className="text-sm text-muted-foreground">Empty the last column to remove it.</p> : null}
        </div>
      ) : null}
      {fields.map((field) => (
        <FieldControl
          key={field.key}
          field={field}
          value={field.key in pending ? pending[field.key] : block.attrs[field.key]}
          errors={errorsFor(error, field.key)}
          onChange={(value) => change(field.key, value)}
          orgSlug={orgSlug}
          siteSlug={siteSlug}
          onImagePicked={onImagePicked}
        />
      ))}
    </aside>
  );
}

function FieldControl({
  field, value, errors, onChange, orgSlug, siteSlug, onImagePicked,
}: { field: Field; value: unknown; errors: string[]; onChange: (value: unknown) => void; orgSlug: string; siteSlug: string; onImagePicked?: (image: PickedImage) => void }) {
  const id = useId();
  if (field.kind === "text" && field.widget === "media") {
    return <MediaFieldControl label={field.label} value={value} errors={errors} onChange={onChange} orgSlug={orgSlug} siteSlug={siteSlug} onImagePicked={onImagePicked} />;
  }
  const described = [field.description ? `${id}-hint` : null, errors.length ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  const messages = (
    <>
      {field.description ? (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {field.description}
        </p>
      ) : null}
      {errors.length ? (
        <p id={`${id}-error`} className="text-sm text-destructive" role="alert">
          {errors[0]}
        </p>
      ) : null}
    </>
  );
  if (field.kind === "checkbox") {
    return (
      <div className="grid gap-1">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} aria-describedby={described} className="size-4" />
          {field.label}
        </label>
        {messages}
      </div>
    );
  }
  if (field.kind === "select") {
    return (
      <div className="grid gap-2">
        <Label htmlFor={id}>{field.label}</Label>
        <select
          id={id}
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={described}
          className="h-10 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-foreground/25"
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {messages}
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{field.label}</Label>
      <Input
        id={id}
        value={String(value ?? "")}
        maxLength={field.maxLength}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={errors.length ? true : undefined}
        aria-describedby={described}
        autoComplete="off"
        spellCheck={field.widget === "link" ? false : undefined}
        className="h-10"
      />
      {messages}
      {field.widget === "link" ? <EntryPicker orgSlug={orgSlug} siteSlug={siteSlug} onPick={(entryId) => onChange(`entry:${entryId}`)} /> : null}
    </div>
  );
}

/** An image field (M6-4): the image chosen, and the picker to choose another. Never typed: a media id comes from a choice. */
function MediaFieldControl({
  label, value, errors, onChange, orgSlug, siteSlug, onImagePicked,
}: { label: string; value: unknown; errors: string[]; onChange: (value: unknown) => void; orgSlug: string; siteSlug: string; onImagePicked?: (image: PickedImage) => void }) {
  const [open, setOpen] = useState(false);
  const { preview, shown } = useImagePreview(value);
  return (
    <div className="grid gap-2" data-testid="media-field">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex items-center gap-2">
        {preview?.thumbUrl && shown ? (
          // eslint-disable-next-line @next/next/no-img-element -- the site's own thumbnail variant
          <img src={preview.thumbUrl} alt="" width={48} height={48} className="size-12 rounded-md object-cover" />
        ) : null}
        <span className="min-w-0 truncate text-sm">{preview ? preview.name : "Not in the media library any more"}</span>
      </div>
      <Button type="button" variant="outline" className="h-9 justify-self-start px-3" onClick={() => setOpen(true)}>
        Choose another image
      </Button>
      {errors.length ? (
        <p className="text-sm text-destructive" role="alert">
          {errors[0]}
        </p>
      ) : null}
      <MediaPicker
        orgSlug={orgSlug}
        siteSlug={siteSlug}
        open={open}
        onOpenChange={setOpen}
        onPick={(image) => {
          onImagePicked?.(image);
          onChange(image.id);
        }}
      />
    </div>
  );
}

/** A link field's "or a page of this site": the same search as the link dialog. */
function EntryPicker({ orgSlug, siteSlug, onPick }: { orgSlug: string; siteSlug: string; onPick: (entryId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { results, failed } = useEntrySearch(orgSlug, siteSlug, query, open);
  const id = useId();
  if (!open) {
    return (
      <Button type="button" variant="link" className="h-auto justify-self-start p-0 text-sm" onClick={() => setOpen(true)}>
        Or choose a page or post
      </Button>
    );
  }
  return (
    <div className="grid gap-2 rounded-lg border p-2">
      <Label htmlFor={id} className="text-xs">
        Find a page or post
      </Label>
      <Input id={id} type="search" value={query} onChange={(event) => setQuery(event.target.value)} className="h-9" autoComplete="off" />
      {failed ? (
        <p className="text-sm text-destructive">The pages and posts could not be loaded.</p>
      ) : (
        <ul className="grid max-h-40 gap-0.5 overflow-y-auto" aria-label="Pages and posts">
          {(results ?? []).map((match) => (
            <li key={match.id}>
              <button
                type="button"
                className={cn("w-full truncate rounded-md px-2 py-1 text-left text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-foreground/25")}
                onClick={() => {
                  onPick(match.id);
                  setOpen(false);
                }}
              >
                {match.title || "Untitled"} <span className="text-muted-foreground">{match.path}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
