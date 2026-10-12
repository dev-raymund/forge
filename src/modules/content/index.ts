import "server-only";

/**
 * Public server API of the content module.
 *   M5-2  the content-type registry, paths, slugs, inserting under a free slug
 *   M5-3  entries: create, save the draft, publish, the home page (ADR 0016)
 * The screens are M5-4's (editor) and M5-7's (lists, forms, sidebar).
 */
export * from "./shared";
export { ENTRY_PATH_KEY, insertWithUniqueSlug, MAX_SLUG_ATTEMPTS, SLUG_RACE_LOST } from "./unique-slug";
export type { SlugPlace } from "./unique-slug";

// Entries (M5-3).
export { createEntry, createHomePage, saveDraft } from "./entry.service";
export type { EntrySummary } from "./entry.service";
export { publishEntry } from "./publishing.service";
export type { Published } from "./publishing.service";
export { setHomepage } from "./homepage.service";
export type { MovedEntry } from "./tree";
export { canAssignTerms, canCreateEntry, canCreditOthers, canPublishEntry, canSetHomepage, canUpdateEntry } from "./policies";
export type { EntryRef } from "./policies";
export { DRAFT_FIELD_MAX, submitCreateEntry, submitPublishEntry, submitSaveDraft, submitSetHomepage } from "./entry-forms";

// The editor and its link picker (M5-4).
export { ENTRY_SEARCH_LIMIT, getEntryForEditor, searchEntries } from "./queries";
export type { EditorEntry, EntryMatch } from "./queries";
export { EntryEditorPage } from "./ui/entry-editor-page";
