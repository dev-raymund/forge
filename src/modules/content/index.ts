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
export { changeAuthor, createEntry, createHomePage, saveDraft } from "./entry.service";
export type { EntrySummary } from "./entry.service";
export { publishEntry } from "./publishing.service";
export type { Published } from "./publishing.service";
export { setHomepage } from "./homepage.service";
export { movePage, placePage } from "./tree.service";
// The lifecycle (M7-1, ADR 0024): unpublish, the trash, restore, purge, and the daily `trash.purge` job.
export { ENTRY_TRASH_DAYS, LIFECYCLE_ACTIONS, stateOf, transition } from "./lifecycle";
export type { LifecycleAction, LifecycleState, Transition } from "./lifecycle";
export { purgeEntry, restoreEntry, trashEntry, unpublishEntry } from "./lifecycle.service";
export type { Purged, Restored, Trashed, Unpublished } from "./lifecycle.service";
export { purgeTrashedEntries, trashPurge } from "./purge";
export type { EntryPurgeResult } from "./purge";
// Categories and tags (M5-8).
export { createTerm, deleteTerm, listTermsWithUsage, updateTerm } from "./term.service";
export type { TermSummary } from "./term.service";
export type { TermWithUsage } from "./term.repository";
export { submitCreateTerm, submitDeleteTerm, submitUpdateTerm } from "./term-forms";
export type { MovedEntry } from "./tree";
export {
  canArrangePage, canAssignTerms, canChangeAuthor, canCreateEntry, canCreateTerm, canCreditOthers, canManageTerms, canPublishEntry, canPurgeEntry, canSeeEntry, canSeePages,
  canSetHomepage, canTransition, canTrashEntry, canUpdateEntry, ownPostsOnly,
} from "./policies";
export type { EntryRef } from "./policies";
export {
  DRAFT_FIELD_MAX, submitChangeAuthor, submitCreateEntry, submitMovePage, submitPlacePage, submitPublishEntry, submitPurgeEntry, submitRestoreEntry, submitSaveDraft,
  submitSetHomepage, submitTrashEntry, submitUnpublishEntry,
} from "./entry-forms";

// The editor and its link picker (M5-4).
export { ENTRY_SEARCH_LIMIT, getEntryForEditor, listPages, listPosts, listTerms, PAGE_TREE_LIMIT, searchEntries } from "./queries";
export type { EditorEntry, EntryMatch, PageListItem, PostList, PostListItem, TermOption } from "./queries";
export { EntryEditorPage } from "./ui/entry-editor-page";
// The lists and the new forms (M5-7).
export { NewEntryForm } from "./ui/new-entry-form";
export { PagesView } from "./ui/pages-view";
export { PostsView } from "./ui/posts-view";
export { TermsView } from "./ui/terms-view";
