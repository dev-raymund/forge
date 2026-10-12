import { Fragment, type ReactNode } from "react";
import { BLOCK_RENDERERS } from "@/blocks/render";
import { resolveHref, type BlockRenderContext } from "@/blocks/render-context";
import { NODE_ATTRS } from "@/blocks/schemas";

/**
 * The closed renderer (plan §6.2, D-38; M5-6, from the M0-5 spike): a stored
 * `{ v, doc }` document → React elements. It emits only RENDERED_ELEMENTS,
 * never stored HTML, and never `dangerouslySetInnerHTML`.
 *
 * Every node is checked again here, against the block registry's schemas,
 * whatever was checked when it was saved: a document from before a rule, or
 * one written around the services, renders what is valid and skips the rest.
 * A skipped node is reported through `onSkip`, never silently dropped:
 *
 *   unknown           a node type that does not exist (or one out of place: a column outside columns, a list item outside a list)
 *   invalid           attributes its schema refuses
 *   not drawn         valid, but its renderer drew nothing (a button whose page is not live)
 *   not rendered yet  the image: its renderer is M6-4's (ADR 0003 addendum M5-5)
 *   too deep / too many   past the limits below
 *
 * The custom blocks are drawn by their registry renderers (`BLOCK_RENDERERS`);
 * the text nodes and marks here.
 */

export const RENDERED_ELEMENTS = [
  "p", "h2", "h3", "h4", "strong", "em", "u", "s", "code", "a",
  "blockquote", "figure", "figcaption", "cite", "ul", "ol", "li", "hr", "div", "iframe",
] as const;

export type SkipReason = "unknown" | "invalid" | "not drawn" | "not rendered yet" | "too deep" | "too many";

export type DocumentRenderContext = BlockRenderContext & { onSkip?: (type: string, reason: SkipReason) => void };

/** Deeper than any document the editor can make (columns › column › list › item › quote …): a hostile one stops here. */
const MAX_DEPTH = 24;
/** Above the 2,000 nodes a saved document may have (plan §6.2). */
const MAX_NODES = 5_000;
/** In the schema, drawn by a later milestone. */
const NOT_RENDERED_YET = new Set(["image"]);

type AnyNode = { type?: unknown; attrs?: unknown; content?: unknown; text?: unknown; marks?: unknown };
type Walk = { context: DocumentRenderContext; nodes: number };

const typeOf = (node: unknown): string => (node && typeof node === "object" && typeof (node as AnyNode).type === "string" ? ((node as AnyNode).type as string) : "?");
const childrenOf = (node: AnyNode): AnyNode[] => (Array.isArray(node.content) ? (node.content as AnyNode[]) : []);

function validAttrs(type: keyof typeof NODE_ATTRS, node: AnyNode, walk: Walk): Record<string, unknown> | null {
  const result = NODE_ATTRS[type].safeParse(node.attrs ?? {});
  if (!result.success) walk.context.onSkip?.(type, "invalid");
  return result.success ? (result.data as Record<string, unknown>) : null;
}

// ── Text and marks ───────────────────────────────────────────────────────────

const FORMATS: Readonly<Record<string, (inner: ReactNode) => ReactNode>> = {
  bold: (inner) => <strong>{inner}</strong>,
  italic: (inner) => <em>{inner}</em>,
  underline: (inner) => <u>{inner}</u>,
  strike: (inner) => <s>{inner}</s>,
  code: (inner) => <code>{inner}</code>,
};

/** A run of text with its marks, in their stored order, the link outermost. A mark that is unknown, or a link that may not be drawn, leaves plain text. */
function renderText(node: AnyNode, key: number, walk: Walk): ReactNode {
  if (typeof node.text !== "string" || node.text === "") return null;
  let out: ReactNode = node.text;
  let href: string | undefined;
  const seen = new Set<string>();
  for (const mark of Array.isArray(node.marks) ? (node.marks as AnyNode[]) : []) {
    const type = typeOf(mark);
    if (seen.has(type)) continue;
    seen.add(type);
    if (type === "link") href = resolveHref((mark.attrs as { href?: unknown } | undefined)?.href, walk.context);
    else if (Object.hasOwn(FORMATS, type)) out = FORMATS[type]!(out);
  }
  return <Fragment key={key}>{href ? <a href={href}>{out}</a> : out}</Fragment>;
}

/** The text inside a paragraph or a heading. Anything but text there is skipped. */
function inline(node: AnyNode, walk: Walk): ReactNode[] {
  return childrenOf(node).map((child, index) => {
    if (typeOf(child) === "text") return renderText(child, index, walk);
    walk.context.onSkip?.(typeOf(child), "unknown");
    return null;
  });
}

// ── Blocks ───────────────────────────────────────────────────────────────────

