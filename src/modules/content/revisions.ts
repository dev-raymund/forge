/**
 * Revisions as the history shows them (M7-3; plan §9 "Revisions", cms-architecture §15). Pure and client-safe: the
 * history dialog and the services share the words.
 *
 *   save        "Save" in the editor; or the draft as it was, kept before an overwrite or a restore replaced it
 *   publish     what Publish made live (kept forever)
 *   scheduled   a draft frozen for a schedule (M7-2; kept forever: it may be, or have been, the live one)
 *   restore     the draft after an earlier revision was copied into it
 *
 * `save` and `restore` are the manual revisions the plan caps per entry (Free 20, Pro 100: plan §14); the oldest go
 * first. `publish` and `scheduled` revisions are always kept.
 */

export const REVISION_KIND_WORDS = { save: "Saved", publish: "Published", scheduled: "Scheduled", restore: "Restored" } as const;
export type RevisionKind = keyof typeof REVISION_KIND_WORDS;

/** The kinds the plan's limit applies to, oldest pruned first. */
export const MANUAL_REVISION_KINDS = ["save", "restore"] as const satisfies readonly RevisionKind[];

/** A label someone gives a saved version ("Before the redesign"). */
export const REVISION_LABEL_MAX = 100;

/** What a restore had to leave out or could not bring back, for the person who restored it. */
export type RestoreNotes = {
  /** Categories and tags it had that are no longer terms of the site: left out (M5-8). */
  droppedTerms: number;
  /** Image blocks whose image is no longer usable (trashed, or deleted): kept, shown as unavailable, left out of the page. */
  missingImages: number;
  /** Links to pages or posts that are no longer on the site (trashed, or deleted). */
  missingLinks: number;
  /** Its featured image: in the media trash (kept, not shown), or deleted for good (removed from the draft). */
  featuredImage: "ok" | "unavailable" | "removed";
};

export const NO_NOTES: RestoreNotes = { droppedTerms: 0, missingImages: 0, missingLinks: 0, featuredImage: "ok" };

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Revision 3 is in the draft now. …" with what it could not bring back, and that nothing was published. */
export function restoredMessage(number: number, notes: RestoreNotes): string {
  const lines = [`Revision ${number} is in the draft now. Nothing is published until you publish it.`];
  if (notes.droppedTerms) {
    lines.push(`${count(notes.droppedTerms, "category or tag it had no longer exists and was", "categories or tags it had no longer exist and were")} left out.`);
  }
  if (notes.missingImages) {
    lines.push(
      `${count(notes.missingImages, "image in it is", "images in it are")} no longer in the media library: shown as unavailable, and left out of the page when it is published. Restore ${notes.missingImages === 1 ? "it" : "them"} from the media trash, or choose another.`,
    );
  }
  if (notes.missingLinks) lines.push(`${count(notes.missingLinks, "link points", "links point")} to a page or post that is no longer on the site.`);
  if (notes.featuredImage === "unavailable") lines.push("Its featured image is in the media trash: it is not shown until it is restored.");
  if (notes.featuredImage === "removed") lines.push("Its featured image has been deleted for good, so the draft has none.");
  return lines.join(" ");
}
