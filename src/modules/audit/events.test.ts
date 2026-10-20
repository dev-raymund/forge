import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS, AUDIT_EVENTS, AuditEventError, describeEvent, eventLabel, isAuditAction, sanitizeMetadata, withoutSecrets, type AuditAction,
} from "./events";

/** One valid set of details per event: what a service would hand the writer. */
const SAMPLES: { [A in AuditAction]: Record<string, unknown> } = {
  "organization.created": { name: "Acme Studio", slug: "acme-studio" },
  "organization.updated": { previousName: "Acme", newName: "Acme Studio" },
  "organization.ownership_transferred": { newOwnerName: "Jane Doe" },
  "member.invited": { email: "john@example.com", role: "author" },
  "invitation.resent": { email: "john@example.com" },
  "invitation.revoked": { email: "john@example.com" },
  "invitation.accepted": { role: "editor" },
  "member.role_changed": { memberName: "Jane Doe", previousRole: "author", newRole: "editor" },
  "member.removed": { memberName: "Jane Doe", role: "viewer" },
  "member.left": { role: "admin" },
  "site.created": { name: "Acme Bakery", address: "acme" },
  "site.address_changed": { name: "Acme Bakery", previousAddress: "acme", newAddress: "acme-bakery" },
  "site.deleted": { name: "Acme Bakery", address: "acme-bakery" },
  "site.theme_changed": { name: "Acme Bakery", previousTheme: "studio", newTheme: "journal" },
  "site.settings_changed": { name: "Acme Bakery", group: "general", fields: ["tagline", "timezone"] },
  "site.status_changed": { name: "Acme Bakery", previousStatus: "coming_soon", newStatus: "live" },
  "entry.created": { type: "page", title: "About us", path: "/about-us" },
  "entry.published": { type: "post", title: "Hello", path: "/blog/hello", revision: 1 },
  "site.homepage_changed": { name: "Acme Bakery", title: "Welcome", previousTitle: "Home" },
  "entry.moved": { type: "page", title: "Team", parentTitle: "About us", from: "/team", to: "/about-us/team" },
  "entry.reordered": { type: "page", title: "Team", position: 2, of: 3 },
  "entry.author_changed": { type: "post", title: "Hello", authorName: "Jane Doe", previousAuthorName: "John Doe" },
  "entry.unpublished": { type: "post", title: "Hello", path: "/blog/hello" },
  "entry.trashed": { type: "page", title: "About us", path: "/about-us", below: 2 },
  "entry.restored": { type: "page", title: "About us", path: "/about-us", below: 2 },
  "entry.deleted": { type: "post", title: "Hello", path: "/blog/hello", below: 0 },
  "entry.scheduled": { type: "post", title: "Hello", path: "/blog/hello", runAt: "2026-10-20T01:30:00.000Z" },
  "entry.schedule_canceled": { type: "post", title: "Hello", path: "/blog/hello", runAt: "2026-10-20T01:30:00.000Z" },
  "entry.schedule_failed": { type: "page", title: "About", path: "/about", runAt: "2026-10-20T01:30:00.000Z", reason: "The address /about is already used by another page or post." },
  "entry.revision_restored": { type: "post", title: "Rye season", path: "/blog/rye-season", revision: 3 },
  "entry.draft_replaced": { type: "page", title: "About", path: "/about", keptRevision: 7 },
  "term.created": { taxonomy: "category", name: "Bread", slug: "bread" },
  "menu.updated": { name: "Acme Bakery", location: "header", items: 5 },
  "term.updated": { taxonomy: "tag", name: "Sourdough", slug: "sourdough", fields: ["name", "slug"], previousName: "Rye", previousSlug: "rye" },
  "term.deleted": { taxonomy: "category", name: "Bread", slug: "bread", posts: 3, drafts: 1 },
  "media.uploaded": { kind: "image", filename: "Team photo.jpg", sizeBytes: 482_113 },
  "media.updated": { kind: "image", filename: "Team photo.jpg", fields: ["title", "alt"] },
  "media.moved": { kind: "document", filename: "Menu.pdf", folderName: "Menus", previousFolderName: "Old" },
  "media.trashed": { kind: "image", filename: "Team photo.jpg" },
  "media.restored": { kind: "image", filename: "Team photo.jpg" },
  "media.folder_created": { name: "Events" },
  "media.folder_renamed": { name: "Events 2026", previousName: "Events" },
  "media.folder_deleted": { name: "Events 2026" },
};

