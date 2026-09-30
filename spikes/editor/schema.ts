import { z } from "zod";

/**
 * Stored document contract (plan §6.2): `{ v, doc }` in ProseMirror JSON shape.
 * Closed: only these nodes and marks exist. Server-safe (no DOM, no React).
 */

export const DOCUMENT_VERSION = 1;
export const MAX_DOCUMENT_BYTES = 1_000_000;
export const MAX_NODES = 2_000;

// ── Links ────────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

/** `http(s)`, `mailto`, `tel`, a site-relative `/path`, or `entry:{uuid}` (§6.1). */
export function isSafeHref(href: string): boolean {
  if (href.startsWith("entry:")) return UUID.test(href.slice("entry:".length));
  if (href.startsWith("/")) return !href.startsWith("//") && !href.includes("\\");
  try {
    return SAFE_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

const href = z.string().max(2048).refine(isSafeHref, "Unsupported link");

// ── Embeds ───────────────────────────────────────────────────────────────────

export const EMBED_PROVIDERS = ["youtube", "vimeo"] as const;
export type EmbedProvider = (typeof EMBED_PROVIDERS)[number];

/** The privacy-enhanced iframe URL for an allow-listed provider, or null. */
export function embedSrc(provider: string, url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^www\.|^m\./, "");
  if (provider === "youtube") {
    const id =
      host === "youtu.be"
        ? u.pathname.slice(1)
        : host === "youtube.com" || host === "youtube-nocookie.com"
          ? u.pathname === "/watch"
            ? u.searchParams.get("v")
            : u.pathname.match(/^\/(?:embed|shorts)\/([^/]+)/)?.[1]
          : null;
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  }
  if (provider === "vimeo") {
    const id = host === "vimeo.com" ? u.pathname.match(/^\/(\d{6,12})$/)?.[1] : null;
    return id ? `https://player.vimeo.com/video/${id}?dnt=1` : null;
  }
  return null;
}

// ── Attributes (one schema per node type) ────────────────────────────────────

const id = z.uuid();
const text = (max: number) => z.string().max(max);

export const attrs = {
  paragraph: z.object({ id }),
  heading: z.object({ id, level: z.union([z.literal(2), z.literal(3), z.literal(4)]) }),
  blockquote: z.object({ id, cite: text(200).nullable().default(null) }),
  bulletList: z.object({ id }),
  orderedList: z.object({ id, start: z.int().min(1).max(10_000).default(1) }),
  horizontalRule: z.object({ id, style: z.enum(["line", "space"]).default("line") }),
  image: z.object({
    id,
    v: z.literal(1),
    mediaId: z.uuid(),
    alt: text(500).nullable().default(null),
    caption: text(1000).nullable().default(null),
    size: z.enum(["content", "wide", "full"]).default("content"),
    link: href.nullable().default(null),
  }),
  button: z.object({
    id,
    v: z.literal(1),
    label: text(80).min(1),
    href,
    style: z.enum(["primary", "secondary"]).default("primary"),
    align: z.enum(["start", "center", "end"]).default("start"),
    newTab: z.boolean().default(false),
  }),
  columns: z
    .object({
      id,
      v: z.literal(1),
      count: z.union([z.literal(2), z.literal(3)]),
      ratio: z.enum(["1:1", "2:1", "1:2", "1:1:1", "2:1:1", "1:2:1", "1:1:2"]).default("1:1"),
      stackOnMobile: z.boolean().default(true),
    })
    .refine((a) => a.ratio.split(":").length === a.count, { message: "ratio must have one part per column" }),
  column: z.object({ id }),
  embed: z
    .object({
      id,
      v: z.literal(1),
      provider: z.enum(EMBED_PROVIDERS),
      url: z.url().max(2048),
      aspect: z.enum(["16:9", "4:3", "1:1", "9:16"]).default("16:9"),
    })
    .refine((a) => embedSrc(a.provider, a.url) !== null, { message: "Unsupported embed URL", path: ["url"] }),
  spacer: z.object({ id, v: z.literal(1), size: z.enum(["sm", "md", "lg", "xl"]).default("md") }),
} as const;

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
