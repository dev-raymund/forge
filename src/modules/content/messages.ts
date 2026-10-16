/**
 * What the entry services answer with, where the editor must recognise the
 * answer and not only show it (M5-4): the two version conflicts. Pure and
 * client-safe; the services throw `conflict(…)` with exactly these.
 */
export const DRAFT_CHANGED = "This draft was changed somewhere else (another tab, or someone else). Reload it to see the latest version.";
export const NEWER_SAVE = "The draft has changed since this was opened. Reload it, check the latest version, and publish again.";
/**
 * M7-3: an overwrite of a draft that was saved again after the conflict dialog said who had saved it. Never overwritten
 * unseen: the dialog shows the newer save, and the person decides again.
 */
export const CHANGED_AGAIN = "The draft was saved again while you were deciding. Check who saved it, then overwrite again if you still want to.";
/** M7-3: a restore or a save to the history from a draft that is no longer the one this screen holds. */
export const NOT_THE_LATEST = "The draft has changed since this was opened (another tab, or someone else). Reload it to see the latest version, then try again.";
