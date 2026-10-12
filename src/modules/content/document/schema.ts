import { z } from "zod";
import { isSafeHref, LINK_MAX } from "@/blocks/links";
import { NODE_ATTRS } from "@/blocks/schemas";

/**
 * Stored document contract (plan §6.2): `{ v, doc }` in ProseMirror JSON shape.
 * Closed: only these nodes and marks exist. Server-safe (no DOM, no React).
 *
 * Carried over from the M0-5 spike (spikes/editor/schema.ts, ADR 0003) in M5-3.
 * Since M5-5 every node's attributes come from the block registry
 * (`src/blocks/schemas.ts`); what is here is the tree: which node may hold
 * which, the marks, and the limits.
 */

export const DOCUMENT_VERSION = 1;
export const MAX_DOCUMENT_BYTES = 1_000_000;
export const MAX_NODES = 2_000;

// ── Links, embeds and attributes: the block registry's (src/blocks, M5-5) ───

export { entryIdOf, isSafeHref } from "@/blocks/links";
export { EMBED_PROVIDERS, embedSrc, providerOf } from "@/blocks/embed/schema";
export type { EmbedProvider } from "@/blocks/embed/schema";

/** Every node type's attributes, from the block registry: the one definition of what a document may hold. */
export const attrs = NODE_ATTRS;

const href = z.string().max(LINK_MAX).refine(isSafeHref, "Unsupported link");

// ── Marks and inline content ─────────────────────────────────────────────────

export const markSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bold") }),
  z.object({ type: z.literal("italic") }),
  z.object({ type: z.literal("underline") }),
  z.object({ type: z.literal("strike") }),
  z.object({ type: z.literal("code") }),
  z.object({ type: z.literal("link"), attrs: z.object({ href }) }),
]);
export type Mark = z.infer<typeof markSchema>;

export const textSchema = z.object({
  type: z.literal("text"),
  text: z.string().min(1).max(100_000),
  marks: z.array(markSchema).max(6).optional(),
});
export type TextNode = z.infer<typeof textSchema>;

// ── Block tree ───────────────────────────────────────────────────────────────

type A<K extends keyof typeof attrs> = z.infer<(typeof attrs)[K]>;
export type Paragraph = { type: "paragraph"; attrs: A<"paragraph">; content?: TextNode[] };
export type Heading = { type: "heading"; attrs: A<"heading">; content?: TextNode[] };
export type Blockquote = { type: "blockquote"; attrs: A<"blockquote">; content: Block[] };
export type ListItem = { type: "listItem"; content: [Paragraph, ...Block[]] };
export type BulletList = { type: "bulletList"; attrs: A<"bulletList">; content: ListItem[] };
export type OrderedList = { type: "orderedList"; attrs: A<"orderedList">; content: ListItem[] };
export type HorizontalRule = { type: "horizontalRule"; attrs: A<"horizontalRule"> };
export type Image = { type: "image"; attrs: A<"image"> };
export type Button = { type: "button"; attrs: A<"button"> };
export type Embed = { type: "embed"; attrs: A<"embed"> };
export type Spacer = { type: "spacer"; attrs: A<"spacer"> };
/** Anything allowed inside a column, quote or list item: every block except `columns`. */
export type Block =
  | Paragraph
  | Heading
  | Blockquote
  | BulletList
  | OrderedList
  | HorizontalRule
  | Image
  | Button
  | Embed
  | Spacer;
export type Column = { type: "column"; attrs: A<"column">; content: Block[] };
export type Columns = { type: "columns"; attrs: A<"columns">; content: Column[] };
export type TopLevel = Block | Columns;
export type Doc = { type: "doc"; content: TopLevel[] };
export type StoredDocument = { v: typeof DOCUMENT_VERSION; doc: Doc };

const inline = z.array(textSchema).max(5_000).optional();
const node = <T extends string, S extends z.ZodType>(type: T, a: S) => z.object({ type: z.literal(type), attrs: a });

const paragraph = node("paragraph", attrs.paragraph).extend({ content: inline });
const listItem: z.ZodType<ListItem> = z.object({
  type: z.literal("listItem"),
  get content() {
    return z.tuple([paragraph], blockSchema);
  },
});

export const blockSchema: z.ZodType<Block> = z.lazy(() =>
  z.discriminatedUnion("type", [
    paragraph,
    node("heading", attrs.heading).extend({ content: inline }),
    node("blockquote", attrs.blockquote).extend({ content: z.array(blockSchema).min(1) }),
    node("bulletList", attrs.bulletList).extend({ content: z.array(listItem).min(1) }),
    node("orderedList", attrs.orderedList).extend({ content: z.array(listItem).min(1) }),
    node("horizontalRule", attrs.horizontalRule),
    node("image", attrs.image),
    node("button", attrs.button),
    node("embed", attrs.embed),
    node("spacer", attrs.spacer),
  ]),
) as z.ZodType<Block>;

const column = node("column", attrs.column).extend({ content: z.array(blockSchema).min(1) });
const columns = node("columns", attrs.columns)
  .extend({ content: z.array(column).min(2).max(3) })
  .refine((c) => c.content.length === c.attrs.count, { message: "columns.count must match its columns" });

export const topLevelSchema: z.ZodType<TopLevel> = z.union([blockSchema, columns]) as z.ZodType<TopLevel>;

export const storedDocumentSchema: z.ZodType<StoredDocument> = z.object({
  v: z.literal(DOCUMENT_VERSION),
  doc: z.object({ type: z.literal("doc"), content: z.array(topLevelSchema).min(1) }),
}) as z.ZodType<StoredDocument>;

// ── Limits ───────────────────────────────────────────────────────────────────

/** Counts every node (including text) without trusting the shape. */
export function countNodes(value: unknown, limit = Infinity): number {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length && count <= limit) {
    const n = stack.pop();
    if (!n || typeof n !== "object") continue;
    count++;
    const content = (n as { content?: unknown }).content;
    if (Array.isArray(content)) stack.push(...content);
  }
  return count;
}