describe("the audit vocabulary", () => {
  it("is the ten events of M3, the three of M4-1, the one of M4-4, the one of M4-2, the one of M4-5, the three of M5-3, the three of M5-7, the three of M5-8, the one of M6-1, the seven of M6-3, the four of M7-1, the three of M7-2 and the two of M7-3, each named `resource.verb` in the past tense", () => {
    expect([...AUDIT_ACTIONS].sort()).toEqual(
      [
        "organization.created", "organization.updated", "organization.ownership_transferred",
        "member.invited", "invitation.resent", "invitation.revoked", "invitation.accepted",
        "member.role_changed", "member.removed", "member.left",
        "site.created", "site.address_changed", "site.deleted", "site.theme_changed", "site.settings_changed", "site.status_changed",
        "entry.created", "entry.published", "site.homepage_changed",
        "entry.moved", "entry.reordered", "entry.author_changed",
        "entry.unpublished", "entry.trashed", "entry.restored", "entry.deleted",
        "entry.scheduled", "entry.schedule_canceled", "entry.schedule_failed", "entry.revision_restored", "entry.draft_replaced",
        "term.created", "term.updated", "term.deleted",
        "menu.updated",
        "media.uploaded",
        "media.updated", "media.moved", "media.trashed", "media.restored", "media.folder_created", "media.folder_renamed", "media.folder_deleted",
      ].sort(),
    );
    for (const action of AUDIT_ACTIONS) expect(action, action).toMatch(/^[a-z]+\.[a-z_]+(ed|ent|eft)$/);
  });

  it("every event is about an organization, a membership, an invitation, a site, an entry, a term, a menu, a media item or a media folder, and has a name for the filter list", () => {
    for (const action of AUDIT_ACTIONS) {
      expect(["organization", "membership", "invitation", "site", "entry", "term", "menu", "media", "media_folder"], action).toContain(AUDIT_EVENTS[action].resourceType);
      expect(eventLabel(action), action).toMatch(/^[A-Z][a-z]+( [a-z]+)*$/);
    }
    expect(new Set(AUDIT_ACTIONS.map(eventLabel)).size).toBe(AUDIT_ACTIONS.length);
    expect(eventLabel("entry.archived")).toBe("entry.archived"); // an event from elsewhere keeps its own name
  });

  it("knows an event from something that is not one", () => {
    for (const action of AUDIT_ACTIONS) expect(isAuditAction(action)).toBe(true);
    for (const junk of ["", "member", "member.", "MEMBER.INVITED", "member.invited ", "entry.archived", "toString", "__proto__", "constructor", null, undefined, 1, {}, ["member.invited"]]) {
      expect(isAuditAction(junk), String(junk)).toBe(false);
    }
  });
});

