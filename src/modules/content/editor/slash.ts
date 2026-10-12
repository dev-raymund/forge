import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";

/**
 * The slash menu (plan §6.3 "Insert blocks: / slash menu"; M5-4): typing `/`
 * at the start of an empty top-level paragraph offers the text blocks, and
 * what follows the slash filters them. Choosing one turns that paragraph into
 * it. Pure but for `run`, which acts on the editor.
 */

export type SlashRange = { from: number; to: number };
export type SlashCommand = { key: string; label: string; keywords: readonly string[]; run: (editor: Editor, range: SlashRange) => boolean };

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { key: "paragraph", label: "Text", keywords: ["paragraph", "text", "plain"], run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run() },
  { key: "heading-2", label: "Heading 2", keywords: ["heading", "title", "h2"], run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run() },
  { key: "heading-3", label: "Heading 3", keywords: ["heading", "subtitle", "h3"], run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run() },
  { key: "heading-4", label: "Heading 4", keywords: ["heading", "h4"], run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 4 }).run() },
  { key: "bullet-list", label: "Bulleted list", keywords: ["list", "bullets", "ul"], run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
  { key: "ordered-list", label: "Numbered list", keywords: ["list", "numbers", "ordered", "ol"], run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
  { key: "quote", label: "Quote", keywords: ["quote", "blockquote", "citation"], run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
  { key: "divider", label: "Divider", keywords: ["divider", "line", "rule", "separator", "hr"], run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
];

/** At most this many characters after the slash: past that, it is text, not a command. */
const QUERY_MAX = 24;

/**
 * The command being typed: a top-level paragraph whose whole text is `/` and a
 * few letters, with the caret at its end. The range is that text, which the
 * chosen command replaces. Anything else (a selection, a slash mid-sentence, a
 * slash inside a list or a quote) is not a command.
 */
export function slashMatch(state: EditorState): { query: string; range: SlashRange } | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if ($from.depth !== 1 || $from.parent.type.name !== "paragraph") return null;
  const text = $from.parent.textContent;
  if (!text.startsWith("/") || $from.parentOffset !== text.length) return null;
  const query = text.slice(1);
  if (query.length > QUERY_MAX || !/^[a-z0-9 ]*$/i.test(query)) return null;
  return { query, range: { from: $from.start(), to: $from.end() } };
}

/** The commands whose name or a keyword starts with, or whose name contains, the query (case-insensitive). */
export function filterCommands(query: string, commands: readonly SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...commands];
  return commands.filter(
    (command) => command.label.toLowerCase().includes(q) || command.keywords.some((keyword) => keyword.startsWith(q)) || command.key.startsWith(q),
  );
}
