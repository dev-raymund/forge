import { z } from "zod";

/**
 * A block of the editor's registry (plan §6; M5-5): its stored attributes as a
 * Zod schema, its current attribute version `v`, and `migrate[n]`, which turns
 * attributes of version n into version n + 1 (ADR 0003: every custom node
 * carries `v`, so old documents are upgraded when they are read). Pure and
 * client-safe: the document's validation, the editor and the renderers share it.
 *
 * Panel hints ride on the schema with Zod's `.meta()`: `title` (the field's
 * label), `description` (help under it), `options` (labels for an enum's
 * values), `widget: "link"` (a link field with the page picker) and `hidden`
 * (kept out of the properties panel).
 */

export type Attrs = Record<string, unknown>;
export type BlockMigrations = Readonly<Record<number, (attrs: Attrs) => Attrs>>;

export type BlockSchema<S extends z.ZodType = z.ZodType> = {
  type: string;
  label: string;
  /** The current version of the attributes; stored on every node as `attrs.v`. */
  v: number;
  migrate: BlockMigrations;
  attrs: S;
  /** What a new block of this type starts with (valid, so a new block never makes the document invalid). */
  defaults: Attrs;
  /**
   * Whether the editor can create and edit it. The image block (M6-4) is validated
   * and stored already, but has no editor or renderer until the media picker exists.
   */
  editable: boolean;
};

export const defineBlock = <S extends z.ZodType>(block: BlockSchema<S>): BlockSchema<S> => block;

/** A block's stable id (plan §6.2): a UUID, assigned by the editor (UUIDv7). */
export const blockId = z.uuid().meta({ hidden: true });

export type PanelMeta = { title?: string; description?: string; options?: Record<string, string>; widget?: "link"; hidden?: boolean };
