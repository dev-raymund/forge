import { describe, expect, it } from "vitest";
import { roleMaySeeEntry } from "./visibility";

/**
 * M7-4: the preview renderer's question, asked of a role. That it answers as `canSeeEntry` does for a member with that
 * role, for every role, is checked on real contexts in tests/integration/content-preview.test.ts.
 */

const ME = "0192f000-0000-7000-8000-00000000000a";
const SOMEONE = "0192f000-0000-7000-8000-00000000000b";

describe("who may see an entry, asked of a role", () => {
  it("an Author sees only their own posts and no pages; a Viewer reads everything; an unknown role nothing", () => {
    expect(roleMaySeeEntry("author", ME, { type: "post", authorId: ME })).toBe(true);
    expect(roleMaySeeEntry("author", ME, { type: "post", authorId: SOMEONE })).toBe(false);
    expect(roleMaySeeEntry("author", ME, { type: "post", authorId: null })).toBe(false);
    expect(roleMaySeeEntry("author", ME, { type: "page", authorId: ME })).toBe(false);
    for (const role of ["owner", "admin", "editor", "viewer"]) {
      expect(roleMaySeeEntry(role, ME, { type: "page", authorId: SOMEONE }), role).toBe(true);
      expect(roleMaySeeEntry(role, ME, { type: "post", authorId: SOMEONE }), role).toBe(true);
    }
    expect(roleMaySeeEntry("nobody", ME, { type: "post", authorId: ME })).toBe(false);
  });
});
