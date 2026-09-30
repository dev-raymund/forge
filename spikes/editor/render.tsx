import { Fragment, type ReactNode } from "react";
import { attrs as attrSchemas, embedSrc, isSafeHref, markSchema, type Mark } from "./schema";

/**
 * Closed node → React renderer (plan §6.2, D-38). It emits only the elements
 * listed in RENDERED_ELEMENTS, never raw HTML, and never uses
 * `dangerouslySetInnerHTML`. Every node's attrs are re-validated here, so
 * even a document that skipped save-time validation renders safely: unknown
 * or invalid nodes render nothing and are reported through `onSkip`.
 */

export const RENDERED_ELEMENTS = [
  "p", "h2", "h3", "h4", "strong", "em", "u", "s", "code", "a", "blockquote", "cite",
  "ul", "ol", "li", "hr", "figure", "img", "figcaption", "div", "iframe",
] as const;

export type MediaRef = { src: string; srcSet?: string; width: number; height: number; alt: string };

export type RenderContext = {
  /** Resolves an image's media id to its variants (M6); missing → the image is skipped. */
  resolveMedia: (mediaId: string) => MediaRef | undefined;
  /** Resolves `entry:{id}` links to the entry's live path; missing → plain text. */
  resolveEntryHref: (entryId: string) => string | undefined;
  onSkip?: (type: string, reason: string) => void;
};

type AnyNode = { type?: unknown; attrs?: unknown; content?: unknown; text?: unknown; marks?: unknown };

function resolveHref(href: string, ctx: RenderContext): string | undefined {
  if (!isSafeHref(href)) return undefined;
  if (href.startsWith("entry:")) return ctx.resolveEntryHref(href.slice("entry:".length));
  return href;
}

function renderText(node: AnyNode, key: number, ctx: RenderContext): ReactNode {
  if (typeof node.text !== "string") return null;
  const marks = (Array.isArray(node.marks) ? node.marks : [])
    .map((m) => markSchema.safeParse(m))
    .filter((r) => r.success)
    .map((r) => r.data as Mark);
  // Link outermost, then the formatting marks.
  const ordered = [...marks.filter((m) => m.type !== "link"), ...marks.filter((m) => m.type === "link")];
  let out: ReactNode = node.text;
  for (const mark of ordered) {
    switch (mark.type) {
      case "bold": out = <strong>{out}</strong>; break;
      case "italic": out = <em>{out}</em>; break;
      case "underline": out = <u>{out}</u>; break;
      case "strike": out = <s>{out}</s>; break;
      case "code": out = <code>{out}</code>; break;
      case "link": {
        const href = resolveHref(mark.attrs.href, ctx);
        if (href) out = <a href={href}>{out}</a>;
        break;
      }
    }
  }
  return <Fragment key={key}>{out}</Fragment>;
}

function children(node: AnyNode, ctx: RenderContext, inlineOnly = false): ReactNode[] {
  if (!Array.isArray(node.content)) return [];
  return node.content.map((child: AnyNode, i: number) =>
    child?.type === "text" ? renderText(child, i, ctx) : inlineOnly ? null : renderNode(child, i, ctx),
  );
}

function parseAttrs<K extends keyof typeof attrSchemas>(type: K, node: AnyNode, ctx: RenderContext) {
  const result = attrSchemas[type].safeParse(node.attrs ?? {});
  if (!result.success) ctx.onSkip?.(type, "invalid attrs");
  return result.success ? (result.data as never) : null;
}