describe("what is stored with an event", () => {
  it.each(AUDIT_ACTIONS)("%s: the details it names, as given", (action) => {
    expect(sanitizeMetadata(action, SAMPLES[action])).toEqual(SAMPLES[action]);
  });

  it("nothing the event does not name: other keys are left out", () => {
    const stored = sanitizeMetadata("member.role_changed", { ...SAMPLES["member.role_changed"], organizationId: "x", userId: "y", note: "z", row: { everything: true } });
    expect(stored).toEqual(SAMPLES["member.role_changed"]);
  });

  it("never anything named like a secret, at any depth, whatever the event", () => {
    const secrets = {
      token: "t", invitationToken: "t", tokenHash: "h", token_hash: "h", password: "p", newPassword: "p", passwordHash: "h", secret: "s", clientSecret: "s",
      apiKey: "k", api_key: "k", "api-key": "k", authorization: "Bearer x", cookie: "c", sessionId: "s", session_token: "s", credential: "c", hash: "h",
    };
    for (const action of AUDIT_ACTIONS) {
      const stored = sanitizeMetadata(action, { ...SAMPLES[action], ...secrets, nested: { ...secrets, fine: 1 } });
      expect(stored, action).toEqual(SAMPLES[action]);
      expect(JSON.stringify(stored)).not.toMatch(/token|password|secret|hash|cookie|session|authorization|credential/i);
    }
    expect(withoutSecrets({ a: 1, token: "x", deep: { password: "y", ok: [{ secret: "z", kept: true }] } })).toEqual({ a: 1, deep: { ok: [{ kept: true }] } });
    expect(withoutSecrets(null)).toBeNull();
    expect(withoutSecrets("a string is not searched")).toBe("a string is not searched");
  });

  it("trims what it stores and leaves out what was optional and absent", () => {
    expect(sanitizeMetadata("organization.created", { name: "  Acme  ", slug: " acme " })).toEqual({ name: "Acme", slug: "acme" });
    expect(sanitizeMetadata("organization.updated", { previousSlug: "old", newSlug: "new", previousName: undefined })).toEqual({ previousSlug: "old", newSlug: "new" });
    expect(sanitizeMetadata("invitation.accepted", { role: "viewer", alreadyMember: true })).toEqual({ role: "viewer", alreadyMember: true });
    expect(Object.keys(sanitizeMetadata("invitation.accepted", { role: "viewer" }))).toEqual(["role"]);
  });

  it("refuses an event whose details are missing, malformed or too long", () => {
    const invalid: [AuditAction, unknown][] = [
      ["organization.created", { name: "Acme" }],
      ["organization.created", { name: "", slug: "acme" }],
      ["organization.created", { name: "x".repeat(201), slug: "acme" }],
      ["organization.updated", {}],
      ["organization.updated", { previousName: "only half" }],
      ["organization.updated", { newSlug: "only-half" }],
      ["member.invited", { email: "john@example.com" }],
      ["member.invited", { email: "john@example.com", role: "Not A Role" }],
      ["member.invited", { email: "x".repeat(255), role: "viewer" }],
      ["member.role_changed", { memberName: "Jane", previousRole: "editor" }],
      ["member.role_changed", { memberName: { first: "Jane" }, previousRole: "editor", newRole: "author" }],
      ["invitation.accepted", { role: "viewer", alreadyMember: false }],
      ["member.left", null],
      ["member.left", "viewer"],
      ["member.left", []],
      ["site.status_changed", { name: "Acme", previousStatus: "coming_soon", newStatus: "suspended" }],
      ["site.status_changed", { name: "Acme", previousStatus: "draft", newStatus: "live" }],
      ["site.status_changed", { name: "Acme", previousStatus: "suspended", newStatus: "live" }],
      ["site.status_changed", { name: "Acme", previousStatus: "live" }],
      ["entry.created", { type: "product", title: "X", path: "/x" }],
      ["entry.created", { type: "page", title: "", path: "/x" }],
      ["entry.created", { type: "page", title: "X", path: "/x/" }],
      ["entry.created", { type: "page", title: "X", path: "javascript:alert(1)" }],
      ["entry.published", { type: "post", title: "X", path: "/blog/x", revision: 0 }],
      ["entry.published", { type: "post", title: "X", path: "/blog/x" }],
      ["site.homepage_changed", { name: "Acme" }],
      ["entry.moved", { type: "page", title: "X", from: "/x", to: "../x" }],
      ["entry.moved", { type: "page", title: "X", from: "/x" }],
      ["entry.reordered", { type: "page", title: "X", position: 0, of: 1 }],
      ["entry.author_changed", { type: "post", title: "X" }],
      ["entry.unpublished", { type: "post", title: "X" }],
      ["entry.trashed", { type: "page", title: "X", path: "/x", below: -1 }],
      ["entry.restored", { type: "page", title: "X", path: "/x" }],
      ["entry.deleted", { type: "custom", title: "X", path: "/x", below: 0 }],
      ["entry.deleted", { type: "post", title: "X", path: "/x", below: 0, afterDays: 0 }],
      ["entry.scheduled", { type: "post", title: "X", path: "/x", runAt: "tomorrow" }],
      ["entry.schedule_canceled", { type: "post", title: "X", path: "/x" }],
      ["entry.schedule_failed", { type: "post", title: "X", path: "/x", runAt: "2026-10-20T01:30:00.000Z", reason: "" }],
      ["entry.revision_restored", { type: "post", title: "X", path: "/x", revision: 0 }],
      ["entry.draft_replaced", { type: "post", title: "X", path: "/x", keptRevision: "7" }],
      ["entry.published", { type: "post", title: "X", path: "/x", revision: 1, scheduled: false }],
      ["term.created", { taxonomy: "section", name: "X", slug: "x" }],
      ["term.created", { taxonomy: "tag", name: "X", slug: "X Y" }],
      ["term.updated", { taxonomy: "tag", name: "X", slug: "x", fields: [] }],
      ["term.updated", { taxonomy: "tag", name: "X", slug: "x", fields: ["colour"] }],
      ["term.deleted", { taxonomy: "tag", name: "X", slug: "x", posts: -1, drafts: 0 }],
      ["media.uploaded", { kind: "video", filename: "x.mp4", sizeBytes: 1 }],
      ["media.uploaded", { kind: "image", filename: "", sizeBytes: 1 }],
      ["media.uploaded", { kind: "image", filename: "x.png", sizeBytes: 0 }],
      ["media.updated", { kind: "image", filename: "x.png", fields: [] }],
      ["media.updated", { kind: "image", filename: "x.png", fields: ["filename"] }],
      ["media.moved", { kind: "video", filename: "x.mp4" }],
      ["media.folder_renamed", { name: "New" }],
      ["media.folder_created", { name: "" }],
    ];
    for (const [action, metadata] of invalid) expect(() => sanitizeMetadata(action, metadata), `${action} ${JSON.stringify(metadata)}`).toThrow(AuditEventError);
  });

  it("refuses an event that is not in the vocabulary, including names an object would answer to", () => {
    for (const action of ["member.promoted", "entry.archived", "", "toString", "__proto__", "constructor", "hasOwnProperty", null, undefined, 7]) {
      expect(() => sanitizeMetadata(action, {}), String(action)).toThrow(/is not an audit event/);
    }
  });
});