function blocks(nodes: AnyNode[], depth: number, walk: Walk): ReactNode[] {
  return nodes.map((child, index) => renderBlock(child, index, depth, walk));
}

function renderBlock(node: AnyNode, key: number, depth: number, walk: Walk): ReactNode {
  const type = typeOf(node);
  if (depth > MAX_DEPTH) {
    walk.context.onSkip?.(type, "too deep");
    return null;
  }
  if (++walk.nodes > MAX_NODES) {
    if (walk.nodes === MAX_NODES + 1) walk.context.onSkip?.(type, "too many");
    return null;
  }
  switch (type) {
    case "paragraph":
      return validAttrs("paragraph", node, walk) && <p key={key}>{inline(node, walk)}</p>;
    case "heading": {
      const attrs = validAttrs("heading", node, walk) as { level: 2 | 3 | 4 } | null;
      if (!attrs) return null;
      const Heading = `h${attrs.level}` as const;
      return <Heading key={key}>{inline(node, walk)}</Heading>;
    }
    case "blockquote": {
      const attrs = validAttrs("blockquote", node, walk) as { cite: string | null } | null;
      if (!attrs) return null;
      const quote = <blockquote>{blocks(childrenOf(node), depth + 1, walk)}</blockquote>;
      // Who said it goes beside the quote, not inside it.
      return attrs.cite ? (
        <figure key={key} className="forge-quote">
          {quote}
          <figcaption>
            <cite>{attrs.cite}</cite>
          </figcaption>
        </figure>
      ) : (
        <Fragment key={key}>{quote}</Fragment>
      );
    }
    case "bulletList":
    case "orderedList": {
      const attrs = validAttrs(type, node, walk) as { start?: number } | null;
      if (!attrs) return null;
      const items = childrenOf(node).map((item, index) => {
        if (typeOf(item) === "listItem") return <li key={index}>{blocks(childrenOf(item), depth + 2, walk)}</li>;
        walk.context.onSkip?.(typeOf(item), "unknown");
        return null;
      });
      if (type === "bulletList") return <ul key={key}>{items}</ul>;
      return (
        <ol key={key} start={attrs.start && attrs.start > 1 ? attrs.start : undefined}>
          {items}
        </ol>
      );
    }
    case "horizontalRule": {
      const attrs = validAttrs("horizontalRule", node, walk) as { style: "line" | "space" } | null;
      return attrs && <hr key={key} className={`forge-divider forge-divider--${attrs.style}`} />;
    }
    case "columns":
      return renderColumns(node, key, depth, walk);
    default: {
      if (NOT_RENDERED_YET.has(type)) {
        walk.context.onSkip?.(type, "not rendered yet");
        return null;
      }
      const renderer = type !== "column" && Object.hasOwn(BLOCK_RENDERERS, type) ? BLOCK_RENDERERS[type]! : null;
      if (!renderer) {
        walk.context.onSkip?.(type, "unknown");
        return null;
      }
      const out = renderer({ attrs: node.attrs, children: [], context: walk.context });
      if (out === null || out === undefined) walk.context.onSkip?.(type, NODE_ATTRS[type as keyof typeof NODE_ATTRS]?.safeParse(node.attrs).success ? "not drawn" : "invalid");
      return <Fragment key={key}>{out}</Fragment>;
    }
  }
}

/** Columns: each column's blocks rendered, then the registry's renderer lays them out. Columns never hold columns. */
function renderColumns(node: AnyNode, key: number, depth: number, walk: Walk): ReactNode {
  const columns = childrenOf(node);
  if (columns.some((column) => typeOf(column) !== "column")) {
    walk.context.onSkip?.("columns", "invalid");
    return null;
  }
  const rendered = columns.map((column) =>
    blocks(
      childrenOf(column).filter((child) => {
        if (typeOf(child) !== "columns") return true;
        walk.context.onSkip?.("columns", "invalid");
        return false;
      }),
      depth + 2,
      walk,
    ),
  );
  const out = BLOCK_RENDERERS.columns!({ attrs: node.attrs, children: rendered, context: walk.context });
  if (!out) walk.context.onSkip?.("columns", "invalid");
  return <Fragment key={key}>{out}</Fragment>;
}

/**
 * A stored document, or anything else, rendered safely: only a `{ doc: { type: "doc", content: […] } }` shape is
 * walked; anything else renders nothing.
 */
export function renderDocument(document: unknown, context: DocumentRenderContext): ReactNode {
  const doc = (document as { doc?: unknown } | null)?.doc as AnyNode | undefined;
  if (typeOf(doc) !== "doc") {
    if (document !== null && document !== undefined) context.onSkip?.("document", "invalid");
    return null;
  }
  return <>{blocks(childrenOf(doc!), 0, { context, nodes: 0 })}</>;
}
