import { describe, expect, it } from "vitest";
import { MANUAL_REVISION_KINDS, NO_NOTES, restoredMessage, REVISION_KIND_WORDS } from "./revisions";

/** The history's words (M7-3, ADR 0026): what a restore says it could not bring back. */
describe("a restore's message", () => {
  it("says the revision is in the draft and that nothing is published", () => {
    expect(restoredMessage(3, NO_NOTES)).toBe("Revision 3 is in the draft now. Nothing is published until you publish it.");
  });

  it("names, one by one, what it left out or could not bring back, in the singular and the plural", () => {
    expect(restoredMessage(2, { droppedTerms: 1, missingImages: 1, missingLinks: 1, featuredImage: "unavailable" })).toBe(
      "Revision 2 is in the draft now. Nothing is published until you publish it. 1 category or tag it had no longer exists and was left out. " +
        "1 image in it is no longer in the media library: shown as unavailable, and left out of the page when it is published. Restore it from the media trash, or choose another. " +
        "1 link points to a page or post that is no longer on the site. Its featured image is in the media trash: it is not shown until it is restored.",
    );
    expect(restoredMessage(5, { droppedTerms: 2, missingImages: 3, missingLinks: 2, featuredImage: "removed" })).toBe(
      "Revision 5 is in the draft now. Nothing is published until you publish it. 2 categories or tags it had no longer exist and were left out. " +
        "3 images in it are no longer in the media library: shown as unavailable, and left out of the page when it is published. Restore them from the media trash, or choose another. " +
        "2 links point to a page or post that is no longer on the site. Its featured image has been deleted for good, so the draft has none.",
    );
  });

  it("has a word for every kind the schema allows, and caps only `save` and `restore`", () => {
    expect(Object.keys(REVISION_KIND_WORDS).sort()).toEqual(["publish", "restore", "save", "scheduled"]);
    expect(MANUAL_REVISION_KINDS).toEqual(["save", "restore"]);
  });
});
