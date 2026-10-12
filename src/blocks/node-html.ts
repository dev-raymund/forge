import { mergeAttributes, Node } from "@tiptap/core";
import type { Attrs } from "./define";

/**
 * How a custom block lives in the editor's HTML (copy and paste inside the
 * editor): a `div[data-forge-node]` whose attributes travel as `data-*` JSON.
 * Only this serialization parses back, so pasted foreign HTML never becomes a
 * custom block, and what does parse is checked by the paste guard (./paste-guard.ts).
 */
export function dataAttrs(defaults: Attrs) {
  return Object.fromEntries(
    Object.entries(defaults).map(([name, fallback]) => [
      name,
      {
        default: fallback ?? null,
        parseHTML: (element: HTMLElement) => {
          const raw = element.getAttribute(`data-${name.toLowerCase()}`);
          if (raw === null) return fallback ?? null;
          try {
            return JSON.parse(raw);
          } catch {
            return raw;
          }
        },
        renderHTML: (attributes: Attrs) =>
          attributes[name] === null || attributes[name] === undefined ? {} : { [`data-${name.toLowerCase()}`]: JSON.stringify(attributes[name]) },
      },
    ]),
  );
}

/** An atom block (no editable content of its own): selected and edited as a whole, through the properties panel. */
export function atomBlock(name: string, defaults: Attrs) {
  return Node.create({
    name,
    group: "block",
    atom: true,
    draggable: true,
    selectable: true,
    addAttributes: () => dataAttrs(defaults),
    parseHTML: () => [{ tag: `div[data-forge-node="${name}"]` }],
    renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-forge-node": name })],
  });
}
