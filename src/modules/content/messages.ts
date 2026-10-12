/**
 * What the entry services answer with, where the editor must recognise the
 * answer and not only show it (M5-4): the two version conflicts. Pure and
 * client-safe; the services throw `conflict(…)` with exactly these.
 */
export const DRAFT_CHANGED = "This draft was changed somewhere else (another tab, or someone else). Reload it to see the latest version.";
export const NEWER_SAVE = "The draft has changed since this was opened. Reload it, check the latest version, and publish again.";