describe("an event as a sentence", () => {
  const say = (action: string, metadata: unknown, actorName = "Raymund") => describeEvent({ action, actorName, metadata });

  it("says who did what, in words", () => {
    expect(say("organization.created", { name: "Acme Studio", slug: "acme-studio" })).toBe("Raymund created the organization Acme Studio.");
    expect(say("organization.updated", { previousName: "Acme", newName: "Acme Studio" })).toBe("Raymund renamed the organization from “Acme” to “Acme Studio”.");
    expect(say("organization.updated", { previousSlug: "acme", newSlug: "acme-studio" })).toBe("Raymund changed the organization’s URL from /acme to /acme-studio.");
    expect(say("organization.updated", { previousName: "Acme", newName: "Acme Studio", previousSlug: "acme", newSlug: "acme-studio" })).toBe(
      "Raymund renamed the organization from “Acme” to “Acme Studio” and changed the organization’s URL from /acme to /acme-studio.",
    );
    expect(say("organization.ownership_transferred", { newOwnerName: "Jane" })).toBe("Raymund transferred ownership to Jane.");
    expect(say("member.invited", { email: "john@example.com", role: "author" })).toBe("Raymund invited john@example.com as an Author.");
    expect(say("member.invited", { email: "john@example.com", role: "viewer" })).toBe("Raymund invited john@example.com as a Viewer.");
    expect(say("invitation.resent", { email: "john@example.com" })).toBe("Raymund sent the invitation to john@example.com again.");
    expect(say("invitation.revoked", { email: "john@example.com" })).toBe("Raymund revoked the invitation to john@example.com.");
    expect(say("invitation.accepted", { role: "editor" }, "John")).toBe("John accepted an invitation and joined as an Editor.");
    expect(say("invitation.accepted", { role: "viewer", alreadyMember: true }, "John")).toBe("John accepted an invitation, and was already a member.");
    expect(say("member.role_changed", { memberName: "Jane", previousRole: "author", newRole: "editor" })).toBe("Raymund changed Jane’s role from Author to Editor.");
    expect(say("member.removed", { memberName: "Jane", role: "viewer" })).toBe("Raymund removed Jane from the organization.");
    expect(say("member.left", { role: "admin" }, "Jane")).toBe("Jane left the organization.");
    expect(say("site.created", { name: "Acme Bakery", address: "acme" })).toBe("Raymund created the site Acme Bakery at /s/acme.");
    expect(say("site.address_changed", { name: "Acme Bakery", previousAddress: "acme", newAddress: "acme-bakery" })).toBe(
      "Raymund moved the site Acme Bakery from /s/acme to /s/acme-bakery.",
    );
    expect(say("site.deleted", { name: "Acme Bakery", address: "acme-bakery" })).toBe("Raymund deleted the site Acme Bakery, which was at /s/acme-bakery.");
    expect(say("site.theme_changed", { name: "Acme Bakery", previousTheme: "studio", newTheme: "journal" })).toBe(
      "Raymund changed the theme of Acme Bakery from Studio to Journal.",
    );
    expect(say("site.settings_changed", { name: "Acme Bakery", group: "general", fields: ["name", "tagline", "instagram"] })).toBe(
      "Raymund changed the general settings of Acme Bakery: name, tagline, Instagram.",
    );
    expect(say("site.settings_changed", { name: "Acme Bakery", group: "reading", fields: ["blogPath", "postsPerPage"] })).toBe(
      "Raymund changed the reading settings of Acme Bakery: blog path, posts per page.",
    );
    expect(say("site.settings_changed", { name: "Acme Bakery", group: "analytics", fields: ["ga4MeasurementId"] })).toBe(
      "Raymund changed the analytics settings of Acme Bakery: GA4 measurement ID.",
    );
    expect(say("site.settings_changed", { name: "Acme Bakery", group: "images", fields: ["logo"] })).toBe("Raymund changed the image settings of Acme Bakery: logo.");
    expect(say("site.settings_changed", { name: "Acme Bakery", group: "images", fields: ["favicon"] })).toBe("Raymund changed the image settings of Acme Bakery: favicon.");
    expect(say("site.status_changed", { name: "Acme Bakery", previousStatus: "coming_soon", newStatus: "live" })).toBe("Raymund published the site Acme Bakery.");
    expect(say("site.status_changed", { name: "Acme Bakery", previousStatus: "live", newStatus: "coming_soon" })).toBe(
      "Raymund switched the site Acme Bakery back to Coming soon.",
    );
    expect(say("entry.created", { type: "page", title: "About us", path: "/about-us" })).toBe("Raymund created the page About us at /about-us.");
    expect(say("entry.published", { type: "post", title: "Hello", path: "/blog/hello", revision: 3 })).toBe("Raymund published the post Hello at /blog/hello.");
    expect(say("entry.published", { type: "page", title: "Home", path: "/", revision: 1 })).toBe("Raymund published the page Home at /.");
    expect(say("site.homepage_changed", { name: "Acme Bakery", title: "Welcome", previousTitle: "Home" })).toBe(
      "Raymund made Welcome the home page of Acme Bakery, in place of Home.",
    );
    expect(say("site.homepage_changed", { name: "Acme Bakery", title: "Welcome" })).toBe("Raymund made Welcome the home page of Acme Bakery.");
    expect(say("entry.moved", { type: "page", title: "Team", parentTitle: "About us", from: "/team", to: "/about-us/team" })).toBe(
      "Raymund moved the page Team under About us, from /team to /about-us/team.",
    );
    expect(say("entry.moved", { type: "page", title: "Team", from: "/about-us/team", to: "/team" })).toBe("Raymund moved the page Team to the top level, from /about-us/team to /team.");
    expect(say("entry.moved", { type: "page", title: "Home", parentTitle: "About us", from: "/", to: "/" })).toBe("Raymund moved the page Home under About us.");
    expect(say("entry.reordered", { type: "page", title: "Team", position: 1, of: 4 })).toBe("Raymund moved the page Team to position 1 of 4.");
    expect(say("entry.author_changed", { type: "post", title: "Hello", authorName: "Jane Doe" })).toBe("Raymund made Jane Doe the author of the post Hello.");
    expect(say("entry.unpublished", { type: "post", title: "Hello", path: "/blog/hello" })).toBe("Raymund unpublished the post Hello, which was at /blog/hello.");
    expect(say("entry.trashed", { type: "page", title: "About us", path: "/about-us", below: 2 })).toBe("Raymund moved the page About us to the trash, with 2 pages below it.");
    expect(say("entry.trashed", { type: "post", title: "Hello", path: "/blog/hello", below: 0 })).toBe("Raymund moved the post Hello to the trash.");
    expect(say("entry.restored", { type: "page", title: "About us", path: "/about-us", below: 1 })).toBe(
      "Raymund restored the page About us from the trash, at /about-us, with 1 page below it.",
    );
    expect(say("entry.deleted", { type: "post", title: "Hello", path: "/blog/hello", below: 0 })).toBe("Raymund deleted the post Hello for good.");
    // M7-2: scheduling, and what Forge's own jobs do (the actor's name is the system actor's label).
    expect(say("entry.scheduled", { type: "post", title: "Hello", path: "/blog/hello", runAt: "2026-10-20T01:30:00.000Z" })).toBe("Raymund scheduled the post Hello for 2026-10-20 01:30 UTC.");
    expect(say("entry.scheduled", { type: "post", title: "Hello", path: "/blog/hello", runAt: "2026-10-21T01:30:00.000Z", previousRunAt: "2026-10-20T01:30:00.000Z" })).toBe(
      "Raymund moved the schedule of the post Hello to 2026-10-21 01:30 UTC.",
    );
    expect(say("entry.schedule_canceled", { type: "post", title: "Hello", path: "/blog/hello", runAt: "2026-10-20T01:30:00.000Z" })).toBe(
      "Raymund canceled the schedule of the post Hello (it was for 2026-10-20 01:30 UTC).",
    );
    expect(describeEvent({ action: "entry.published", actorName: "Forge (scheduled publishing)", metadata: { type: "post", title: "Hello", path: "/blog/hello", revision: 2, scheduled: true } })).toBe(
      "Forge (scheduled publishing) published the post Hello at /blog/hello, as scheduled.",
    );
    expect(
      describeEvent({ action: "entry.schedule_failed", actorName: "Forge (scheduled publishing)", metadata: { type: "page", title: "About", path: "/about", runAt: "2026-10-20T01:30:00.000Z", reason: "The address /about is already used by another page or post." } }),
    ).toBe("Forge (scheduled publishing) could not publish the page About as scheduled for 2026-10-20 01:30 UTC: The address /about is already used by another page or post. It is a draft again.");
    // M7-3: the history. Changes to the draft, and said as such.
    expect(say("entry.revision_restored", { type: "post", title: "Rye", path: "/blog/rye", revision: 3 })).toBe("Raymund restored revision 3 of the post Rye into its draft.");
    expect(say("entry.draft_replaced", { type: "page", title: "About", path: "/about", keptRevision: 7 })).toBe(
      "Raymund overwrote the draft of the page About; the version it replaced is revision 7.",
    );
    expect(describeEvent({ action: "entry.deleted", actorName: "Forge (trash cleanup)", metadata: { type: "page", title: "Old", path: "/old", below: 1, afterDays: 30 } })).toBe(
      "Forge (trash cleanup) deleted the page Old for good, with 1 page below it, 30 days after it went to the trash.",
    );
    // M8-1: the appearance settings, named by group.
    expect(say("site.settings_changed", { name: "Harbour Bakery", group: "appearance", fields: ["colors", "header"] })).toBe("Raymund changed the appearance settings of Harbour Bakery: colours, header.");
    expect(say("term.created", { taxonomy: "category", name: "Bread", slug: "bread" })).toBe("Raymund created the category Bread.");
    expect(say("term.updated", { taxonomy: "tag", name: "Sourdough", slug: "sourdough", fields: ["name", "slug"], previousName: "Rye", previousSlug: "rye" })).toBe(
      "Raymund renamed the tag Rye to Sourdough, with the slug sourdough instead of rye.",
    );
    expect(say("term.updated", { taxonomy: "category", name: "Bread", slug: "bread", fields: ["description", "parent"] })).toBe("Raymund changed the category Bread: description, parent.");
    expect(say("term.deleted", { taxonomy: "category", name: "Bread", slug: "bread", posts: 1, drafts: 0 })).toBe("Raymund deleted the category Bread, which was on 1 published post and 0 drafts.");
    // M8-3: a menu, by its place and how many links it holds now.
    expect(say("menu.updated", { name: "Acme Bakery", location: "header", items: 5 })).toBe("Raymund changed the header menu of Acme Bakery: 5 links.");
    expect(say("menu.updated", { name: "Acme Bakery", location: "footer", items: 1 })).toBe("Raymund changed the footer menu of Acme Bakery: 1 link.");
    expect(say("menu.updated", { name: "Acme Bakery", location: "footer", items: 0 })).toBe("Raymund changed the footer menu of Acme Bakery: no links.");
    expect(say("media.uploaded", { kind: "image", filename: "Team photo.jpg", sizeBytes: 1 })).toBe("Raymund uploaded the image Team photo.jpg.");
    expect(say("media.uploaded", { kind: "document", filename: "Menu.pdf", sizeBytes: 1 })).toBe("Raymund uploaded the PDF Menu.pdf.");
    expect(say("media.updated", { kind: "image", filename: "Team.jpg", fields: ["title", "alt"] })).toBe("Raymund changed the image Team.jpg: title, alternative text.");
    expect(say("media.moved", { kind: "document", filename: "Menu.pdf", folderName: "Menus" })).toBe("Raymund moved the PDF Menu.pdf to the folder Menus.");
    expect(say("media.moved", { kind: "image", filename: "Team.jpg", folderName: "People", previousFolderName: "Old" })).toBe("Raymund moved the image Team.jpg to the folder People, from Old.");
    expect(say("media.moved", { kind: "image", filename: "Team.jpg", previousFolderName: "Old" })).toBe("Raymund moved the image Team.jpg out of its folder.");
    expect(say("media.trashed", { kind: "image", filename: "Team.jpg" })).toBe("Raymund moved the image Team.jpg to the trash.");
    expect(say("media.restored", { kind: "image", filename: "Team.jpg" })).toBe("Raymund restored the image Team.jpg from the trash.");
    expect(say("media.folder_renamed", { name: "Events 2026", previousName: "Events" })).toBe("Raymund renamed the media folder Events to Events 2026.");
  });

  it.each(AUDIT_ACTIONS)("%s: a sentence, with a subject and a full stop, for its sample", (action) => {
    const sentence = say(action, SAMPLES[action]);
    expect(sentence).toMatch(/^Raymund .+\.$/);
    expect(sentence).not.toMatch(/undefined|null|\[object|NaN/);
  });

  it("an event whose stored details cannot be read is still told, without them", () => {
    for (const action of AUDIT_ACTIONS) {
      for (const damaged of [{}, null, "text", { unexpected: true }, []]) {
        const sentence = say(action, action === "member.left" && damaged !== null && typeof damaged === "object" ? { role: 7 } : damaged);
        expect(sentence, `${action} ${JSON.stringify(damaged)}`).toMatch(/^Raymund [a-z].+\.$/);
        expect(sentence).not.toMatch(/undefined|null|\[object/);
      }
    }
    expect(say("member.role_changed", {})).toBe("Raymund changed a member’s role.");
    expect(say("member.invited", { email: 5 })).toBe("Raymund invited someone.");
  });

  it("an event this code does not know is named, not hidden; an actor with no name is 'Someone'", () => {
    expect(say("entry.archived", { type: "post" })).toBe("Raymund did something Forge cannot describe yet (entry.archived).");
    expect(say("member.left", { role: "viewer" }, "")).toBe("Someone left the organization.");
    expect(say("member.left", { role: "viewer" }, "   ")).toBe("Someone left the organization.");
  });

  it("puts nothing in a sentence that the event's own details do not name", () => {
    const loud = { memberName: "Jane", previousRole: "author", newRole: "editor", token: "tok_secret", ip: "203.0.113.9", requestId: "req-1", organizationId: "0199a000-0000-7000-8000-00000000000a" };
    const sentence = say("member.role_changed", loud);
    for (const hidden of ["tok_secret", "203.0.113.9", "req-1", "0199a000"]) expect(sentence).not.toContain(hidden);
  });
});