export function renderNode(node: AnyNode, key: number, ctx: RenderContext): ReactNode {
  const type = typeof node?.type === "string" ? node.type : "?";
  switch (type) {
    case "paragraph":
      return parseAttrs("paragraph", node, ctx) && <p key={key}>{children(node, ctx, true)}</p>;
    case "heading": {
      const a = parseAttrs("heading", node, ctx) as { level: 2 | 3 | 4 } | null;
      if (!a) return null;
      const H = `h${a.level}` as const;
      return <H key={key}>{children(node, ctx, true)}</H>;
    }
    case "blockquote": {
      const a = parseAttrs("blockquote", node, ctx) as { cite: string | null } | null;
      if (!a) return null;
      return (
        <blockquote key={key}>
          {children(node, ctx)}
          {a.cite ? <cite>{a.cite}</cite> : null}
        </blockquote>
      );
    }
    case "bulletList":
    case "orderedList": {
      const a = parseAttrs(type, node, ctx) as { start?: number } | null;
      if (!a) return null;
      const items = (Array.isArray(node.content) ? node.content : []).map((li: AnyNode, i: number) =>
        li?.type === "listItem" ? <li key={i}>{children(li, ctx)}</li> : null,
      );
      return type === "bulletList" ? <ul key={key}>{items}</ul> : <ol key={key} start={a.start}>{items}</ol>;
    }
    case "horizontalRule": {
      const a = parseAttrs("horizontalRule", node, ctx) as { style: string } | null;
      return a && <hr key={key} className={`forge-divider forge-divider--${a.style}`} />;
    }
    case "image": {
      const a = parseAttrs("image", node, ctx) as {
        mediaId: string; alt: string | null; caption: string | null; size: string; link: string | null;
      } | null;
      if (!a) return null;
      const media = ctx.resolveMedia(a.mediaId);
      if (!media) {
        ctx.onSkip?.("image", "media not found");
        return null;
      }
      const img = (
        // Plan §6.1/D-17: srcset from pre-generated variants, not next/image.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={media.src} srcSet={media.srcSet} width={media.width} height={media.height}
          alt={a.alt ?? media.alt} loading="lazy" decoding="async" />
      );
      const href = a.link ? resolveHref(a.link, ctx) : undefined;
      return (
        <figure key={key} className={`forge-image forge-image--${a.size}`}>
          {href ? <a href={href}>{img}</a> : img}
          {a.caption ? <figcaption>{a.caption}</figcaption> : null}
        </figure>
      );
    }
    case "button": {
      const a = parseAttrs("button", node, ctx) as {
        label: string; href: string; style: string; align: string; newTab: boolean;
      } | null;
      const href = a && resolveHref(a.href, ctx);
      if (!a || !href) return null;
      return (
        <div key={key} className={`forge-button-row forge-button-row--${a.align}`}>
          <a href={href} className={`forge-button forge-button--${a.style}`}
            {...(a.newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
            {a.label}
          </a>
        </div>
      );
    }
    case "columns": {
      const a = parseAttrs("columns", node, ctx) as { count: number; ratio: string; stackOnMobile: boolean } | null;
      const cols = Array.isArray(node.content) ? (node.content as AnyNode[]) : [];
      if (!a || cols.length !== a.count || cols.some((c) => c?.type !== "column")) return null;
      return (
        <div key={key} className={`forge-columns${a.stackOnMobile ? " forge-columns--stack" : ""}`}
          style={{ gridTemplateColumns: a.ratio.split(":").map((n) => `${Number(n)}fr`).join(" ") }}>
          {cols.map((col, i) => (
            <div key={i} className="forge-column">
              {/* Nested columns are unrepresentable in the editor; never render them either. */}
              {children({ content: (col.content as AnyNode[] | undefined)?.filter((c) => c?.type !== "columns") }, ctx)}
            </div>
          ))}
        </div>
      );
    }
    case "embed": {
      const a = parseAttrs("embed", node, ctx) as { provider: string; url: string; aspect: string } | null;
      const src = a && embedSrc(a.provider, a.url);
      if (!a || !src) return null;
      return (
        <div key={key} className={`forge-embed forge-embed--${a.aspect.replace(":", "-")}`}>
          <iframe src={src} title={`${a.provider} video`} loading="lazy" allowFullScreen
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
            allow="encrypted-media; fullscreen; picture-in-picture"
            referrerPolicy="strict-origin-when-cross-origin" />
        </div>
      );
    }
    case "spacer": {
      const a = parseAttrs("spacer", node, ctx) as { size: string } | null;
      return a && <div key={key} className={`forge-spacer forge-spacer--${a.size}`} aria-hidden="true" />;
    }
    default:
      ctx.onSkip?.(type, "unknown node");
      return null;
  }
}

/** Renders a stored `{ v, doc }` document (or anything else, safely). */
export function renderDocument(stored: unknown, ctx: RenderContext): ReactNode {
  const doc = (stored as { doc?: AnyNode } | null)?.doc;
  if (doc?.type !== "doc" || !Array.isArray(doc.content)) return null;
  return <>{doc.content.map((n: AnyNode, i: number) => renderNode(n, i, ctx))}</>;
}
