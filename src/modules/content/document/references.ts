import { entryIdOf } from "@/blocks/links";

/**
 * What a stored document points at (M5-5): the media its images show, the
 * entries its links and buttons go to (`entry:{id}`), and the pages its
 * generic embeds frame. Pure; reads any shape without trusting it. The server
 * checks these against the site (../references.ts).
 */
export type DocumentReferences = { mediaIds: Set<string>; entryIds: Set<string>; embeds: { provider: string; url: string }[] };

export function referencesOf(document: unknown): DocumentReferences {
  const refs: DocumentReferences = { mediaIds: new Set(), entryIds: new Set(), embeds: [] };
  const link = (href: unknown) => {
    const id = typeof href === "string" ? entryIdOf(href) : null;
    if (id) refs.entryIds.add(id);
  };
  const stack: unknown[] = [(document as { doc?: unknown } | null)?.doc];
  while (stack.length) {
    const node = stack.pop() as { type?: unknown; attrs?: Record<string, unknown>; marks?: unknown; content?: unknown } | null;
    if (!node || typeof node !== "object") continue;
    const attrs = node.attrs ?? {};
    if (node.type === "image" && typeof attrs.mediaId === "string") refs.mediaIds.add(attrs.mediaId.toLowerCase());
    if (node.type === "image") link(attrs.link);
    if (node.type === "button") link(attrs.href);
    if (node.type === "embed" && typeof attrs.url === "string") refs.embeds.push({ provider: String(attrs.provider), url: attrs.url });
    if (Array.isArray(node.marks)) for (const mark of node.marks as { type?: unknown; attrs?: { href?: unknown } }[]) if (mark?.type === "link") link(mark.attrs?.href);
    if (Array.isArray(node.content)) stack.push(...node.content);
  }
  return refs;
}
