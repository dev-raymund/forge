import type { z } from "zod";
import type { PanelMeta } from "@/blocks/define";

/**
 * The properties panel's fields, generated from a block's attribute schema
 * (plan §6.3; M5-5): each key of the Zod object becomes a text field, a choice
 * or a switch, labelled by its `.meta()` hints. Keys marked `hidden` (the id,
 * `v`, a columns block's `count`, an embed's `provider`) are not fields. Pure.
 */

export type Field =
  | { key: string; kind: "text"; label: string; description?: string; maxLength?: number; widget?: "link" | "media" }
  | { key: string; kind: "select"; label: string; description?: string; options: { value: string; label: string }[] }
  | { key: string; kind: "checkbox"; label: string; description?: string };

type Def = { type: string; innerType?: z.ZodType; shape?: Record<string, z.ZodType>; entries?: Record<string, string>; checks?: { _zod: { def: { check: string; maximum?: number } } }[] };
const defOf = (schema: z.ZodType): Def => (schema as unknown as { _zod: { def: Def } })._zod.def;

/** The schema under `default`, `optional`, `nullable` and `readonly`. */
function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (let def = defOf(current); ["default", "optional", "nullable", "readonly", "prefault"].includes(def.type) && def.innerType; def = defOf(current)) {
    current = def.innerType;
  }
  return current;
}

const metaOf = (schema: z.ZodType): PanelMeta => ((schema as unknown as { meta: () => PanelMeta | undefined }).meta?.() ?? {}) as PanelMeta;

export function fieldsOf(schema: z.ZodType): Field[] {
  const shape = defOf(schema).shape;
  if (!shape) return [];
  const fields: Field[] = [];
  for (const [key, field] of Object.entries(shape)) {
    const meta = { ...metaOf(unwrap(field)), ...metaOf(field) };
    if (meta.hidden) continue;
    const inner = unwrap(field);
    const def = defOf(inner);
    const label = meta.title ?? key;
    const description = meta.description;
    if (def.type === "enum" && def.entries) {
      const values = Object.values(def.entries);
      fields.push({ key, kind: "select", label, description, options: values.map((value) => ({ value, label: meta.options?.[value] ?? value })) });
    } else if (def.type === "boolean") {
      fields.push({ key, kind: "checkbox", label, description });
    } else if (def.type === "string") {
      const maxLength = def.checks?.find((check) => check._zod.def.check === "max_length")?._zod.def.maximum;
      fields.push({ key, kind: "text", label, description, maxLength, widget: meta.widget });
    }
  }
  return fields;
}

/** The messages a block's schema gives for one key, for the panel to show under that field. */
export function errorsFor(error: z.ZodError | undefined, key: string): string[] {
  return error ? error.issues.filter((issue) => issue.path[0] === key).map((issue) => issue.message) : [];
}

/**
 * What an emptied field holds: nothing (null) where the schema allows it (an image's alt text, caption or link,
 * M6-4), otherwise the empty text, for the schema to judge. An image's emptied alt text is "the image's own", not "none".
 */
export function emptied(schema: z.ZodType, key: string, value: unknown): unknown {
  if (value !== "") return value;
  const field = defOf(schema).shape?.[key];
  return field && field.safeParse(null).success ? null : value;
}
