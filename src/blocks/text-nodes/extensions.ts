import { Extension, type AnyExtension } from "@tiptap/core";
import Blockquote from "@tiptap/extension-blockquote";
import HorizontalRule from "@tiptap/extension-horizontal-rule";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { isSafeHref } from "../links";

/**
 * The editor's text nodes (M5-4; plan §6.1; from the M0-5 spike, ADR 0003):
 * heading (2–4), paragraph, bullet and numbered lists, quote and divider, with
 * the marks bold, italic, underline, strike, code and link. No React here.
 * The editor's whole schema (these, the custom blocks, ids, reordering) is
 * assembled in `modules/content/editor/extensions.ts` (M5-5).
 *
 * The schema is closed: pasted HTML can only become what exists (a `<script>`
 * or an `<iframe>` has nowhere to go). Links keep only `http(s)`, `mailto`,
 * `tel`, site paths and `entry:{id}`.
 */

/** `style` would collide with the HTML style attribute: it travels as `data-style`. */
const ForgeHorizontalRule = HorizontalRule.extend({
  addAttributes: () => ({
    style: {
      default: "line",
      parseHTML: (element: HTMLElement) => (element.getAttribute("data-style") === "space" ? "space" : "line"),
      renderHTML: (attributes: { style?: string }) => ({ "data-style": attributes.style ?? "line" }),
    },
  }),
});

const ForgeBlockquote = Blockquote.extend({
  addAttributes: () => ({ cite: { default: null } }),
});

/**
 * Pasted headings outside 2–4 (ADR 0003 gap 8): a page has one `h1`, its
 * title, so a pasted `h1` becomes an `h2`; `h5` and `h6` become `h4`. Without
 * this they would arrive as paragraphs.
 */
export function mapPastedHeadings(html: string): string {
  return html.replace(/<(\/?)h([1-6])(?=[\s>/])/gi, (_match, slash: string, level: string) => {
    const mapped = level === "1" ? 2 : Number(level) > 4 ? 4 : Number(level);
    return `<${slash}h${mapped}`;
  });
}

const PastedHeadings = Extension.create({
  name: "pastedHeadings",
  addProseMirrorPlugins: () => [new Plugin({ key: new PluginKey("pastedHeadings"), props: { transformPastedHTML: mapPastedHeadings } })],
});

/** Node types that carry a stable `id` (plan §6.2: every top-level node). */
export const TEXT_ID_TYPES = ["paragraph", "heading", "blockquote", "bulletList", "orderedList", "horizontalRule"] as const;

/** The text node types (with the document and list items). */
export const TEXT_NODE_TYPES: ReadonlySet<string> = new Set(["doc", "text", "listItem", ...TEXT_ID_TYPES]);

/** The text nodes and marks. The document node is the editor's (it also holds the "layout" group: columns). */
export const textNodes: AnyExtension[] = [
  StarterKit.configure({
    document: false,
    blockquote: false,
    horizontalRule: false,
    codeBlock: false, // not in the V1 block set
    hardBreak: false, // not in the V1 block set
    heading: { levels: [2, 3, 4] },
    link: {
      openOnClick: false,
      autolink: true,
      protocols: ["mailto", "tel"],
      HTMLAttributes: { target: null, rel: null, class: null },
      isAllowedUri: (url) => isSafeHref(url),
      shouldAutoLink: (url) => isSafeHref(url),
    },
  }),
  ForgeBlockquote,
  ForgeHorizontalRule,
  PastedHeadings,
];
